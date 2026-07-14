import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { getAuthUser } from '@/lib/auth';

const CACHE = { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' };
const CORS  = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  const hasAuthorization = Boolean(req.headers.get('authorization'));
  const user = hasAuthorization ? await getAuthUser(req) : null;
  if (hasAuthorization && !user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers: CORS });
  }

  const requestedStatus = searchParams.get('status') || 'all';
  const allowedStatuses = new Set([
    'all', 'pending', 'approved', 'rejected', 'resubmitted',
    'pending_fix', 'publishing', 'superseded',
  ]);
  if (!allowedStatuses.has(requestedStatus)) {
    return Response.json({ error: 'Invalid status' }, { status: 400, headers: CORS });
  }
  // Anonymous consumers may only read records that completed human review.
  const status = user ? requestedStatus : 'approved';
  const source_id   = searchParams.get('source_id');
  const source_slug = searchParams.get('source_slug');
  const event_type  = searchParams.get('event_type');
  const geo_scope   = searchParams.get('geo_scope');
  const from        = searchParams.get('from');
  const to          = searchParams.get('to');
  const q           = searchParams.get('q');
  const order       = searchParams.get('order') === 'asc' ? 'ASC' : 'DESC';
  const requestedLimit = Number.parseInt(searchParams.get('limit') || '50', 10);
  const requestedPage  = Number.parseInt(searchParams.get('page') || '0', 10);
  const limit       = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
  const page        = Number.isFinite(requestedPage) ? Math.max(requestedPage, 0) : 0;

  const conditions: string[] = [];
  const params: any[]        = [];

  if (status !== 'all') { conditions.push('re.status = ?');      params.push(status); }
  if (user?.role === 'reviewer') {
    conditions.push(`(
      NOT EXISTS (
        SELECT 1 FROM reviewer_sources rs0
        JOIN users u0 ON u0.id=rs0.reviewer_id
        WHERE u0.firebase_uid=?
      )
      OR EXISTS (
        SELECT 1 FROM reviewer_sources rs
        JOIN users u ON u.id=rs.reviewer_id
        WHERE u.firebase_uid=? AND rs.source_id=re.source_id
      )
    )`);
    params.push(user.uid, user.uid);
  }
  if (source_id)        { conditions.push('re.source_id = ?');   params.push(source_id); }
  if (source_slug)      { conditions.push('s.slug = ?');         params.push(source_slug); }
  if (event_type)       { conditions.push('re.event_type = ?');  params.push(event_type); }
  if (geo_scope)        { conditions.push('re.geo_scope = ?');   params.push(geo_scope); }
  if (from)             { conditions.push('re.created_at >= ?'); params.push(from); }
  if (to)               { conditions.push('re.created_at <= ?'); params.push(to); }
  if (q) {
    conditions.push('(re.title LIKE ? OR re.description LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM raw_events re JOIN sources s ON re.source_id = s.id ${where}`,
    [...params]
  ) as any;

  const [events] = await pool.query(
    `SELECT
       re.id, re.event_type, re.title, re.description, re.extended_description,
       re.sponsors, re.post_type_ids, re.sessions, re.location_type,
       re.location, re.place_name, re.room_num, re.url_link, re.display,
       re.buttons, re.contact_email, re.phone, re.website, re.image_cdn_url,
       re.calendar_source_name, re.calendar_source_url, re.ingested_post_url,
       re.geo_scope, re.status, re.sent_for_correction, re.communityhub_post_id,
       re.created_at, re.updated_at,
       s.id AS source_id, s.name AS source_name, s.slug AS source_slug
     FROM raw_events re
     JOIN sources s ON re.source_id = s.id
     ${where}
     ORDER BY re.created_at ${order}
     LIMIT ? OFFSET ?`,
    [...params, limit, page * limit]
  ) as any;

  const parsed = events.map(parseEvent);

  return Response.json({
    events: parsed,
    pagination: {
      total, page, limit,
      pages:    Math.ceil(total / limit),
      has_next: (page + 1) * limit < total,
      has_prev: page > 0,
    },
    filters: { status, source_id, source_slug, event_type, geo_scope, from, to, q, order },
  }, { headers: { ...(user ? { 'Cache-Control': 'private, no-store' } : CACHE), ...CORS } });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

// Parse all JSON fields so consumers always get proper arrays/objects
function parseEvent(ev: any) {
  return {
    ...ev,
    sponsors:      parseJsonField(ev.sponsors,      []),
    post_type_ids: parseJsonField(ev.post_type_ids, []),
    sessions:      parseJsonField(ev.sessions,      []),
    buttons:       parseJsonField(ev.buttons,       []),
    geo_json:      parseJsonField(ev.geo_json,      null),
  };
}

function parseJsonField(val: any, fallback: any): any {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'object') return val;          // already parsed by MySQL driver
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return fallback; }
  }
  return fallback;
}
