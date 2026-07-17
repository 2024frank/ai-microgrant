import { after, NextRequest } from 'next/server';
import type { PoolConnection } from 'mysql2/promise';
import { getAuthUser, unauthorized, forbidden } from '@/lib/auth';
import pool from '@/lib/db';
import { agentSessionMaxMinutes, sessionlessRunStaleMinutes } from '@/lib/agentRunPolicy';
import { enqueueAgentContinuation } from '@/lib/agentContinuation';

export const maxDuration = 300;

const MAX_SCHEDULED_ATTEMPTS = 3;
const SCHEDULE_RETRY_COOLDOWN_MINUTES = 15;

type SourceRow = {
  id: number;
  name: string;
  source_type?: 'web' | 'email';
};

function parseSourceId(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseScheduleSlot(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.getUTCSeconds() !== 0 || parsed.getUTCMilliseconds() !== 0) return null;
  return parsed;
}

function toMysqlUtc(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function isDuplicateEntry(error: any): boolean {
  return error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062;
}

async function findConflictingRun(sourceId: number, scheduleSlot: string | null) {
  if (scheduleSlot) {
    const [[run]] = await pool.query(
      `SELECT id, status, schedule_slot
       FROM agent_runs
       WHERE source_id = ? AND (status = 'running' OR schedule_slot = ?)
       ORDER BY (status = 'running') DESC, id DESC LIMIT 1`,
      [sourceId, scheduleSlot],
    ) as any;
    return run;
  }

  const [[run]] = await pool.query(
    `SELECT id, status, schedule_slot
     FROM agent_runs WHERE source_id = ? AND status = 'running'
     ORDER BY id DESC LIMIT 1`,
    [sourceId],
  ) as any;
  return run;
}

type ScheduleHistory = {
  failedAttempts: number;
  reservedRuns: number;
  retryAfterSeconds: number;
};

async function getScheduleHistory(
  conn: PoolConnection,
  sourceId: number,
  scheduleSlot: string,
): Promise<ScheduleHistory> {
  const [[history]] = await conn.query(
    `SELECT
       COUNT(CASE WHEN status = 'failed' THEN 1 END) AS failed_attempts,
       COUNT(CASE WHEN status IN ('running','completed','stopped') THEN 1 END) AS reserved_runs,
       TIMESTAMPDIFF(
         SECOND,
         NOW(),
         DATE_ADD(
           MAX(CASE WHEN status = 'failed' THEN COALESCE(finished_at, started_at) END),
           INTERVAL ${SCHEDULE_RETRY_COOLDOWN_MINUTES} MINUTE
         )
       ) AS retry_after_seconds
     FROM agent_runs
     WHERE source_id = ? AND schedule_slot = ?`,
    [sourceId, scheduleSlot],
  ) as any;

  return {
    failedAttempts: Number(history?.failed_attempts || 0),
    reservedRuns: Number(history?.reserved_runs || 0),
    retryAfterSeconds: Math.max(0, Number(history?.retry_after_seconds || 0)),
  };
}

async function runAgent(source: SourceRow, runId: number, origin: string) {
  try {
    const runner = await import('@/lib/agentRunner');
    if (source.source_type === 'email') {
      await runner.triggerEmailIngest(source.id, runId);
    } else {
      const result = await runner.triggerAgentRun(
        source.id,
        runId,
        process.env.ANTHROPIC_API_KEY ?? '',
        process.env.SOURCE_BUILDER_ENVIRONMENT_ID ?? '',
      );
      if (result.pending) {
        await enqueueAgentContinuation(origin, [runId]).catch(error => {
          console.error(`[agent trigger] could not enqueue continuation for run ${runId}:`, error);
        });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Agent run failed';
    console.error(`[agent trigger] run ${runId} failed:`, message);
    await pool.query(
      `UPDATE agent_runs
       SET status='failed', finished_at=NOW(), error_log=?
       WHERE id=? AND status='running'`,
      [JSON.stringify([message]), runId],
    ).catch(() => {});
  }
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ source_id: string }> },
) {
  const configuredSecret = process.env.CRON_SECRET?.trim() || '';
  const internalRequest = configuredSecret.length > 0
    && req.headers.get('x-cron-secret') === configuredSecret;

  if (!internalRequest) {
    const user = await getAuthUser(req);
    if (!user) return unauthorized();
    if (user.role !== 'admin') return forbidden();
  }

  const { source_id } = await context.params;
  const sourceId = parseSourceId(source_id);
  if (!sourceId) return Response.json({ error: 'Invalid source id' }, { status: 400 });

  let scheduleSlot: Date | null = null;
  if (internalRequest) {
    scheduleSlot = parseScheduleSlot(req.headers.get('x-schedule-slot'));
    if (!scheduleSlot) {
      return Response.json({ error: 'A minute-aligned x-schedule-slot is required' }, { status: 400 });
    }
  }

  const [[source]] = await pool.query(
    'SELECT id, name, source_type FROM sources WHERE id = ? AND active = 1',
    [sourceId],
  ) as any;
  if (!source) return Response.json({ error: 'Source not found' }, { status: 404 });

  const sessionlessStaleMinutes = sessionlessRunStaleMinutes();
  const sessionMaxMinutes = agentSessionMaxMinutes();
  await pool.query(
    `UPDATE agent_runs
     SET status='failed', finished_at=NOW(),
         error_log=JSON_ARRAY(
           CASE WHEN session_id IS NULL
             THEN 'Recovered expired agent-run start lease'
             ELSE 'Agent session exceeded its absolute runtime limit'
           END
         )
     WHERE source_id=? AND status='running'
       AND (
         (session_id IS NULL
           AND started_at < DATE_SUB(NOW(), INTERVAL ${sessionlessStaleMinutes} MINUTE))
         OR
         (session_id IS NOT NULL
           AND started_at < DATE_SUB(NOW(), INTERVAL ${sessionMaxMinutes} MINUTE))
       )`,
    [sourceId],
  );

  // A manual run must provide the same recovery guarantee as the scheduler.
  // Otherwise an expired correction lease can leave a record looking active
  // until the next hourly dispatch.
  const [recoveredCorrections] = await pool.query(
    `UPDATE raw_events re
     SET re.status=CASE WHEN re.status='pending_fix' THEN 'pending' ELSE 'rejected' END,
         re.sent_for_correction=0
     WHERE re.source_id=?
       AND (re.status='pending_fix' OR (re.status='rejected' AND re.sent_for_correction=1))
       AND NOT EXISTS (
         SELECT 1 FROM agent_runs ar
         WHERE ar.source_id=re.source_id
           AND ar.correction_event_id=re.id
           AND ar.status='running'
       )`,
    [sourceId],
  ) as any;
  if (recoveredCorrections.affectedRows) {
    await pool.query(
      `DELETE nf FROM needs_fix nf
       JOIN raw_events re ON re.id=nf.raw_event_id
       WHERE re.source_id=?
         AND re.status IN ('pending','rejected')
         AND re.sent_for_correction=0
         AND NOT EXISTS (
           SELECT 1 FROM agent_runs ar
           WHERE ar.source_id=re.source_id
             AND ar.correction_event_id=re.id
             AND ar.status='running'
         )`,
      [sourceId],
    );
  }

  const slotValue = scheduleSlot ? toMysqlUtc(scheduleSlot) : null;
  let priorFailedAttempts = 0;
  let runId: number | undefined;
  let claimError: unknown;
  let claimConn: PoolConnection | null = null;
  let scheduleLockName: string | null = null;
  let scheduleLockAcquired = false;
  try {
    if (slotValue) {
      // Serialize history inspection and insertion for this exact slot. The
      // unique reservation prevents overlapping workers, while this lock also
      // prevents a very fast failure from letting two stale attempt counts
      // claim attempts three and four concurrently.
      scheduleLockName = `agent-schedule:${sourceId}:${slotValue}`;
      claimConn = await pool.getConnection();
      const [[lock]] = await claimConn.query(
        'SELECT GET_LOCK(?, 5) AS acquired',
        [scheduleLockName],
      ) as any;
      if (Number(lock?.acquired) !== 1) {
        return Response.json({
          error: 'Scheduled slot claim is busy',
          reason: 'schedule_slot_claim_busy',
        }, { status: 503 });
      }
      scheduleLockAcquired = true;

      const history = await getScheduleHistory(claimConn, sourceId, slotValue);
      priorFailedAttempts = history.failedAttempts;
      // A reserved run will be handled by the unique insert below. Do not let
      // historical failed rows obscure idempotency for a completed/stopped slot.
      if (history.reservedRuns === 0 && priorFailedAttempts >= MAX_SCHEDULED_ATTEMPTS) {
        return Response.json({
          error: 'Scheduled slot retry limit exhausted',
          reason: 'schedule_slot_retry_exhausted',
          attempts: priorFailedAttempts,
          max_attempts: MAX_SCHEDULED_ATTEMPTS,
        }, { status: 422 });
      }

      if (history.reservedRuns === 0 && history.retryAfterSeconds > 0) {
        return Response.json({
          error: 'Scheduled slot retry is cooling down',
          reason: 'schedule_slot_retry_cooldown',
          attempts: priorFailedAttempts,
          max_attempts: MAX_SCHEDULED_ATTEMPTS,
          retry_after_seconds: history.retryAfterSeconds,
        }, {
          status: 409,
          headers: { 'Retry-After': String(history.retryAfterSeconds) },
        });
      }
    }

    const queryClient = claimConn || pool;
    const [runResult] = await queryClient.query(
      `INSERT INTO agent_runs (source_id, status, schedule_slot)
       VALUES (?, 'running', ?)`,
      [sourceId, slotValue],
    ) as any;
    runId = runResult.insertId;
  } catch (error) {
    claimError = error;
  } finally {
    if (claimConn) {
      let releaseConnection = true;
      if (scheduleLockAcquired && scheduleLockName) {
        try {
          const [[released]] = await claimConn.query(
            'SELECT RELEASE_LOCK(?) AS released',
            [scheduleLockName],
          ) as any;
          if (Number(released?.released) !== 1) {
            throw new Error('Database did not confirm schedule claim lock release');
          }
        } catch (error) {
          // Never return a pooled connection that might retain a named lock.
          console.error('[agent trigger] failed to release schedule claim lock:', error);
          claimConn.destroy();
          releaseConnection = false;
        }
      }
      if (releaseConnection) claimConn.release();
    }
  }

  if (claimError) {
    if (!isDuplicateEntry(claimError)) {
      console.error('[agent trigger] failed to claim run:', claimError);
      return Response.json({ error: 'Unable to claim agent run' }, { status: 500 });
    }

    const existing = await findConflictingRun(sourceId, slotValue);
    return Response.json({
      error: 'Agent run already claimed',
      duplicate: true,
      reason: existing?.status === 'running' ? 'source_already_running' : 'schedule_slot_already_claimed',
      run_id: existing?.id ?? null,
    }, { status: 409 });
  }

  if (!runId) {
    console.error('[agent trigger] insert returned no run id');
    return Response.json({ error: 'Unable to claim agent run' }, { status: 500 });
  }

  const continuationOrigin = new URL(
    process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || req.url,
  ).origin;
  after(() => runAgent(source, runId, continuationOrigin));

  return Response.json({
    ok: true,
    run_id: runId,
    source: source.name,
    scheduled: internalRequest,
    schedule_slot: scheduleSlot?.toISOString() ?? null,
    attempt: scheduleSlot ? priorFailedAttempts + 1 : null,
    message: 'Agent started — poll /api/agent/runs for live status',
  }, { status: internalRequest ? 202 : 200 });
}
