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
    // last_run derived table avoids a correlated subquery per source row
    const [rows] = await pool.query(
      `SELECT s.id, s.name, s.slug, s.agent_id, s.active,
         COUNT(re.id)                                          AS total,
         SUM(re.status='approved')                            AS approved,
         SUM(re.status='rejected')                            AS rejected,
         SUM(re.status='pending')                             AS pending,
         ROUND(SUM(re.status='approved')/NULLIF(SUM(re.status IN ('approved','rejected')),0)*100,1) AS approval_rate,
         MAX(ar.finished_at)                                  AS last_run_at,
         lr.status                                            AS last_run_status
       FROM sources s
       LEFT JOIN raw_events re ON re.source_id=s.id AND re.created_at >= NOW() - INTERVAL ? DAY
       LEFT JOIN agent_runs ar ON ar.source_id=s.id
       LEFT JOIN (
         SELECT source_id, status
         FROM agent_runs a1
         WHERE started_at = (SELECT MAX(started_at) FROM agent_runs a2 WHERE a2.source_id = a1.source_id)
       ) lr ON lr.source_id = s.id
       GROUP BY s.id, lr.status ORDER BY s.name ASC`,
      [days]
    ) as any;
    return Response.json(rows);
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
         SUM(status='approved') AS approved, SUM(status='rejected') AS rejected
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

  // Default: summary stats
  const [[totals]] = await pool.query(
    `SELECT COUNT(*) AS total_extracted,
       SUM(status='approved') AS total_approved,
       SUM(status='rejected') AS total_rejected,
       SUM(status='pending')  AS total_pending,
       ROUND(SUM(status='approved')/NULLIF(SUM(status IN ('approved','rejected')),0)*100,1) AS approval_rate
     FROM raw_events WHERE created_at >= NOW() - INTERVAL ? DAY`,
    [days]
  ) as any;
  return Response.json(totals);
}
