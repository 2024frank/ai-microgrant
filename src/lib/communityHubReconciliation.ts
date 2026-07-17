import pool from './db';
import {
  extractCommunityHubPost,
  moderationFromCommunityHubPost,
  normalizeCommunityHubPostId,
  type CommunityHubModeration,
} from './communityHubResponse';
import { isEventType } from './eventTypes';
import {
  reconcilePendingCommunityHubUpdates,
  type CommunityHubUpdateResult,
} from './communityHubUpdates';
import {
  recoverSucceededCommunityHubSubmissions,
  releaseStalePreparedCommunityHubSubmissions,
} from './communityHubSubmissions';

const CH_BASE = 'https://oberlin.communityhub.cloud/api/legacy/calendar';
const DEFAULT_LIMIT = 20;
// Six 30-second update replays plus twenty 30-second moderation/repair paths
// remain below the 240-second workflow timeout even at worst-case latency.
const MAX_LIMIT = 20;
const MAX_UPDATE_REPLAYS = 6;
const CONCURRENCY = 5;

type Candidate = {
  id: number;
  source_id: number;
  status: string;
  communityhub_post_id: string;
  event_type: string;
  title: string;
  description: string;
  extended_description: string | null;
  sponsors: unknown;
  post_type_ids: unknown;
  sessions: unknown;
  location_type: string;
  location: string | null;
  place_id: string | null;
  place_name: string | null;
  room_num: string | null;
  url_link: string | null;
  display: string;
  screen_ids: unknown;
  buttons: unknown;
  contact_email: string | null;
  phone: string | null;
  website: string | null;
  calendar_source_name: string | null;
  calendar_source_url: string | null;
  ingested_post_url: string | null;
};

export type ReconciliationItem = {
  event_id: number;
  communityhub_post_id: string;
  moderation: CommunityHubModeration | 'missing';
  repaired_event_type?: boolean;
  error?: string;
};

export type ReconciliationSummary = {
  checked: number;
  approved: number;
  pending: number;
  rejected: number;
  missing: number;
  unknown: number;
  repaired: number;
  submissions_recovered: number;
  prepared_released: number;
  unchecked: number;
  updates_checked: number;
  updates_succeeded: number;
  updates_ambiguous: number;
  updates_failed: number;
  failed: number;
  skipped_locked: boolean;
  results: ReconciliationItem[];
  update_results: CommunityHubUpdateResult[];
};

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error || 'unknown error')).slice(0, 500);
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

async function markState(
  candidate: Candidate,
  moderation: 'pending' | 'approved' | 'missing' | 'unknown',
  error: string | null = null,
) {
  const preserveApproved = candidate.status === 'approved' && moderation === 'unknown';
  const status = moderation === 'approved' || preserveApproved ? 'approved' : 'submitted';
  const storedModeration = preserveApproved ? 'approved' : moderation;
  await pool.query(
    `UPDATE raw_events
     SET status=?, communityhub_moderation_status=?,
         communityhub_checked_at=NOW(), communityhub_moderation_error=?,
         updated_at=CASE WHEN ?=? THEN updated_at ELSE NOW() END
     WHERE id=? AND status=?`,
    [
      status,
      storedModeration,
      error,
      status,
      candidate.status,
      candidate.id,
      candidate.status,
    ],
  );
}

function rejectionDetails(post: Record<string, any>, postId: string) {
  const rejections = Array.isArray(post.rejections) ? post.rejections : [];
  const ids = rejections
    .map(item => normalizeCommunityHubPostId(item?.id))
    .filter((value): value is string => Boolean(value));
  const reasons = rejections
    .map(item => typeof item?.reason === 'string' ? item.reason.trim() : '')
    .filter(Boolean);
  return {
    key: `communityhub:${postId}:${ids.join(',') || 'rejected'}`.slice(0, 190),
    note: (reasons.join(' · ') || 'CommunityHub rejected this submission without providing a reason.').slice(0, 2000),
  };
}

