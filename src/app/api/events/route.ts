import { NextRequest } from 'next/server';
import pool from '@/lib/db';

const CACHE = { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' };

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  const status      = searchParams.get('status')      || 'all';
  const source_id   = searchParams.get('source_id');
  const source_slug = searchParams.get('source_slug');
  const event_type  = searchParams.get('event_type');
  const geo_scope   = searchParams.get('geo_scope');
  const from        = searchParams.get('from');
  const to          = searchParams.get('to');
  const q           = searchParams.get('q');
  const order       = searchParams.get('order') === 'asc' ? 'ASC' : 'DESC';
  const limit       = Math.min(parseInt(searchParams.get('limit') || '50'), 100);
  const page        = parseInt(searchParams.get('page') || '0');

  const conditions: string[] = [];
  const params: any[]        = [];

  if (status !== 'all') { conditions.push('re.status = ?');      params.push(status); }
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
       re.buttons, re.contact_email, re.email, re.phone, re.website, re.image_cdn_url,
       re.calendar_source_name, re.calendar_source_url, re.ingested_post_url,
       re.geo_scope, re.status, re.communityhub_post_id,
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
  }, { headers: CACHE });
}

export async function OPTIONS() {
  return new Response(null, { status: 204 });
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
