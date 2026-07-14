import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { getDueScheduleSlot, validateCronExpression } from '@/lib/schedule';

export const maxDuration = 60;

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
    const slot = getDueScheduleSlot(source.schedule_cron, now);
    if (slot) due.push({ source, slot });
  }

  const results = await Promise.all(
    due.map(({ source, slot }) => dispatchSource(req, source, slot, cronSecret)),
  );

  return Response.json({
    checked: sources.length,
    due: due.length,
    dispatched: results.filter(result => result.status === 'dispatched').length,
    skipped: results.filter(result => result.status === 'skipped').length,
    failed: results.filter(result => result.status === 'error').length,
    invalid_schedules: invalid,
    results,
  });
}