async function markRejected(candidate: Candidate, post: Record<string, any>) {
  const conn = await pool.getConnection();
  const postId = String(candidate.communityhub_post_id);
  const details = rejectionDetails(post, postId);
  try {
    await (conn as any).beginTransaction();
    const [[current]] = await conn.query(
      `SELECT id, status FROM raw_events WHERE id=? LIMIT 1 FOR UPDATE`,
      [candidate.id],
    ) as any;
    if (!current || current.status !== candidate.status) {
      await (conn as any).rollback();
      return;
    }
    await conn.query(
      `UPDATE raw_events
       SET status='rejected', sent_for_correction=0,
           communityhub_moderation_status='rejected',
           communityhub_checked_at=NOW(), communityhub_moderation_error=NULL
       WHERE id=? AND status=?`,
      [candidate.id, candidate.status],
    );
    await conn.query(
      `INSERT IGNORE INTO rejection_log
       (raw_event_id, source_id, reviewer_id, reason_codes, reviewer_note,
        event_title, event_snapshot, rejection_origin, external_rejection_key)
       VALUES (?,?,NULL,?,?,?,?, 'communityhub', ?)`,
      [
        candidate.id,
        candidate.source_id,
        JSON.stringify(['communityhub_rejected']),
        details.note,
        candidate.title,
        JSON.stringify(candidate),
        details.key,
      ],
    );
    await conn.query(
      `INSERT INTO notifications (user_id, type, title, message, raw_event_id)
       SELECT DISTINCT u.id, 'communityhub_rejected', ?, ?, ?
       FROM users u
       LEFT JOIN reviewer_sources rs
         ON rs.reviewer_id=u.id AND rs.source_id=?
       WHERE u.active=1
         AND (u.role='admin' OR u.can_review_all_sources=1 OR rs.source_id IS NOT NULL)`,
      [
        `CommunityHub rejected: ${candidate.title}`.slice(0, 255),
        details.note,
        candidate.id,
        candidate.source_id,
      ],
    );
    await (conn as any).commit();
  } catch (error) {
    await (conn as any).rollback().catch(() => undefined);
    throw error;
  } finally {
    (conn as any).release();
  }
}

async function repairLegacyEventType(candidate: Candidate, post: Record<string, any>): Promise<boolean> {
  const remoteType = typeof post.eventType === 'string' ? post.eventType : '';
  if (isEventType(remoteType) || !isEventType(candidate.event_type)) return false;
  const response = await fetch(
    `${CH_BASE}/post/${encodeURIComponent(candidate.communityhub_post_id)}/submit`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventType: candidate.event_type }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    const body = await readJson(response);
    throw new Error(`CommunityHub repair returned ${response.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return true;
}

async function reconcileOne(candidate: Candidate): Promise<ReconciliationItem> {
  const postId = String(candidate.communityhub_post_id);
  let response: Response;
  try {
    response = await fetch(`${CH_BASE}/post/${encodeURIComponent(postId)}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const message = safeError(error);
    await markState(candidate, 'unknown', message);
    return { event_id: candidate.id, communityhub_post_id: postId, moderation: 'unknown', error: message };
  }

  if (response.status === 404 || response.status === 410) {
    await markState(candidate, 'missing', `CommunityHub returned ${response.status} for this post id`);
    return { event_id: candidate.id, communityhub_post_id: postId, moderation: 'missing' };
  }
  if (!response.ok) {
    const body = await readJson(response);
    const message = `CommunityHub returned ${response.status}: ${JSON.stringify(body).slice(0, 300)}`;
    await markState(candidate, 'unknown', message);
    return { event_id: candidate.id, communityhub_post_id: postId, moderation: 'unknown', error: message };
  }

  const body = await readJson(response);
  const post = extractCommunityHubPost(body);
  const returnedId = normalizeCommunityHubPostId(post?.id);
  if (!post || returnedId !== postId) {
    const message = 'CommunityHub returned an invalid or mismatched post payload';
    await markState(candidate, 'unknown', message);
    return { event_id: candidate.id, communityhub_post_id: postId, moderation: 'unknown', error: message };
  }

  const moderation = moderationFromCommunityHubPost(post);
  if (moderation === 'approved') {
    await markState(candidate, 'approved');
    return { event_id: candidate.id, communityhub_post_id: postId, moderation };
  }
  if (moderation === 'rejected') {
    await markRejected(candidate, post);
    return { event_id: candidate.id, communityhub_post_id: postId, moderation };
  }
  if (moderation === 'pending') {
    let repaired = false;
    try {
      repaired = await repairLegacyEventType(candidate, post);
      await markState(candidate, 'pending');
      return {
        event_id: candidate.id,
        communityhub_post_id: postId,
        moderation,
        ...(repaired ? { repaired_event_type: true } : {}),
      };
    } catch (error) {
      const message = safeError(error);
      await markState(candidate, 'pending', message);
      return { event_id: candidate.id, communityhub_post_id: postId, moderation, error: message };
    }
  }

  const message = 'CommunityHub response did not include a valid moderation state';
  await markState(candidate, 'unknown', message);
  return { event_id: candidate.id, communityhub_post_id: postId, moderation: 'unknown', error: message };
}

