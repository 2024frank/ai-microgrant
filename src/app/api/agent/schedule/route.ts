import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { getDueScheduleSlot, validateCronExpression } from '@/lib/schedule';

export const maxDuration = 60;
const DISPATCH_LOOKBACK_MINUTES = 6 * 60;
const STALE_RUN_MINUTES = 10;

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
    });
    const body = await readJson(response);

    if (response.ok) {
      return {
        source_id: source.id,
        source: source.name,
        slot: slotIso,
        status: 'dispatched',
        run_id: body.run_id,
      };
    }
    if (response.status === 409 && body.duplicate) {
      return {
        source_id: source.id,
        source: source.name,
        slot: slotIso,
        status: 'skipped',
        run_id: body.run_id,
        error: body.reason || 'Run already claimed',
      };
    }
    return {
      source_id: source.id,
      source: source.name,
      slot: slotIso,
      status: 'error',
      error: body.error || `Trigger returned ${response.status}`,
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
  if (!cronSecret) {
    return Response.json({ error: 'CRON_SECRET is not configured' }, { status: 503 });
  }
  if (req.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let sources: SourceRow[];
  try {
    const [rows] = await pool.query(
      'SELECT id, name, schedule_cron FROM sources WHERE active = 1 ORDER BY id',
    ) as any;
    sources = Array.isArray(rows) ? rows : [];
  } catch (error) {
    console.error('[scheduler] source lookup failed:', error);
    return Response.json({ error: 'Unable to load scheduled sources' }, { status: 500 });
  }

  let recoveredStaleRuns = 0;
  try {
    const recovery = await pool.query(
      `UPDATE agent_runs
       SET status='failed', finished_at=NOW(),
           error_log=JSON_ARRAY('Recovered expired agent-run lease')
       WHERE status='running'
         AND started_at < DATE_SUB(NOW(), INTERVAL ${STALE_RUN_MINUTES} MINUTE)`,
    ) as any;
    recoveredStaleRuns = Number(recovery?.[0]?.affectedRows || 0);
  } catch (error) {
    console.error('[scheduler] stale-run recovery failed:', error);
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
    // A six-hour window catches delayed slots without replaying an old day; the unique
    // source+schedule_slot claim keeps repeated invocations idempotent.
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

  return Response.json({
    checked: sources.length,
    recovered_stale_runs: recoveredStaleRuns,
    recovered_correction_requests: recoveredCorrectionRequests,
    due: due.length,
    dispatched: results.filter(result => result.status === 'dispatched').length,
    skipped: results.filter(result => result.status === 'skipped').length,
    failed: results.filter(result => result.status === 'error').length,
    invalid_schedules: invalid,
    results,
  });
}
