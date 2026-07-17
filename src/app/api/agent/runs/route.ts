import { after, NextRequest } from 'next/server';
import pool from '@/lib/db';
import { getAuthUser, unauthorized, forbidden } from '@/lib/auth';
import { isCronAuthorized } from '@/lib/cronAuth';
import { enqueueAgentContinuation } from '@/lib/agentContinuation';

export const maxDuration = 300;

// GET /api/agent/runs?source_id=1&limit=5
// Returns recent runs with live status — poll this every 2s during an active run
export async function GET(req: NextRequest) {
  const internalRequest = isCronAuthorized(req);
  if (!internalRequest) {
    const user = await getAuthUser(req);
    if (!user) return unauthorized();
    if (user.role !== 'admin') return forbidden();
  }

  const { searchParams } = new URL(req.url);
  const source_id = searchParams.get('source_id');
  const rawIds = searchParams.get('ids');
  const requestedLimit = Number.parseInt(searchParams.get('limit') || '10', 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), 100)
    : 10;

  const params: any[] = [];
  let where = '';
  let queryLimit = limit;
  if (rawIds !== null) {
    const parts = rawIds.split(',').filter(Boolean);
    if (
      parts.length === 0
      || parts.length > 50
      || parts.some(value => !/^\d+$/.test(value) || Number(value) <= 0)
    ) {
      return Response.json({ error: 'ids must contain 1-50 positive integers' }, { status: 400 });
    }
    const ids = [...new Set(parts.map(Number))];
    where = `WHERE ar.id IN (${ids.map(() => '?').join(',')})`;
    params.push(...ids);
    queryLimit = ids.length;
  } else if (source_id) {
    if (!/^\d+$/.test(source_id) || Number(source_id) <= 0) {
      return Response.json({ error: 'Invalid source_id' }, { status: 400 });
    }
    where = 'WHERE ar.source_id = ?';
    params.push(source_id);
  }
  params.push(queryLimit);

  const [runs] = await pool.query(
    `SELECT ar.id, ar.source_id, ar.status, ar.started_at, ar.finished_at,
            ar.events_found, ar.events_extracted, ar.events_skipped_dup,
            ar.events_errored, ar.error_log,
            TIMESTAMPDIFF(SECOND, ar.started_at, IFNULL(ar.finished_at, NOW())) AS elapsed_sec,
            s.name AS source_name
     FROM agent_runs ar
     JOIN sources s ON ar.source_id = s.id
     ${where}
     ORDER BY ar.started_at DESC LIMIT ?`,
    params
  ) as any;

  // Also return count of events added in the most recent completed run
  const hasActive = runs.some((r: any) => r.status === 'running');
  const failed = runs.filter((r: any) => ['failed', 'stopped'].includes(r.status)).length;

  return Response.json({
    runs,
    has_active: hasActive,
    terminal: runs.length > 0 && !hasActive,
    failed,
  });
}

// POST /api/agent/runs { ids: [1, 2] }
// Queues managed-agent sessions that outlived their original serverless
// monitoring slice. The continuation worker is idempotent and DB-leased.
export async function POST(req: NextRequest) {
  const internalRequest = isCronAuthorized(req);
  if (!internalRequest) {
    const user = await getAuthUser(req);
    if (!user) return unauthorized();
    if (user.role !== 'admin') return forbidden();
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const rawIds = (body as { ids?: unknown } | null)?.ids;
  if (
    !Array.isArray(rawIds)
    || rawIds.length === 0
    || rawIds.length > 50
    || rawIds.some(id => !Number.isSafeInteger(id) || Number(id) <= 0)
  ) {
    return Response.json({ error: 'ids must contain 1-50 positive integers' }, { status: 400 });
  }

  const ids = [...new Set(rawIds.map(Number))];
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim() || '';
  if (!anthropicKey) {
    return Response.json({ error: 'ANTHROPIC_API_KEY is not configured' }, { status: 503 });
  }
  if (!process.env.CRON_SECRET?.trim()) {
    return Response.json({ error: 'CRON_SECRET is not configured' }, { status: 503 });
  }

  const origin = new URL(
    process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || req.url,
  ).origin;
  if (ids.length > 1) {
    // Fan out so one slow source gets its own serverless duration budget.
    after(async () => {
      await Promise.all(ids.map(id => enqueueAgentContinuation(origin, [id]).catch(error => {
        console.error(`[agent runs] continuation fan-out failed for run=${id}:`, error);
      })));
    });
  } else {
    const [runId] = ids;
    after(async () => {
      const { monitorAgentRun } = await import('@/lib/agentRunner');
      try {
        const result = await monitorAgentRun(runId, anthropicKey);
        if (result.pending && !result.busy) {
          await enqueueAgentContinuation(origin, [runId]);
        }
      } catch (error) {
        console.error(`[agent runs] continuation worker failed for run=${runId}:`, error);
      }
    });
  }

  return Response.json({ queued: ids.length, ids }, { status: 202 });
}