export async function reconcileCommunityHub(options: { limit?: number; force?: boolean } = {}): Promise<ReconciliationSummary> {
  const requested = Number.isFinite(options.limit) ? Math.trunc(options.limit!) : DEFAULT_LIMIT;
  const limit = Math.min(Math.max(requested, 1), MAX_LIMIT);
  const lockConn = await pool.getConnection();
  let locked = false;
  try {
    const [[lock]] = await lockConn.query(
      `SELECT GET_LOCK('communityhub-moderation-reconcile', 0) AS acquired`,
    ) as any;
    locked = lock?.acquired === 1 || lock?.acquired === '1' || lock?.acquired === true;
    if (!locked) {
      return {
        checked: 0, approved: 0, pending: 0, rejected: 0, missing: 0,
        unknown: 0, repaired: 0, submissions_recovered: 0,
        prepared_released: 0, unchecked: 0,
        updates_checked: 0, updates_succeeded: 0,
        updates_ambiguous: 0, updates_failed: 0, failed: 0,
        skipped_locked: true, results: [], update_results: [],
      };
    }

    // Existing rows predate the tri-state moderation columns. Do this data
    // backfill only after the new application is running; public reads already
    // require verified moderation, so a failed pre-promotion migration cannot
    // hide the feed from the old application.
    await lockConn.query(
      `UPDATE raw_events
       SET status='submitted', communityhub_checked_at=NULL,
           communityhub_moderation_error=NULL
       WHERE status IN ('approved','resubmitted')
         AND communityhub_post_id IS NOT NULL
         AND communityhub_moderation_status='unknown'`,
    );

    const preparedReleased = await releaseStalePreparedCommunityHubSubmissions(limit);

    // A POST can succeed remotely just before the process loses its local DB
    // connection. Finish those durable successes without issuing another POST.
    const submissionsRecovered = await recoverSucceededCommunityHubSubmissions(limit);

    // Replay a bounded number of idempotent PATCH operations before reading moderation. Candidate
    // polling below excludes any edit whose local finalization is unresolved.
    const updateResults = await reconcilePendingCommunityHubUpdates(Math.min(limit, MAX_UPDATE_REPLAYS));

    const freshness = options.force
      ? ''
      : `AND (communityhub_checked_at IS NULL
              OR communityhub_checked_at < DATE_SUB(NOW(), INTERVAL 15 MINUTE))`;
    // Reserve part of every run for already-published posts. Otherwise a
    // steady stream of new submissions could indefinitely hide a later remote
    // rejection or deletion from this worker.
    const approvedQuota = limit === 1 ? 1 : Math.max(1, Math.floor(limit / 4));
    const [approvedRows] = await lockConn.query(
      `SELECT id, source_id, status, communityhub_post_id, event_type, title,
              description, extended_description, sponsors, post_type_ids,
              sessions, location_type, location, place_id, place_name,
              room_num, url_link, display, screen_ids, buttons, contact_email,
              phone, website, calendar_source_name, calendar_source_url,
              ingested_post_url
       FROM raw_events
       WHERE status='approved' AND communityhub_moderation_status='approved'
         AND communityhub_post_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM communityhub_updates cu
           WHERE cu.raw_event_id=raw_events.id
             AND cu.status IN ('sending','ambiguous')
         )
         ${freshness}
       ORDER BY communityhub_checked_at IS NULL DESC, communityhub_checked_at ASC, id ASC
       LIMIT ?`,
      [approvedQuota],
    ) as any;
    const approvedCandidates = Array.isArray(approvedRows) ? approvedRows as Candidate[] : [];
    const submittedLimit = limit - approvedCandidates.length;
    let submittedCandidates: Candidate[] = [];
    if (submittedLimit > 0) {
      const [submittedRows] = await lockConn.query(
        `SELECT id, source_id, status, communityhub_post_id, event_type, title,
                description, extended_description, sponsors, post_type_ids,
                sessions, location_type, location, place_id, place_name,
                room_num, url_link, display, screen_ids, buttons, contact_email,
                phone, website, calendar_source_name, calendar_source_url,
                ingested_post_url
         FROM raw_events
         WHERE status='submitted' AND communityhub_post_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM communityhub_updates cu
             WHERE cu.raw_event_id=raw_events.id
               AND cu.status IN ('sending','ambiguous')
           )
           ${freshness}
         ORDER BY communityhub_checked_at IS NULL DESC, communityhub_checked_at ASC, id ASC
         LIMIT ?`,
        [submittedLimit],
      ) as any;
      submittedCandidates = Array.isArray(submittedRows) ? submittedRows as Candidate[] : [];
    }
    const candidates = [...submittedCandidates, ...approvedCandidates];
    const results: ReconciliationItem[] = [];
    for (let index = 0; index < candidates.length; index += CONCURRENCY) {
      results.push(...await Promise.all(candidates.slice(index, index + CONCURRENCY).map(reconcileOne)));
    }
    const moderationFailures = results.filter(item => item.error).length;
    const updateFailures = updateResults.filter(item => item.status !== 'succeeded').length;
    const [[backlog]] = await lockConn.query(
      `SELECT COUNT(*) AS unchecked
       FROM raw_events
       WHERE status IN ('submitted','approved')
         AND communityhub_post_id IS NOT NULL
         AND communityhub_checked_at IS NULL`,
    ) as any;
    return {
      checked: results.length,
      approved: results.filter(item => item.moderation === 'approved').length,
      pending: results.filter(item => item.moderation === 'pending').length,
      rejected: results.filter(item => item.moderation === 'rejected').length,
      missing: results.filter(item => item.moderation === 'missing').length,
      unknown: results.filter(item => item.moderation === 'unknown').length,
      repaired: results.filter(item => item.repaired_event_type).length,
      submissions_recovered: submissionsRecovered,
      prepared_released: preparedReleased,
      unchecked: Number(backlog?.unchecked || 0),
      updates_checked: updateResults.length,
      updates_succeeded: updateResults.filter(item => item.status === 'succeeded').length,
      updates_ambiguous: updateResults.filter(item => item.status === 'ambiguous').length,
      updates_failed: updateResults.filter(item => item.status === 'failed').length,
      failed: moderationFailures + updateFailures,
      skipped_locked: false,
      results,
      update_results: updateResults,
    };
  } finally {
    if (locked) {
      await lockConn.query(`SELECT RELEASE_LOCK('communityhub-moderation-reconcile')`).catch(() => undefined);
    }
    (lockConn as any).release();
  }
}
