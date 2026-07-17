import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { getDueScheduleSlot, validateCronExpression } from '@/lib/schedule';
import { cronUnavailable, isCronAuthorized } from '@/lib/cronAuth';
import { agentSessionMaxMinutes, sessionlessRunStaleMinutes } from '@/lib/agentRunPolicy';

export const maxDuration = 60;
// GitHub scheduled workflows can be delayed or dropped for more than a day.
// The database's source+slot claim still makes repeated checks idempotent.
const DISPATCH_LOOKBACK_MINUTES = 30 * 60;

type SourceRow = {
  id: number;
  name: string;
  schedule_cron: string;
};

type DispatchResult = {
  source_id: number;
  source: string;
  slot: string;
  status: 'dispatched' | 'skipped' | 'error';
  run_id?: number;
  error?: string;
  reason?: string;
  attempts?: number;
  max_attempts?: number;
  retry_after_seconds?: number;
};

async function readJson(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function dispatchSource(
  req: NextRequest,
  source: SourceRow,
  slot: Date,
  cronSecret: string,
): Promise<DispatchResult> {
  const slotIso = slot.toISOString();
  try {
    const response = await fetch(new URL(`/api/agent/trigger/${source.id}`, req.url), {
      method: 'POST',
      headers: {
        'x-cron-secret': cronSecret,
        'x-schedule-slot': slotIso,
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
    const body = await readJson(response);

    if (response.ok && Number.isSafeInteger(body.run_id) && body.run_id > 0) {
      return {
        source_id: source.id,
        source: source.name,
        slot: slotIso,
        status: 'dispatched',
        run_id: body.run_id,
      };
    }
    if (response.ok) {
      return {
        source_id: source.id,
        source: source.name,
        slot: slotIso,
        status: 'error',
        error: 'Trigger returned success without a valid run id',
        reason: 'invalid_trigger_response',
      };
    }
    if (
      response.status === 409
      && (body.duplicate || body.reason === 'schedule_slot_retry_cooldown')
    ) {
      return {
        source_id: source.id,
        source: source.name,
        slot: slotIso,
        status: 'skipped',
        run_id: body.run_id,
        error: body.reason || 'Run already claimed',
        reason: body.reason,
        attempts: body.attempts,
        max_attempts: body.max_attempts,
        retry_after_seconds: body.retry_after_seconds,
      };
    }
    return {
      source_id: source.id,
      source: source.name,
      slot: slotIso,
      status: 'error',
      error: body.error || `Trigger returned ${response.status}`,
      reason: body.reason,
      attempts: body.attempts,
      max_attempts: body.max_attempts,
    };
  } catch (error) {
    return {
      source_id: source.id,
      source: source.name,
      slot: slotIso,
      status: 'error',
      error: error instanceof Error ? error.message : 'Trigger request failed',
    };
  }
}

// The hourly GitHub Actions dispatcher and daily Vercel safety run authenticate
// with Authorization: Bearer <CRON_SECRET>. Agent work runs in the trigger route.
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret || cronUnavailable()) {
    return Response.json({ error: 'CRON_SECRET is not configured' }, { status: 503 });
  }
  if (!isCronAuthorized(req)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let sources: SourceRow[];
  try {
    // Deterministic source priority (2026-07-16 meeting, item 11):
    // original-organization integrations dispatch before aggregators such as
    // Localist, so ingestion's cross-source dedup can prefer the direct
    // version and only keep the aggregator copy when nothing better exists.
    const [rows] = await pool.query(
      `SELECT id, name, schedule_cron FROM sources WHERE active = 1
       ORDER BY (source_kind='aggregator') ASC, id ASC`,
    ) as any;
    sources = Array.isArray(rows) ? rows : [];
  } catch (error) {
    console.error('[scheduler] source lookup failed:', error);
    return Response.json({ error: 'Unable to load scheduled sources' }, { status: 500 });
  }

  const maintenanceErrors: string[] = [];
  let recoveredStaleRuns = 0;
  try {
    const sessionlessStaleMinutes = sessionlessRunStaleMinutes();
    const sessionMaxMinutes = agentSessionMaxMinutes();
    const recovery = await pool.query(
      `UPDATE agent_runs
       SET status='failed', finished_at=NOW(),
           error_log=JSON_ARRAY(
             CASE WHEN session_id IS NULL
               THEN 'Recovered expired agent-run start lease'
               ELSE 'Agent session exceeded its absolute runtime limit'
             END
           )
       WHERE status='running'
         AND (
           (session_id IS NULL
             AND started_at < DATE_SUB(NOW(), INTERVAL ${sessionlessStaleMinutes} MINUTE))
           OR
           (session_id IS NOT NULL
             AND started_at < DATE_SUB(NOW(), INTERVAL ${sessionMaxMinutes} MINUTE))
         )`,
    ) as any;
    recoveredStaleRuns = Number(recovery?.[0]?.affectedRows || 0);
  } catch (error) {
    console.error('[scheduler] stale-run recovery failed:', error);
    maintenanceErrors.push('stale_run_recovery_failed');
  }

  let recoveredCorrectionRequests = 0;
  try {
    const [recovery] = await pool.query(
      `UPDATE raw_events re
       SET re.status=CASE WHEN re.status='pending_fix' THEN 'pending' ELSE 'rejected' END,
           re.sent_for_correction=0
       WHERE (re.status='pending_fix' OR (re.status='rejected' AND re.sent_for_correction=1))
         AND NOT EXISTS (
           SELECT 1 FROM agent_runs ar
           WHERE ar.source_id=re.source_id
             AND ar.correction_event_id=re.id
             AND ar.status='running'
         )`,
    ) as any;
    recoveredCorrectionRequests = Number(recovery?.affectedRows || 0);
    if (recoveredCorrectionRequests > 0) {
      await pool.query(
        `DELETE nf FROM needs_fix nf
         JOIN raw_events re ON re.id=nf.raw_event_id
         WHERE re.status IN ('pending','rejected') AND re.sent_for_correction=0
           AND NOT EXISTS (
             SELECT 1 FROM agent_runs ar
             WHERE ar.source_id=re.source_id
               AND ar.correction_event_id=re.id
               AND ar.status='running'
           )`,
      );
    }
  } catch (error) {
    console.error('[scheduler] orphaned-correction recovery failed:', error);
    maintenanceErrors.push('correction_recovery_failed');
  }

  const now = new Date();
  const invalid: Array<{ source_id: number; source: string; schedule: string; error: string }> = [];
  const due: Array<{ source: SourceRow; slot: Date }> = [];

  for (const source of sources) {
    const validation = validateCronExpression(source.schedule_cron);
    if (!validation.valid) {
      invalid.push({
        source_id: source.id,
        source: source.name,
        schedule: source.schedule_cron,
        error: validation.error,
      });
      continue;
    }
    // GitHub's scheduled workflow can start well after its nominal minute.
    // A 30-hour window catches a missed daily dispatch; the unique source+slot
    // claim keeps repeated invocations idempotent.
    const slot = getDueScheduleSlot(
      source.schedule_cron,
      now,
      undefined,
      DISPATCH_LOOKBACK_MINUTES,
    );
    if (slot) due.push({ source, slot });
  }

  const results = await Promise.all(
    due.map(({ source, slot }) => dispatchSource(req, source, slot, cronSecret)),
  );

  // Requeue system-rejected "Required fields are missing" drafts through the
  // correction workflow (meeting item 12). Fire-and-report; a failure here
  // never blocks source dispatching.
  let systemCorrections: unknown = null;
  try {
    const response = await fetch(new URL('/api/agent/system-corrections', req.url), {
      method: 'POST',
      headers: { 'x-cron-secret': cronSecret },
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
    systemCorrections = await readJson(response);
  } catch (error) {
    systemCorrections = {
      error: error instanceof Error ? error.message : 'system-corrections dispatch failed',
    };
  }

  const failed = results.filter(result => result.status === 'error').length;
  const hasErrors = maintenanceErrors.length > 0 || invalid.length > 0 || failed > 0;
  const responseStatus = maintenanceErrors.length > 0 ? 500 : hasErrors ? 502 : 200;
  return Response.json({
    checked: sources.length,
    recovered_stale_runs: recoveredStaleRuns,
    recovered_correction_requests: recoveredCorrectionRequests,
    maintenance_errors: maintenanceErrors,
    due: due.length,
    dispatched: results.filter(result => result.status === 'dispatched').length,
    skipped: results.filter(result => result.status === 'skipped').length,
    failed,
    invalid_schedules: invalid,
    results,
    system_corrections: systemCorrections,
  }, { status: responseStatus });
}
