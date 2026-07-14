import { after, NextRequest } from 'next/server';
import { getAuthUser, unauthorized, forbidden } from '@/lib/auth';
import pool from '@/lib/db';

export const maxDuration = 300;

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

function staleRunMinutes(): number {
  const configured = Number.parseInt(process.env.AGENT_RUN_STALE_MINUTES || '', 10);
  if (!Number.isFinite(configured)) return 10;
  return Math.min(Math.max(configured, 6), 120);
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

async function runAgent(source: SourceRow, runId: number) {
  try {
    const runner = await import('@/lib/agentRunner');
    if (source.source_type === 'email') {
      await runner.triggerEmailIngest(source.id, runId);
    } else {
      await runner.triggerAgentRun(
        source.id,
        runId,
        process.env.ANTHROPIC_API_KEY ?? '',
        process.env.SOURCE_BUILDER_ENVIRONMENT_ID ?? '',
      );
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

  const staleMinutes = staleRunMinutes();
  await pool.query(
    `UPDATE agent_runs
     SET status='failed', finished_at=NOW(),
         error_log=JSON_ARRAY('Recovered expired agent-run lease')
     WHERE source_id=? AND status='running'
       AND started_at < DATE_SUB(NOW(), INTERVAL ${staleMinutes} MINUTE)`,
    [sourceId],
  );

  const slotValue = scheduleSlot ? toMysqlUtc(scheduleSlot) : null;
  let runId: number;
  try {
    const [runResult] = await pool.query(
      `INSERT INTO agent_runs (source_id, status, schedule_slot)
       VALUES (?, 'running', ?)`,
      [sourceId, slotValue],
    ) as any;
    runId = runResult.insertId;
  } catch (error: any) {
    if (!isDuplicateEntry(error)) {
      console.error('[agent trigger] failed to claim run:', error);
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

  after(() => runAgent(source, runId));

  return Response.json({
    ok: true,
    run_id: runId,
    source: source.name,
    scheduled: internalRequest,
    schedule_slot: scheduleSlot?.toISOString() ?? null,
    message: 'Agent started — poll /api/agent/runs for live status',
  }, { status: internalRequest ? 202 : 200 });
}
