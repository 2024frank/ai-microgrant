import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { getAuthUser, unauthorized, forbidden } from '@/lib/auth';

function grade(approvalRate: number, editRate: number): string {
  // Penalise for edits needed: effective score = approvalRate - editRate * 0.5
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

  // Per-source aggregate: pulled, approved, rejected, pending, edited, clean_approved
  const [rows] = await pool.query(
    `SELECT
       s.id, s.name, s.slug, s.agent_id, s.active,
       COUNT(re.id)                                                        AS total,
       SUM(re.status = 'approved')                                         AS approved,
       SUM(re.status = 'rejected')                                         AS rejected,
       SUM(re.status = 'pending')                                          AS pending,
       COUNT(DISTINCT fel.raw_event_id)                                    AS edited,
       SUM(re.status = 'approved' AND fel.raw_event_id IS NULL)            AS clean_approved,
       MAX(ar.finished_at)                                                 AS last_run_at,
       (SELECT ar2.status FROM agent_runs ar2
        WHERE ar2.source_id = s.id ORDER BY ar2.started_at DESC LIMIT 1)  AS last_run_status,
       (SELECT ar2.events_inserted FROM agent_runs ar2
        WHERE ar2.source_id = s.id ORDER BY ar2.started_at DESC LIMIT 1)  AS last_run_inserted,
       COUNT(DISTINCT ar3.id)                                              AS total_runs
     FROM sources s
     LEFT JOIN raw_events re
           ON re.source_id = s.id
          AND re.created_at >= NOW() - INTERVAL ? DAY
     LEFT JOIN field_edit_log fel
           ON fel.raw_event_id = re.id
     LEFT JOIN agent_runs ar
           ON ar.source_id = s.id
     LEFT JOIN agent_runs ar3
           ON ar3.source_id = s.id
          AND ar3.started_at >= NOW() - INTERVAL ? DAY
     GROUP BY s.id
     ORDER BY s.name ASC`,
    [days, days]
  ) as any;

  const result = rows.map((r: any) => {
    const reviewed     = Number(r.approved || 0) + Number(r.rejected || 0);
    const approvalRate = reviewed > 0
      ? Math.round(Number(r.approved || 0) / reviewed * 1000) / 10
      : null;
    const editRate = Number(r.total || 0) > 0
      ? Math.round(Number(r.edited || 0) / Number(r.total) * 1000) / 10
      : 0;

    return {
      id:                r.id,
      name:              r.name,
      slug:              r.slug,
      agent_id:          r.agent_id,
      active:            !!r.active,
      total:             Number(r.total        || 0),
      approved:          Number(r.approved      || 0),
      rejected:          Number(r.rejected      || 0),
      pending:           Number(r.pending       || 0),
      edited:            Number(r.edited        || 0),
      clean_approved:    Number(r.clean_approved || 0),
      approval_rate:     approvalRate,
      edit_rate:         editRate,
      grade:             approvalRate !== null ? grade(approvalRate, editRate) : null,
      last_run_at:       r.last_run_at,
      last_run_status:   r.last_run_status,
      last_run_inserted: Number(r.last_run_inserted || 0),
      total_runs:        Number(r.total_runs    || 0),
    };
  });

  return Response.json(result);
}
