import { after, NextRequest } from 'next/server';
import pool from '@/lib/db';
import { correctionPrompt } from '@/lib/correctionRuns';
import { cronUnavailable, isCronAuthorized } from '@/lib/cronAuth';
import { enqueueAgentContinuation } from '@/lib/agentContinuation';

export const maxDuration = 300;

/**
 * Automatic correction dispatch, run by the scheduler.
 *
 * Two candidate classes route through the existing correction workflow (a
 * needs_fix entry plus a correction agent run whose output must reference
 * the original via fixedFromEventId, so a retry can never create a
 * duplicate event):
 *  - required-field rejections (2026-07-16 meeting, item 12): drafts
 *    ingestion rejected as "Required fields are missing"
 *    (rejection_origin='system') with the reason preserved;
 *  - imageless drafts: the contract requires the event's image, and the
 *    deterministic page scan already tried and failed
 *    (image_discovery_at set, still no poster), so the agent is sent to
 *    find the event's real image from the source's official channels.
 * One automatic attempt per event; a failed correction returns the event to
 * its prior queue state for a human.
 */
// One correction per source runs at a time (agent_runs enforces it), so the
// real throttle is one dispatch per source per tick; the cap lets every
// source get covered in a single tick rather than draining two at a time.
const MAX_DISPATCH_PER_INVOCATION = 12;
const MAX_EVENT_AGE_DAYS = 7;

type CorrectionKind = 'missing_fields' | 'missing_image';
type CandidateRow = Record<string, any> & { correction_kind: CorrectionKind };

function isDuplicateEntry(error: any): boolean {
  return error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062;
}

async function bestEffortQuery(sql: string, params: unknown[]): Promise<void> {
  try {
    await pool.query(sql, params);
  } catch {
    // The dispatch summary remains the response of record.
  }
}

async function restoreFailedCorrection(eventId: number, runId: number, message: string) {
  await bestEffortQuery(
    `UPDATE agent_runs SET status='failed', finished_at=NOW(), error_log=?
     WHERE id=? AND status IN ('running','completed')`,
    [JSON.stringify([message]), runId],
  );
  await bestEffortQuery(
    `UPDATE raw_events SET status='rejected', sent_for_correction=0
     WHERE id=? AND status='rejected' AND sent_for_correction=1
       AND NOT EXISTS (
         SELECT 1 FROM agent_runs ar
         WHERE ar.correction_event_id=raw_events.id AND ar.status='running' AND ar.id<>?
       )`,
    [eventId, runId],
  );
  // An imageless-draft correction returns to the review queue on failure.
  await bestEffortQuery(
    `UPDATE raw_events SET status='pending', sent_for_correction=0
     WHERE id=? AND status='pending_fix'
       AND NOT EXISTS (
         SELECT 1 FROM agent_runs ar
         WHERE ar.correction_event_id=raw_events.id AND ar.status='running' AND ar.id<>?
       )`,
    [eventId, runId],
  );
  await bestEffortQuery('DELETE FROM needs_fix WHERE raw_event_id=?', [eventId]);
}

async function selectRejectedCandidates(): Promise<CandidateRow[]> {
  const [rows] = await pool.query(
    `SELECT re.*,
            latest_rejection.reason_codes AS rejection_reason_codes,
            latest_rejection.reviewer_note AS rejection_reviewer_note
     FROM raw_events re
     JOIN sources s ON s.id=re.source_id AND s.active=1
     JOIN rejection_log latest_rejection
       ON latest_rejection.id = (
         SELECT rl.id FROM rejection_log rl
         WHERE rl.raw_event_id = re.id
         ORDER BY rl.created_at DESC, rl.id DESC LIMIT 1
       )
     WHERE re.status='rejected'
       AND re.sent_for_correction=0
       AND re.superseded_by_id IS NULL
       AND re.corrected_from_id IS NULL
       AND re.created_at > DATE_SUB(NOW(), INTERVAL ${MAX_EVENT_AGE_DAYS} DAY)
       AND latest_rejection.rejection_origin='system'
       AND (
         JSON_CONTAINS(latest_rejection.reason_codes, '"missing_fields"')
         OR JSON_CONTAINS(latest_rejection.reason_codes, '"format_nonconforming"')
       )
       AND NOT EXISTS (SELECT 1 FROM needs_fix nf WHERE nf.raw_event_id=re.id)
       -- One automatic attempt per event, ever.
       AND NOT EXISTS (
         SELECT 1 FROM agent_runs prior WHERE prior.correction_event_id=re.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM agent_runs active
         WHERE active.source_id=re.source_id AND active.status='running'
       )
     ORDER BY re.created_at ASC`,
  ) as any;
  return (Array.isArray(rows) ? rows : [])
    .map(row => ({ ...row, correction_kind: 'missing_fields' as const }));
}

