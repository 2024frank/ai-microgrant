import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { getAuthUser, unauthorized, forbidden } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  const { searchParams } = new URL(req.url);
  const days      = searchParams.get('days')      || '30';
  const type      = searchParams.get('type')      || 'stats';
  const source_id = searchParams.get('source_id');
  const format    = searchParams.get('format')    || 'json';

  if (type === 'by-source') {
    const [rows] = await pool.query(
      `SELECT s.id, s.name, s.slug, s.agent_id, s.active,
         /* current-record and externally verified live counts */
         COUNT(DISTINCT re.id)                                 AS total_current_records,
         COUNT(DISTINCT CASE
           WHEN re.status='approved' AND re.communityhub_moderation_status='approved'
           THEN re.id END)                                    AS total_live,
         COUNT(DISTINCT CASE
           WHEN re.status='approved' AND re.communityhub_moderation_status='approved'
           THEN re.id END)                                    AS approved_live,
         COUNT(DISTINCT CASE WHEN re.status='rejected' THEN re.id END) AS rejected_live,
         COUNT(DISTINCT CASE WHEN re.status='pending' THEN re.id END)  AS pending,
         /* archived counts (events that have been deleted after expiry) */
         COALESCE(arch.total,    0)                           AS total_archived,
         /* archive rows predate external moderation evidence */
         0                                                    AS approved_archived,
         COALESCE(arch.rejected, 0)                           AS rejected_archived,
         ar.last_run_at,
         lr.status                                            AS last_run_status
       FROM sources s
       LEFT JOIN raw_events re ON re.source_id=s.id AND re.created_at >= NOW() - INTERVAL ? DAY
       LEFT JOIN (
         SELECT source_id,
           SUM(total)    AS total,
           SUM(rejected) AS rejected
         FROM event_stats_archive
         WHERE snapshotted_at >= NOW() - INTERVAL ? DAY
         GROUP BY source_id
       ) arch ON arch.source_id = s.id
       LEFT JOIN (
         SELECT source_id, MAX(finished_at) AS last_run_at FROM agent_runs GROUP BY source_id
       ) ar ON ar.source_id = s.id
       LEFT JOIN (
         SELECT source_id, status FROM agent_runs a1
         WHERE started_at = (SELECT MAX(started_at) FROM agent_runs a2 WHERE a2.source_id = a1.source_id)
       ) lr ON lr.source_id = s.id
       GROUP BY s.id, s.name, s.slug, s.agent_id, s.active, arch.total, arch.rejected, ar.last_run_at, lr.status
       ORDER BY s.name ASC`,
      [days, days]
    ) as any;

    const result = rows.map((r: any) => {
      const total    = Number(r.total_current_records || 0) + Number(r.total_archived || 0);
      const approved = Number(r.approved_live || 0);
      const rejected = Number(r.rejected_live || 0) + Number(r.rejected_archived || 0);
      const approvalRate = (approved + rejected) > 0
        ? Math.round(approved / (approved + rejected) * 1000) / 10 : null;
      return { ...r, total, approved, rejected, approval_rate: approvalRate };
    });
    return Response.json(result);
  }

  if (type === 'rejection-reasons') {
    const params: any[] = [days];
    let sc = '';
    if (source_id) { sc = 'AND source_id=?'; params.push(source_id); }
    const [rows] = await pool.query(
      `SELECT reason_codes, COUNT(*) AS n FROM rejection_log
       WHERE created_at >= NOW() - INTERVAL ? DAY ${sc} GROUP BY reason_codes`,
      params
    ) as any;
    const counts: Record<string, number> = {};
    for (const r of rows) {
      const rcArr = Array.isArray(r.reason_codes) ? r.reason_codes : JSON.parse(r.reason_codes);
      for (const code of rcArr) {
        counts[code] = (counts[code] || 0) + r.n;
      }
    }
    return Response.json(Object.entries(counts).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count));
  }

  if (type === 'field-edits') {
    const params: any[] = [days];
    let sc = '';
    if (source_id) { sc = 'AND source_id=?'; params.push(source_id); }
    const [rows] = await pool.query(
      `SELECT field_name, COUNT(*) AS edits FROM field_edit_log
       WHERE created_at >= NOW() - INTERVAL ? DAY ${sc}
       GROUP BY field_name ORDER BY edits DESC`,
      params
    ) as any;
    return Response.json(rows);
  }

  if (type === 'timeline') {
    const params: any[] = [days];
    let sc = '';
    if (source_id) { sc = 'AND source_id=?'; params.push(source_id); }
    const [rows] = await pool.query(
      `SELECT DATE(created_at) AS date, COUNT(*) AS extracted,
         SUM(status='approved' AND communityhub_moderation_status='approved') AS approved,
         SUM(status='rejected') AS rejected
       FROM raw_events WHERE created_at >= NOW() - INTERVAL ? DAY ${sc}
       GROUP BY DATE(created_at) ORDER BY date ASC`,
      params
    ) as any;
    return Response.json(rows);
  }

  if (type === 'export') {
    const exportType = searchParams.get('export_type') || 'events';
    const params: any[] = [days];
    let rows: any[];

    if (exportType === 'rejections') {
      [rows] = await pool.query(
        `SELECT rl.id, s.name AS source, rl.event_title,
           rl.reason_codes, rl.reviewer_note, rl.created_at
         FROM rejection_log rl JOIN sources s ON rl.source_id=s.id
         WHERE rl.created_at >= NOW() - INTERVAL ? DAY ORDER BY rl.created_at DESC`,
        params
      ) as any;
    } else if (exportType === 'field-edits') {
      [rows] = await pool.query(
        `SELECT fel.id, s.name AS source, re.title AS event_title,
           fel.field_name, fel.old_value, fel.new_value, fel.created_at
         FROM field_edit_log fel
         JOIN raw_events re ON fel.raw_event_id=re.id
         JOIN sources s ON fel.source_id=s.id
         WHERE fel.created_at >= NOW() - INTERVAL ? DAY ORDER BY fel.created_at DESC`,
        params
      ) as any;
    } else {
      [rows] = await pool.query(
        `SELECT re.id, s.name AS source, re.event_type, re.title,
           re.status, re.geo_scope, re.location_type, re.created_at,
           rs.action, rs.time_spent_sec, u.full_name AS reviewer
         FROM raw_events re
         JOIN sources s ON re.source_id=s.id
         LEFT JOIN review_sessions rs ON rs.raw_event_id=re.id
         LEFT JOIN users u ON rs.reviewer_id=u.id
         WHERE re.created_at >= NOW() - INTERVAL ? DAY ORDER BY re.created_at DESC`,
        params
      ) as any;
    }

    if (format === 'csv') {
      const keys = rows.length ? Object.keys(rows[0]) : [];
      const csv  = [keys.join(','), ...rows.map((r: any) =>
        keys.map(k => JSON.stringify(r[k] ?? '')).join(',')
      )].join('\n');
      return new Response(csv, {
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="${exportType}-export.csv"`,
        },
      });
    }
    return Response.json(rows);
  }

  // Default: summary stats — live + archived
  const [[live]] = await pool.query(
    `SELECT COUNT(*) AS total_extracted,
       SUM(status='approved' AND communityhub_moderation_status='approved') AS total_approved,
       SUM(status='rejected') AS total_rejected,
       SUM(status='pending')  AS total_pending
     FROM raw_events WHERE created_at >= NOW() - INTERVAL ? DAY`,
    [days]
  ) as any;

  const [[arch]] = await pool.query(
    `SELECT COALESCE(SUM(total),0) AS total_extracted,
       0 AS total_approved,
       COALESCE(SUM(rejected),0) AS total_rejected
     FROM event_stats_archive WHERE snapshotted_at >= NOW() - INTERVAL ? DAY`,
    [days]
  ) as any;

  const total_extracted = Number(live.total_extracted || 0) + Number(arch.total_extracted || 0);
  // Archive aggregates have no CommunityHub moderation state, so they cannot
  // be represented as externally verified approvals.
  const total_approved  = Number(live.total_approved || 0);
  const total_rejected  = Number(live.total_rejected  || 0) + Number(arch.total_rejected  || 0);
  const total_pending   = Number(live.total_pending   || 0);
  const approval_rate   = (total_approved + total_rejected) > 0
    ? Math.round(total_approved / (total_approved + total_rejected) * 1000) / 10 : null;

  return Response.json({ total_extracted, total_approved, total_rejected, total_pending, approval_rate });
}
