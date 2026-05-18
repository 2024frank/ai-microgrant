import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { getAuthUser, unauthorized, forbidden } from '@/lib/auth';

function grade(approvalRate: number, editRate: number): string {
  const score = approvalRate - editRate * 0.5;
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  const { searchParams } = new URL(req.url);
  const days = parseInt(searchParams.get('days') || '30');

  const [
    [sourceRows],
    [runRows],
    [trendRows],
    [speedRows],
    [fieldRows],
  ] = await Promise.all([
    // Per-source aggregate
    pool.query(
      `SELECT
         s.id, s.name, s.slug, s.agent_id, s.active,
         COUNT(DISTINCT re.id)                                              AS total,
         SUM(re.status = 'approved')                                        AS approved,
         SUM(re.status = 'rejected')                                        AS rejected,
         SUM(re.status = 'pending')                                         AS pending,
         COUNT(DISTINCT fel.raw_event_id)                                   AS edited,
         SUM(re.status = 'approved' AND fel.raw_event_id IS NULL)           AS clean_approved
       FROM sources s
       LEFT JOIN raw_events re ON re.source_id = s.id AND re.created_at >= NOW() - INTERVAL ? DAY
       LEFT JOIN field_edit_log fel ON fel.raw_event_id = re.id
       GROUP BY s.id ORDER BY s.name ASC`,
      [days]
    ) as any,

    // Last 30 runs with duration
    pool.query(
      `SELECT ar.id, s.name AS source_name, ar.status,
         ar.events_found, ar.events_extracted,
         TIMESTAMPDIFF(SECOND, ar.started_at, ar.finished_at) AS duration_sec,
         ar.started_at, ar.finished_at, ar.error_log
       FROM agent_runs ar JOIN sources s ON s.id = ar.source_id
       WHERE ar.started_at >= NOW() - INTERVAL ? DAY
       ORDER BY ar.started_at DESC LIMIT 40`,
      [days]
    ) as any,

    // Daily extraction trend per source
    pool.query(
      `SELECT DATE(ar.started_at) AS day, s.name AS source_name,
         COUNT(ar.id) AS runs,
         SUM(ar.events_extracted) AS extracted,
         SUM(ar.events_extracted = 0) AS empty_runs
       FROM agent_runs ar JOIN sources s ON s.id = ar.source_id
       WHERE ar.started_at >= NOW() - INTERVAL ? DAY
       GROUP BY day, s.id ORDER BY day ASC`,
      [days]
    ) as any,

    // Speed stats per source
    pool.query(
      `SELECT s.name,
         COUNT(ar.id) AS total_runs,
         SUM(ar.events_extracted > 0) AS productive_runs,
         SUM(ar.events_extracted = 0) AS empty_runs,
         ROUND(AVG(NULLIF(TIMESTAMPDIFF(SECOND, ar.started_at, ar.finished_at), 0)), 1) AS avg_sec,
         MAX(TIMESTAMPDIFF(SECOND, ar.started_at, ar.finished_at)) AS max_sec,
         MIN(CASE WHEN TIMESTAMPDIFF(SECOND, ar.started_at, ar.finished_at) > 0
               THEN TIMESTAMPDIFF(SECOND, ar.started_at, ar.finished_at) END) AS min_sec,
         SUM(ar.status = 'failed') AS failed_runs,
         MAX(ar.finished_at) AS last_run_at,
         (SELECT ar2.status FROM agent_runs ar2 WHERE ar2.source_id = s.id ORDER BY ar2.started_at DESC LIMIT 1) AS last_run_status
       FROM sources s
       LEFT JOIN agent_runs ar ON ar.source_id = s.id AND ar.started_at >= NOW() - INTERVAL ? DAY
       GROUP BY s.id ORDER BY s.name ASC`,
      [days]
    ) as any,

    // Most edited fields
    pool.query(
      `SELECT field_name, COUNT(*) AS edits,
         COUNT(DISTINCT raw_event_id) AS events_affected
       FROM field_edit_log
       WHERE created_at >= NOW() - INTERVAL ? DAY
       GROUP BY field_name ORDER BY edits DESC LIMIT 10`,
      [days]
    ) as any,
  ]) as any;

  // Merge source stats with speed stats
  const speedMap: Record<string, any> = {};
  for (const r of speedRows) speedMap[r.name] = r;

  const sources = sourceRows.map((r: any) => {
    const sp = speedMap[r.name] || {};
    const reviewed = Number(r.approved || 0) + Number(r.rejected || 0);
    const approvalRate = reviewed > 0
      ? Math.round(Number(r.approved || 0) / reviewed * 1000) / 10
      : null;
    const editRate = Number(r.total || 0) > 0
      ? Math.round(Number(r.edited || 0) / Number(r.total) * 1000) / 10
      : 0;
    const totalRuns    = Number(sp.total_runs || 0);
    const productiveRuns = Number(sp.productive_runs || 0);
    return {
      id:              r.id,
      name:            r.name,
      slug:            r.slug,
      agent_id:        r.agent_id,
      active:          !!r.active,
      total:           Number(r.total        || 0),
      approved:        Number(r.approved     || 0),
      rejected:        Number(r.rejected     || 0),
      pending:         Number(r.pending      || 0),
      edited:          Number(r.edited       || 0),
      clean_approved:  Number(r.clean_approved || 0),
      approval_rate:   approvalRate,
      edit_rate:       editRate,
      grade:           approvalRate !== null ? grade(approvalRate, editRate) : null,
      total_runs:      totalRuns,
      productive_runs: productiveRuns,
      empty_runs:      Number(sp.empty_runs  || 0),
      failed_runs:     Number(sp.failed_runs || 0),
      avg_sec:         sp.avg_sec ? Number(sp.avg_sec) : null,
      max_sec:         sp.max_sec ? Number(sp.max_sec) : null,
      min_sec:         sp.min_sec ? Number(sp.min_sec) : null,
      hit_rate:        totalRuns > 0 ? Math.round(productiveRuns / totalRuns * 100) : null,
      last_run_at:     sp.last_run_at,
      last_run_status: sp.last_run_status,
    };
  });

  return Response.json({
    sources,
    runs:       runRows,
    trend:      trendRows,
    top_fields: fieldRows,
  });
}