async function selectImagelessCandidates(): Promise<CandidateRow[]> {
  const [rows] = await pool.query(
    `SELECT re.*,
            NULL AS rejection_reason_codes,
            NULL AS rejection_reviewer_note
     FROM raw_events re
     JOIN sources s ON s.id=re.source_id AND s.active=1
     WHERE re.status='pending'
       AND COALESCE(re.sent_for_correction, 0)=0
       AND re.superseded_by_id IS NULL
       AND re.corrected_from_id IS NULL
       AND re.image_data IS NULL
       AND (re.image_cdn_url IS NULL OR re.image_cdn_url='')
       -- "If there is none": no image AND no explanation yet. An event whose
       -- agent already recorded why the image is missing needs no further
       -- hunt; this is also what stops a note-only correction from looping.
       AND JSON_EXTRACT(re.field_notes, '$.image_cdn_url') IS NULL
       -- The deterministic page scan already tried and found nothing.
       AND re.image_discovery_at IS NOT NULL
       AND re.created_at > DATE_SUB(NOW(), INTERVAL ${MAX_EVENT_AGE_DAYS} DAY)
       AND NOT EXISTS (SELECT 1 FROM needs_fix nf WHERE nf.raw_event_id=re.id)
       -- One automatic attempt per event, ever.
       AND NOT EXISTS (
         SELECT 1 FROM agent_runs prior WHERE prior.correction_event_id=re.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM agent_runs active
         WHERE active.source_id=re.source_id AND active.status='running'
       )
     ORDER BY re.created_at ASC`,
  ) as any;
  return (Array.isArray(rows) ? rows : [])
    .map(row => ({ ...row, correction_kind: 'missing_image' as const }));
}

async function selectCandidates(): Promise<CandidateRow[]> {
  const candidates = [
    ...await selectRejectedCandidates(),
    ...await selectImagelessCandidates(),
  ];
  // One correction per source per invocation (a source supports only one
  // active run at a time), rejections first, never the same event twice.
  const seenSources = new Set<number>();
  const seenEvents = new Set<number>();
  const selected: CandidateRow[] = [];
  for (const candidate of candidates) {
    const sourceId = Number(candidate.source_id);
    const eventId = Number(candidate.id);
    if (seenSources.has(sourceId) || seenEvents.has(eventId)) continue;
    seenSources.add(sourceId);
    seenEvents.add(eventId);
    selected.push(candidate);
    if (selected.length >= MAX_DISPATCH_PER_INVOCATION) break;
  }
  return selected;
}

