import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { getAuthUser } from '@/lib/auth';
import { isEventType } from '@/lib/eventTypes';

const CH_BASE = 'https://oberlin.communityhub.cloud/api/legacy/calendar';

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const [[event]] = await pool.query(
    `SELECT re.id, re.title, re.description, re.extended_description,
            re.event_type, re.sponsors, re.post_type_ids, re.sessions,
            re.location_type, re.location, re.place_name, re.room_num, re.url_link,
            re.display, re.buttons, re.website, re.image_cdn_url,
            re.calendar_source_name, re.calendar_source_url, re.ingested_post_url,
            re.geo_scope, re.geo_json, re.status, re.created_at,
            s.name AS source_name, s.calendar_source_name AS source_calendar_name
     FROM raw_events re LEFT JOIN sources s ON re.source_id = s.id WHERE re.id = ?`, [id]
  ) as any;
  if (!event) return Response.json({ error: 'Not found' }, { status: 404 });

  const parsed = {
    ...event,
    sponsors:      pj(event.sponsors,      []),
    post_type_ids: pj(event.post_type_ids, []),
    sessions:      pj(event.sessions,      []),
    buttons:       pj(event.buttons,       []),
    geo_json:      pj(event.geo_json,      null),
  };

  return Response.json(parsed, { headers: { 'Access-Control-Allow-Origin': '*' } });
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const user = await getAuthUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await context.params;
  const { edits = {} } = await req.json();
  if (edits.event_type !== undefined && !isEventType(edits.event_type)) {
    return Response.json({ error: 'Invalid event type' }, { status: 400 });
  }

  const [[event]] = await pool.query('SELECT * FROM raw_events WHERE id = ?', [id]) as any;
  if (!event) return Response.json({ error: 'Not found' }, { status: 404 });
  if (!event.communityhub_post_id) return Response.json({ error: 'Not yet submitted' }, { status: 400 });

  const [[dbUser]] = await pool.query('SELECT id FROM users WHERE firebase_uid = ?', [user.uid]) as any;
  const editableFields = ['event_type','title','description','extended_description','sessions','location_type',
    'location','place_name','room_num','url_link','sponsors','post_type_ids','geo_scope',
    'contact_email','email','phone','website','image_cdn_url','buttons','display'];

  const conn = await pool.getConnection();
  try {
    await (conn as any).beginTransaction();
    for (const field of editableFields) {
      if (edits[field] !== undefined && String(edits[field]) !== String(event[field] ?? '')) {
        await conn.query(
          `INSERT INTO field_edit_log (raw_event_id, source_id, reviewer_id, field_name, old_value, new_value)
           VALUES (?,?,?,?,?,?)`,
          [id, event.source_id, dbUser?.id, field, String(event[field] ?? ''), String(edits[field])]
        );
      }
    }
    const fieldMap: Record<string,string> = {
      event_type:'eventType', title:'title', description:'description', extended_description:'extendedDescription',
      sessions:'sessions', location_type:'locationType', location:'location',
      place_name:'placeName', room_num:'roomNum', url_link:'urlLink', sponsors:'sponsors',
      post_type_ids:'postTypeId', contact_email:'contactEmail', phone:'phone',
      website:'website', image_cdn_url:'image_cdn_url', buttons:'buttons', display:'display',
    };
    const chEdits: Record<string,any> = {};
    for (const [k,v] of Object.entries(edits)) {
      if (!fieldMap[k]) continue;
      const chKey = fieldMap[k];
      // Convert base64 data URIs to our image-serving URL so CommunityHub can download
      if (chKey === 'image_cdn_url' && typeof v === 'string' && v.startsWith('data:')) {
        const base = process.env.NEXT_PUBLIC_APP_URL || 'https://ai-microgrant-research-oberlin.vercel.app';
        chEdits['image_cdn_url'] = `${base}/api/events/${id}/image`;
      } else {
        chEdits[chKey] = v;
      }
    }

    const chRes  = await fetch(`${CH_BASE}/post/${event.communityhub_post_id}/submit`, {
      method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify(chEdits),
    });
    const rawText = await chRes.text();
    let chData: any;
    try { chData = JSON.parse(rawText); } catch { chData = { raw: rawText.slice(0, 200) }; }
    if (!chRes.ok) throw new Error(`CommunityHub ${chRes.status}: ${chData.raw ?? JSON.stringify(chData)}`);
    const setClauses = Object.keys(edits).filter(k => editableFields.includes(k)).map(k => `${k} = ?`).join(', ');
    const setVals    = Object.entries(edits).filter(([k]) => editableFields.includes(k)).map(([,v]) => typeof v==='object'?JSON.stringify(v):v);
    if (setClauses) await conn.query(`UPDATE raw_events SET ${setClauses}, status='resubmitted' WHERE id=?`, [...setVals, id]);
    await (conn as any).commit();
    return Response.json({ ok: true, communityhub: chData });
  } catch (err: any) {
    await (conn as any).rollback();
    return Response.json({ error: err.message }, { status: 500 });
  } finally {
    (conn as any).release();
  }
}

function pj(val: any, fallback: any): any {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch { return fallback; }
}
