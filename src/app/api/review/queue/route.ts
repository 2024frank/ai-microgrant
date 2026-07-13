import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { getAuthUser, unauthorized } from '@/lib/auth';

// GET /api/review/queue
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();

  const { searchParams } = new URL(req.url);
  const requestedPage  = Number.parseInt(searchParams.get('page')  || '0', 10);
  const requestedLimit = Number.parseInt(searchParams.get('limit') || '20', 10);
  const page      = Number.isFinite(requestedPage) ? Math.max(requestedPage, 0) : 0;
  const limit     = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 20;
  const source_id = searchParams.get('source_id');
  const sort      = searchParams.get('sort') || 'ingested_asc';

  // Map sort param → SQL ORDER BY
  const ORDER_MAP: Record<string, string> = {
    ingested_asc:   're.created_at ASC',
    ingested_desc:  're.created_at DESC',
    event_date_asc: "JSON_UNQUOTE(JSON_EXTRACT(re.sessions, '$[0].startTime')) ASC",
    event_date_desc:"JSON_UNQUOTE(JSON_EXTRACT(re.sessions, '$[0].startTime')) DESC",
  };
  const orderBy = ORDER_MAP[sort] || ORDER_MAP.ingested_asc;

  const params: any[] = [];
  const clauses: string[] = [];

  if (source_id) {
    clauses.push('re.source_id = ?');
    params.push(source_id);
  }

  // Reviewers are scoped to their assigned sources (if any).
  // Admins see everything. The subquery always references reviewer_sources so
  // the clause is present regardless of whether assignments exist.
  let scopeClause = '';
  const scopeParams: any[] = [];
  if (user.role === 'reviewer') {
    scopeClause = `
      AND (
        NOT EXISTS (
          SELECT 1 FROM reviewer_sources rs2
          JOIN users u2 ON u2.id = rs2.reviewer_id
          WHERE u2.firebase_uid = ?
        )
        OR re.source_id IN (
          SELECT rs.source_id FROM reviewer_sources rs
          JOIN users u ON u.id = rs.reviewer_id
          WHERE u.firebase_uid = ?
        )
      )`;
    scopeParams.push(user.uid, user.uid);
  }

  const extraClause = clauses.length ? ' AND ' + clauses.join(' AND ') : '';

  const [events] = await pool.query(
    `SELECT re.id, re.title, re.event_type, re.description, re.sessions,
            re.location_type, re.geo_scope, re.created_at, re.source_id,
            re.sent_for_correction, re.corrected_from_id, re.sent_for_fix_by,
            s.name AS source_name, s.slug AS source_slug
     FROM raw_events re
     JOIN sources s ON re.source_id = s.id
     WHERE re.status IN ('pending','pending_fix') ${scopeClause} ${extraClause}
     ORDER BY ${orderBy}
     LIMIT ? OFFSET ?`,
    [...scopeParams, ...params, limit, page * limit]
  ) as any;

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM raw_events re
     WHERE re.status IN ('pending','pending_fix') ${scopeClause} ${extraClause}`,
    [...scopeParams, ...params]
  ) as any;

  // Return the distinct sources that have pending events (for the filter dropdown)
  const [sources] = await pool.query(
    `SELECT DISTINCT s.id, s.name FROM raw_events re
     JOIN sources s ON re.source_id = s.id
     WHERE re.status = 'pending'
     ORDER BY s.name ASC`
  ) as any;

  return Response.json({ events, total, page, limit, sources });
}