async function dispatchOne(event: CandidateRow, origin: string): Promise<{
  event_id: number;
  kind: CorrectionKind;
  status: 'dispatched' | 'skipped' | 'error';
  run_id?: number;
  error?: string;
}> {
  const eventId = Number(event.id);
  const kind = event.correction_kind;
  let runId: number;
  try {
    const [runResult] = await pool.query(
      `INSERT INTO agent_runs (source_id, status, correction_event_id)
       VALUES (?, 'running', ?)`,
      [event.source_id, eventId],
    ) as any;
    runId = Number(runResult.insertId);
  } catch (error) {
    if (isDuplicateEntry(error)) {
      return { event_id: eventId, kind, status: 'skipped', error: 'source already has an active run' };
    }
    return {
      event_id: eventId,
      kind,
      status: 'error',
      error: error instanceof Error ? error.message : 'Unable to claim a correction run',
    };
  }

  const notes = event.correction_kind === 'missing_image'
    ? [
        'This event is missing its REQUIRED image (image_cdn_url), and the platform already scanned the event page section without finding one.',
        `Find the event's real image from the source's official channels: the event page itself (${String(event.calendar_source_url || 'no page recorded')}), the organization's website or its official social media post for this exact event, or the venue's official page for this exact event. Set image_cdn_url to that image's public HTTPS URL.`,
        'Never attach an unrelated or generic image and never fabricate one; if no official image for this event exists anywhere, leave image_cdn_url unset and set fieldNotes.image_cdn_url to one factual sentence saying so and naming which channels you checked.',
        'Keep every other field exactly as the source supports it.',
      ].join(' ')
    : [
        // The system rejection note leads with the exact problem class
        // ("Required fields are missing." or the format violation).
        String(event.rejection_reviewer_note || 'This extracted event does not satisfy the platform contract.').slice(0, 1500),
        'Re-read the original source and correct only what the note describes. Do not invent values the source does not state; if the source truly lacks a required fact, return the event without inventing it.',
      ].filter(Boolean).join(' ');

  const conn = await pool.getConnection();
  try {
    await (conn as any).beginTransaction();
    await conn.query(
      `INSERT INTO needs_fix
       (raw_event_id, source_id, correction_notes, sent_by_user_id, sent_by_email)
       VALUES (?, ?, ?, NULL, ?)
       ON DUPLICATE KEY UPDATE
         correction_notes=VALUES(correction_notes), created_at=CURRENT_TIMESTAMP`,
      [
        eventId,
        event.source_id,
        notes,
        event.correction_kind === 'missing_image' ? 'system@image-recovery' : 'system@required-fields',
      ],
    );
    const [claim] = event.correction_kind === 'missing_image'
      ? await conn.query(
          `UPDATE raw_events SET status='pending_fix', sent_for_correction=1, updated_at=NOW()
           WHERE id=? AND status='pending' AND COALESCE(sent_for_correction, 0)=0`,
          [eventId],
        ) as any
      : await conn.query(
          `UPDATE raw_events SET sent_for_correction=1, updated_at=NOW()
           WHERE id=? AND status='rejected' AND sent_for_correction=0`,
          [eventId],
        ) as any;
    if (!claim.affectedRows) throw new Error('Event is no longer available for correction');
    await conn.query(
      `INSERT INTO review_sessions
       (raw_event_id, reviewer_id, action, time_spent_sec, submitted_to_ch)
       VALUES (?, NULL, 'sent_for_correction', 0, 0)`,
      [eventId],
    );
    await (conn as any).commit();
  } catch (error) {
    await (conn as any).rollback().catch(() => undefined);
    await bestEffortQuery(
      `UPDATE agent_runs SET status='failed', finished_at=NOW(), error_log=? WHERE id=?`,
      [JSON.stringify([error instanceof Error ? error.message : 'Unable to queue correction']), runId],
    );
    return {
      event_id: eventId,
      kind,
      status: 'error',
      run_id: runId,
      error: error instanceof Error ? error.message : 'Unable to queue correction',
    };
  } finally {
    (conn as any).release();
  }

  const prompt = correctionPrompt(event, notes);
  after(async () => {
    try {
      const { triggerAgentRun } = await import('@/lib/agentRunner');
      const result = await triggerAgentRun(
        Number(event.source_id),
        runId,
        process.env.ANTHROPIC_API_KEY ?? '',
        process.env.SOURCE_BUILDER_ENVIRONMENT_ID ?? '',
        prompt,
        { expectedCorrectionEventId: eventId },
      );
      if (result.pending) {
        await enqueueAgentContinuation(origin, [runId]).catch(error => {
          console.error(`[system-corrections] could not enqueue continuation for run=${runId}:`, error);
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Correction agent failed';
      console.error(`[system-corrections] run=${runId} failed:`, message);
      await restoreFailedCorrection(eventId, runId, message);
    }
  });

  return { event_id: eventId, kind, status: 'dispatched', run_id: runId };
}

async function handle(req: NextRequest) {
  if (cronUnavailable()) {
    return Response.json({ error: 'CRON_SECRET is not configured' }, { status: 503 });
  }
  // isCronAuthorized covers both the Bearer form and the x-cron-secret header
  // with a timing-safe comparison.
  if (!isCronAuthorized(req)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const origin = new URL(
    process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || req.url,
  ).origin;
  const candidates = await selectCandidates();
  const results = [];
  for (const candidate of candidates) {
    results.push(await dispatchOne(candidate, origin));
  }
  return Response.json({
    ok: true,
    considered: candidates.length,
    dispatched: results.filter(result => result.status === 'dispatched').length,
    results,
  });
}

export async function POST(req: NextRequest) {
  return handle(req);
}

export async function GET(req: NextRequest) {
  return handle(req);
}
