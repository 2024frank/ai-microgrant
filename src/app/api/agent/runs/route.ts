import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { getAuthUser, unauthorized, forbidden } from '@/lib/auth';
import { isCronAuthorized } from '@/lib/cronAuth';

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
