import { after, NextRequest } from 'next/server';
import pool from '@/lib/db';
import { sendReviewNotification } from '@/lib/email';
import { persistExtractedEvents } from '@/lib/eventIngestion';

export const maxDuration = 60;

const MAX_EVENTS_PER_INGEST = 200;

function isDuplicateEntry(error: any): boolean {
  return error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062;
}

async function bestEffortQuery(sql: string, params: unknown[]): Promise<void> {
  try {
    await pool.query(sql, params);
  } catch {
    // Do not hide the ingestion error behind a secondary status-write failure.
  }
}

type NotificationRecipient = {
  id: number;
  email: string;
  full_name: string;
  role: 'admin' | 'reviewer';
};

type InsertedEventPreview = {
  title: string;
};

function formatOldestDate(value: unknown): string | null {
  if (!value) return null;
  const date = new Date(value as string | number | Date);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function sendScopedReviewNotifications(
  source: { id: number; name: string },
  insertedEvents: InsertedEventPreview[],
): Promise<void> {
  // A reviewer only receives titles from a source explicitly assigned to them.
  // Admins are global by role and may receive every source.
  const [recipientRows] = await pool.query(
    `SELECT DISTINCT u.id, u.email, u.full_name, u.role
     FROM users u
     LEFT JOIN reviewer_sources target
       ON target.reviewer_id = u.id AND target.source_id = ?
     WHERE u.active = 1
       AND u.email IS NOT NULL
       AND (
         u.role = 'admin'
         OR (
           u.role = 'reviewer'
           AND (u.can_review_all_sources=1 OR target.source_id IS NOT NULL)
         )
       )`,
    [source.id],
  ) as any;
  const recipients = Array.isArray(recipientRows)
    ? recipientRows as NotificationRecipient[]
    : [];
  const previewEvents = insertedEvents.slice(0, 5).map(event => ({
    title: event.title,
    source: source.name,
  }));

  await Promise.all(recipients.map(async recipient => {
    try {
      const reviewerScope = recipient.role === 'reviewer'
        ? `AND EXISTS (
            SELECT 1 FROM users scoped_user
            WHERE scoped_user.id=?
              AND (
                scoped_user.can_review_all_sources=1
                OR EXISTS (
                  SELECT 1 FROM reviewer_sources rs
                  WHERE rs.reviewer_id=scoped_user.id AND rs.source_id=re.source_id
                )
              )
          )`
        : '';
      const params = recipient.role === 'reviewer'
        ? [source.id, recipient.id]
        : [source.id];
      const [[stats]] = await pool.query(
        `SELECT COUNT(*) AS pending,
                SUM(re.source_id = ?) AS source_pending,
                MIN(re.created_at) AS oldest_created_at
         FROM raw_events re
         WHERE re.status = 'pending' ${reviewerScope}`,
        params,
      ) as any;

      await sendReviewNotification({
        reviewerEmail: recipient.email,
        reviewerName: recipient.full_name,
        pendingCount: Number(stats?.pending ?? 0),
        sources: [{
          name: source.name,
          count: insertedEvents.length,
          pending: Number(stats?.source_pending ?? insertedEvents.length),
        }],
        oldestDate: formatOldestDate(stats?.oldest_created_at),
        previewEvents,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      console.error(`[ingest] email failed for ${recipient.email}:`, message);
    }
  }));
}

async function claimIngestRun(sourceId: number, eventCount: number) {
  const findRunning = async () => {
    const [[run]] = await pool.query(
      `SELECT id, correction_event_id FROM agent_runs
       WHERE source_id=? AND status='running'
       ORDER BY id DESC LIMIT 1`,
      [sourceId],
    ) as any;
    return run?.id ? {
      runId: Number(run.id),
      expectedCorrectionEventId: run.correction_event_id == null
        ? undefined
        : Number(run.correction_event_id),
    } : null;
  };

  const existingRun = await findRunning();
  if (existingRun) return { ...existingRun, reused: true };

  try {
    const [runRes] = await pool.query(
      `INSERT INTO agent_runs (source_id, status, started_at, events_found)
       VALUES (?, 'running', NOW(), ?)`,
      [sourceId, eventCount],
    ) as any;
    return {
      runId: Number(runRes.insertId),
      expectedCorrectionEventId: undefined,
      reused: false,
    };
  } catch (error) {
    // A scheduled trigger may have claimed the source between SELECT and
    // INSERT. The database lease is authoritative; attach to that run.
    if (!isDuplicateEntry(error)) throw error;
    const racedRun = await findRunning();
    if (!racedRun) throw error;
    return { ...racedRun, reused: true };
  }
}

/**
 * POST /api/ingest/:slug
 *
 * Requires x-ingest-secret header matching INGEST_SECRET env var.
 *
 * Body: { events: Event[], count?: number }
 * Response: { ok: true, run_id: number, inserted: number }
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ slug: string }> }
) {
  // ── auth ──────────────────────────────────────────────────────────
  const configuredSecret = process.env.INGEST_SECRET?.trim();
  const secret = req.headers.get('x-ingest-secret');
  if (!configuredSecret || !secret || secret !== configuredSecret) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { slug } = await context.params;

  // Look up source by slug — don't reveal which slug failed
  const [[source]] = await pool.query(
    'SELECT * FROM sources WHERE slug = ? AND active = 1', [slug]
  ) as any;
  if (!source) return Response.json({ error: 'Not found' }, { status: 404 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const events: any[] = Array.isArray(body.events) ? body.events : [];
  const agentCount: number = body.count ?? events.length;

  // ── payload size guard ────────────────────────────────────────────
  if (events.length > MAX_EVENTS_PER_INGEST) {
    return Response.json(
      { error: `Too many events — max ${MAX_EVENTS_PER_INGEST} per request` },
      { status: 422 }
    );
  }
  if (events.some(event => (
    event !== null
    && typeof event === 'object'
    && Object.hasOwn(event, 'fixedFromEventId')
  ))) {
    return Response.json(
      { error: 'Correction output must return through its managed agent run' },
      { status: 409 },
    );
  }

  // Agents invoked by the scheduler may POST their result here while their
  // lease is still running. Reuse that run instead of trying to create a
  // second running row for the same source.
  const {
    runId,
    reused: reusedRun,
    expectedCorrectionEventId,
  } = await claimIngestRun(source.id, agentCount);

  // Correction agents return JSON to agentRunner, which carries a run-scoped
  // lease into the persistence transaction. The shared ingest secret is not a
  // safe identity for attaching a late direct POST to a correction retry.
  if (expectedCorrectionEventId !== undefined) {
    return Response.json(
      {
        error: 'Direct posting is disabled while a correction run is active',
        run_id: runId,
      },
      { status: 409 },
    );
  }

  if (events.length === 0) {
    await pool.query(
      `UPDATE agent_runs SET status='completed', finished_at=NOW(),
       events_found=0, events_extracted=0
       WHERE id=? AND status='running'`,
      [runId],
    );
    return Response.json({
      ok: true,
      run_id: runId,
      inserted: 0,
      reused_run: reusedRun,
      message: 'No events in payload',
    });
  }

  // Every item is normalized against the same contract used at publication.
  // One malformed item cannot roll back valid siblings; fixable drafts carry
  // their field-level issues into the reviewer queue.
  let result;
  try {
    result = await persistExtractedEvents(events, source, runId, {
      expectedCorrectionEventId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Ingestion failed';
    if (reusedRun) {
      await bestEffortQuery(
        `UPDATE agent_runs SET events_errored=events_errored+1, error_log=?
         WHERE id=? AND status='running'`,
        [JSON.stringify([message]), runId],
      );
    } else {
      await bestEffortQuery(
        `UPDATE agent_runs SET status='failed', finished_at=NOW(),
         events_errored=events_errored+1, error_log=? WHERE id=?`,
        [JSON.stringify([message]), runId],
      );
    }
    return Response.json({ error: 'Unable to persist extracted events' }, { status: 500 });
  }
  const inserted = result.inserted.length;
  const skipped = result.skipped;

  if (reusedRun) {
    // The parent agentRunner owns the lease and will close it when the managed
    // session becomes idle. Preserve the direct-post counts in the meantime.
    await pool.query(
      `UPDATE agent_runs SET
       events_found=GREATEST(events_found, ?),
       events_extracted=events_extracted+?,
       events_skipped_dup=events_skipped_dup+?,
       events_errored=events_errored+?, error_log=?
       WHERE id=? AND status='running'`,
      [
        agentCount,
        inserted,
        result.duplicates,
        result.invalid,
        result.errors.length ? JSON.stringify(result.errors) : null,
        runId,
      ],
    );
  } else {
    await pool.query(
      `UPDATE agent_runs SET status='completed', finished_at=NOW(),
       events_found=?, events_extracted=?, events_skipped_dup=?,
       events_errored=?, error_log=? WHERE id=?`,
      [
        agentCount,
        inserted,
        result.duplicates,
        result.invalid,
        result.errors.length ? JSON.stringify(result.errors) : null,
        runId,
      ],
    );
  }

  // Email authorized reviewers after the response. `after` registers the work
  // with Next/Vercel's request lifecycle so serverless execution stays alive.
  // Fixed events keep their dedicated per-reviewer bell notification flow.
  if (inserted > 0 && source.slug !== 'fixed-events') {
    after(() => sendScopedReviewNotifications(source, result.inserted));
  }

  console.log(`[ingest] source=${source.name} slug=${slug} run=${runId} inserted=${inserted}`);

  return Response.json({
    ok:             true,
    run_id:         runId,
    source:         source.name,
    inserted,
    skipped,
    needs_review: result.invalid,
    validation_errors: result.errors,
    pending_review: inserted,
    message:        `${inserted} events queued for review`,
  });
}

// Allow CORS so agents can POST from anywhere
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Ingest-Secret',
    },
  });
}
