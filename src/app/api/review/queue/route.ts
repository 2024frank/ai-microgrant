import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { getAuthUser, unauthorized } from '@/lib/auth';

// GET /api/review/queue
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();

  const { searchParams } = new URL(req.url);
  const page      = parseInt(searchParams.get('page')      || '0');
  const limit     = parseInt(searchParams.get('limit')     || '20');
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

  let sourceClause = '';
  const params: any[] = [];

  if (user.role === 'reviewer') {
    sourceClause = `AND re.source_id IN (
      SELECT source_id FROM reviewer_sources WHERE reviewer_id = (
        SELECT id FROM users WHERE firebase_uid = ?
      )
    )`;
    params.push(user.uid);
  }

  if (source_id) {
    sourceClause += ' AND re.source_id = ?';
    params.push(source_id);
  }

  const [events] = await pool.query(
    `SELECT re.id, re.title, re.event_type, re.description, re.sessions,
            re.location_type, re.geo_scope, re.created_at, re.source_id,
            re.sent_for_correction, re.corrected_from_id, re.sent_for_fix_by,
            s.name AS source_name, s.slug AS source_slug
     FROM raw_events re
     JOIN sources s ON re.source_id = s.id
     WHERE re.status IN ('pending','pending_fix') ${sourceClause}
     ORDER BY ${orderBy}
     LIMIT ? OFFSET ?`,
    [...params, limit, page * limit]
  ) as any;

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM raw_events re
     WHERE re.status IN ('pending','pending_fix') ${sourceClause}`,
    params
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
