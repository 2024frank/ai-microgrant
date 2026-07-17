import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { forbidden, getAuthUser, unauthorized } from '@/lib/auth';
import {
  extractCommunityHubPost,
  extractCommunityHubPostId,
  normalizeCommunityHubPostId,
} from '@/lib/communityHubResponse';

const CH_BASE = 'https://oberlin.communityhub.cloud/api/legacy/calendar';

function parseId(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function linkedEventId(urlValue: unknown): number | null {
  if (typeof urlValue !== 'string') return null;
  try {
    const match = new URL(urlValue).pathname.match(/^\/(?:reviewer\/)?events\/(\d+)\/?$/);
    if (!match) return null;
    const eventId = Number(match[1]);
    return Number.isSafeInteger(eventId) && eventId > 0 ? eventId : null;
  } catch {
    return null;
  }
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();
  const { id: rawId } = await context.params;
  const submissionId = parseId(rawId);
  if (!submissionId) return Response.json({ error: 'Invalid submission id' }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    const candidate = await req.json();
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error();
    body = candidate;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const postId = normalizeCommunityHubPostId(body.communityhub_post_id);
  if (!postId) {
    return Response.json({ error: 'A valid communityhub_post_id is required' }, { status: 400 });
  }

  const [[submission]] = await pool.query(
    `SELECT cs.id, cs.raw_event_id, cs.status, re.title
     FROM communityhub_submissions cs
     JOIN raw_events re ON re.id=cs.raw_event_id
     WHERE cs.id=?`,
    [submissionId],
  ) as any;
  if (!submission) return Response.json({ error: 'Not found' }, { status: 404 });
  if (!['sending', 'accepted_unreconciled'].includes(submission.status)) {
    return Response.json({ error: 'Submission is not awaiting reconciliation' }, { status: 409 });
  }

  let response: Response;
  try {
    response = await fetch(`${CH_BASE}/post/${encodeURIComponent(postId)}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return Response.json({ error: 'CommunityHub lookup failed; no state was changed' }, { status: 502 });
  }
  if (!response.ok) {
    return Response.json({
      error: `CommunityHub lookup returned ${response.status}; no state was changed`,
    }, { status: 502 });
  }
  const text = await response.text();
  let communityHub: unknown;
  try {
    communityHub = JSON.parse(text);
  } catch {
    return Response.json({ error: 'CommunityHub returned invalid JSON; no state was changed' }, { status: 502 });
  }
  const post = extractCommunityHubPost(communityHub);
  if (extractCommunityHubPostId(communityHub) !== postId) {
    return Response.json({ error: 'CommunityHub returned a mismatched post id' }, { status: 409 });
  }
  if (linkedEventId(post?.ingestedPostUrl) !== Number(submission.raw_event_id)) {
    return Response.json({
      error: 'That CommunityHub post is not linked to this intake record',
    }, { status: 409 });
  }

  const conn = await pool.getConnection();
  try {
    await (conn as any).beginTransaction();
    const [[locked]] = await conn.query(
      `SELECT cs.status, re.status AS event_status,
              re.communityhub_post_id AS current_post_id
       FROM communityhub_submissions cs
       JOIN raw_events re ON re.id=cs.raw_event_id
       WHERE cs.id=? LIMIT 1 FOR UPDATE`,
      [submissionId],
    ) as any;
    if (!locked || !['sending', 'accepted_unreconciled'].includes(locked.status)) {
      await (conn as any).rollback();
      return Response.json({ error: 'Submission was already reconciled' }, { status: 409 });
    }

    const currentPostId = normalizeCommunityHubPostId(locked.current_post_id);
    const alreadyLinked = locked.event_status === 'submitted' && currentPostId === postId;
    if (locked.event_status !== 'publishing' && !alreadyLinked) {
      await (conn as any).rollback();
      return Response.json({
        error: 'The intake record is no longer awaiting this submission',
      }, { status: 409 });
    }

    if (!alreadyLinked) {
      const [updatedEvent] = await conn.query(
        `UPDATE raw_events
         SET status='submitted', communityhub_post_id=?, publish_started_at=NULL,
             communityhub_moderation_status='unknown', communityhub_checked_at=NULL,
             communityhub_moderation_error=NULL
         WHERE id=? AND status='publishing'`,
        [postId, submission.raw_event_id],
      ) as any;
      if (Number(updatedEvent?.affectedRows || 0) !== 1) {
        await (conn as any).rollback();
        return Response.json({
          error: 'The intake record changed during reconciliation',
        }, { status: 409 });
      }
    }
    await conn.query(
      `UPDATE communityhub_submissions
       SET status='succeeded', response=?, communityhub_post_id=?, error_message=NULL
       WHERE id=?`,
      [JSON.stringify(communityHub), postId, submissionId],
    );
    await (conn as any).commit();
  } catch (error) {
    await (conn as any).rollback().catch(() => undefined);
    console.error(`[communityhub reconcile] submission ${submissionId} failed:`, error);
    return Response.json({ error: 'Unable to finalize reconciliation' }, { status: 500 });
  } finally {
    (conn as any).release();
  }

  return Response.json({
    ok: true,
    status: 'submitted',
    moderation_status: 'unknown',
    communityhub_post_id: postId,
    message: 'Submission linked. Moderation reconciliation will run next.',
  });
}

/**
 * Last-resort operator release for an ambiguous `sending` row. This is never
 * automatic: the admin must first verify in CommunityHub that no post exists,
 * wait for the remote system to settle, and provide the exact confirmation.
 */
export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();
  const { id: rawId } = await context.params;
  const submissionId = parseId(rawId);
  if (!submissionId) return Response.json({ error: 'Invalid submission id' }, { status: 400 });

  let confirmation = '';
  try {
    const body = await req.json();
    confirmation = typeof body?.confirmation === 'string' ? body.confirmation : '';
  } catch {
    // The exact confirmation below remains required.
  }
  if (confirmation !== 'NO_COMMUNITYHUB_POST_EXISTS') {
    return Response.json({
      error: 'Verify CommunityHub first, then confirm with NO_COMMUNITYHUB_POST_EXISTS',
    }, { status: 400 });
  }

  const conn = await pool.getConnection();
  try {
    await (conn as any).beginTransaction();
    const [[locked]] = await conn.query(
      `SELECT cs.status, cs.raw_event_id,
              TIMESTAMPDIFF(SECOND, cs.updated_at, NOW()) AS age_seconds,
              re.status AS event_status
       FROM communityhub_submissions cs
       JOIN raw_events re ON re.id=cs.raw_event_id
       WHERE cs.id=? LIMIT 1 FOR UPDATE`,
      [submissionId],
    ) as any;
    if (!locked) {
      await (conn as any).rollback();
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    if (locked.status !== 'sending' || locked.event_status !== 'publishing') {
      await (conn as any).rollback();
      return Response.json({
        error: 'Only an unresolved sending submission can be released',
      }, { status: 409 });
    }
    if (Number(locked.age_seconds || 0) < 600) {
      await (conn as any).rollback();
      return Response.json({
        error: 'Wait at least 10 minutes before declaring that no CommunityHub post exists',
      }, { status: 409 });
    }

    const reason = `Manually released by ${user.email} after external no-post verification`;
    await conn.query(
      `UPDATE communityhub_submissions
       SET status='failed', error_message=?
       WHERE id=? AND status='sending'`,
      [reason, submissionId],
    );
    const [released] = await conn.query(
      `UPDATE raw_events SET status='pending', publish_started_at=NULL
       WHERE id=? AND status='publishing'`,
      [locked.raw_event_id],
    ) as any;
    if (Number(released?.affectedRows || 0) !== 1) {
      throw new Error('Submission no longer owns the publishing event');
    }
    await (conn as any).commit();
    return Response.json({ ok: true, safe_to_retry: true, status: 'pending' });
  } catch (error) {
    await (conn as any).rollback().catch(() => undefined);
    console.error(`[communityhub reconcile] submission ${submissionId} release failed:`, error);
    return Response.json({ error: 'Unable to release submission' }, { status: 500 });
  } finally {
    (conn as any).release();
  }
}
