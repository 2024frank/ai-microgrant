import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { getAuthUser } from '@/lib/auth';
import { isEventType } from '@/lib/eventTypes';
import { canAccessSource } from '@/lib/reviewerAccess';
import {
  buildCommunityHubPayload,
  CommunityHubPayloadValidationError,
} from '@/lib/communityHubPayload';

const CH_BASE = 'https://oberlin.communityhub.cloud/api/legacy/calendar';

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const [[event]] = await pool.query(
    `SELECT re.id, re.title, re.description, re.extended_description,
            re.event_type, re.sponsors, re.post_type_ids, re.sessions,
            re.location_type, re.location, re.place_name, re.room_num, re.url_link,
            re.display, re.buttons, re.website, re.image_cdn_url,
            re.calendar_source_name, re.calendar_source_url, re.ingested_post_url,
            re.geo_scope, re.geo_json, re.status, re.created_at, re.source_id,
            s.name AS source_name, s.calendar_source_name AS source_calendar_name
     FROM raw_events re LEFT JOIN sources s ON re.source_id = s.id WHERE re.id = ?`, [id]
  ) as any;
  if (!event) return Response.json({ error: 'Not found' }, { status: 404 });

  let user: Awaited<ReturnType<typeof getAuthUser>> = null;
  if (event.status !== 'approved') {
    if (!req.headers.get('authorization')) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    user = await getAuthUser(req);
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (!(await canAccessSource(user, Number(event.source_id)))) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  const parsed = {
    ...event,
    sponsors:      pj(event.sponsors,      []),
    post_type_ids: pj(event.post_type_ids, []),
    sessions:      pj(event.sessions,      []),
    buttons:       pj(event.buttons,       []),
    geo_json:      pj(event.geo_json,      null),
  };

  return Response.json(parsed, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': user ? 'private, no-store' : 'public, s-maxage=60, stale-while-revalidate=120',
    },
  });
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const user = await getAuthUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await context.params;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const edits = body?.edits ?? {};
  if (edits === null || typeof edits !== 'object' || Array.isArray(edits)) {
    return Response.json({ error: 'edits must be an object' }, { status: 400 });
  }
  if (edits.event_type !== undefined && !isEventType(edits.event_type)) {
    return Response.json({ error: 'Invalid event type' }, { status: 400 });
  }

  const [[event]] = await pool.query('SELECT * FROM raw_events WHERE id = ?', [id]) as any;
  if (!event) return Response.json({ error: 'Not found' }, { status: 404 });
  if (!(await canAccessSource(user, Number(event.source_id)))) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  if (!event.communityhub_post_id) return Response.json({ error: 'Not yet submitted' }, { status: 400 });
  if (!['approved', 'resubmitted'].includes(event.status)) {
    return Response.json({ error: 'Only published events can be updated through this endpoint' }, { status: 409 });
  }

  const [[dbUser]] = await pool.query('SELECT id FROM users WHERE firebase_uid = ?', [user.uid]) as any;
  const editableFields = ['event_type','title','description','extended_description','sessions','location_type',
    'location','place_id','place_name','room_num','url_link','sponsors','post_type_ids','geo_scope',
    'contact_email','phone','website','image_cdn_url','buttons','display','screen_ids'];

  const updateFields = Object.keys(edits).filter(field => editableFields.includes(field));
  if (updateFields.length === 0) {
    return Response.json({ error: 'No valid fields' }, { status: 400 });
  }

  const base = process.env.NEXT_PUBLIC_APP_URL || 'https://ai-microgrant-research-oberlin.vercel.app';
  const merged = { ...event, ...Object.fromEntries(updateFields.map(field => [field, edits[field]])) };
  let imageDataEdit: string | null | undefined;
  if (typeof merged.image_cdn_url === 'string' && merged.image_cdn_url.startsWith('data:')) {
    const dataUri = merged.image_cdn_url;
    if (!/^data:image\/(?:jpeg|png|gif|webp);base64,[A-Za-z0-9+/=\s]+$/.test(dataUri)) {
      return Response.json({ error: 'Invalid image data URI' }, { status: 422 });
    }
    if (Buffer.byteLength(dataUri, 'utf8') > 8 * 1024 * 1024) {
      return Response.json({ error: 'Image data exceeds the 8 MB limit' }, { status: 413 });
    }
    imageDataEdit = dataUri;
    merged.image_data = dataUri;
    merged.image_cdn_url = `${base.replace(/\/$/, '')}/api/events/${id}/poster.jpg`;
  } else if (edits.image_cdn_url !== undefined) {
    // Selecting a new external image must not keep serving stale embedded data.
    imageDataEdit = null;
  }
  let canonicalPayload;
  try {
    canonicalPayload = buildCommunityHubPayload({
      ...merged,
      email:
        process.env.COMMUNITYHUB_EMAIL?.trim()
        || merged.email
        || process.env.ADMIN_EMAIL?.trim()
        || '',
    });
  } catch (error) {
    if (error instanceof CommunityHubPayloadValidationError) {
      return Response.json({
        error: 'CommunityHub payload validation failed',
        validation_errors: error.issues,
      }, { status: 422 });
    }
    throw error;
  }

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
      place_id:'placeId', place_name:'placeName', room_num:'roomNum', url_link:'urlLink', sponsors:'sponsors',
      post_type_ids:'postTypeId', contact_email:'contactEmail', phone:'phone',
      website:'website', image_cdn_url:'image_cdn_url', buttons:'buttons', display:'display', screen_ids:'screensIds',
    };
    const chEdits: Record<string,any> = {};
    for (const [k] of Object.entries(edits)) {
      if (!fieldMap[k]) continue;
      const chKey = fieldMap[k];
      chEdits[chKey] = (canonicalPayload as any)[chKey];
    }

    let chData: any = null;
    if (Object.keys(chEdits).length > 0) {
      const chRes = await fetch(`${CH_BASE}/post/${event.communityhub_post_id}/submit`, {
        method:'PATCH',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify(chEdits),
        signal: AbortSignal.timeout(30_000),
      });
      const rawText = await chRes.text();
      try { chData = JSON.parse(rawText); } catch { chData = { raw: rawText.slice(0, 200) }; }
      if (!chRes.ok) throw new Error(`CommunityHub ${chRes.status}: ${chData.raw ?? JSON.stringify(chData)}`);
    }
    const setParts = updateFields.map(k => `${k} = ?`);
    const setVals = updateFields.map(field => {
      if (field === 'image_cdn_url' && imageDataEdit) return null;
      const chKey = fieldMap[field];
      const value = chKey ? (canonicalPayload as any)[chKey] : edits[field];
      if (value !== null && typeof value === 'object') return JSON.stringify(value);
      return value ?? null;
    });
    if (imageDataEdit !== undefined) {
      setParts.push('image_data = ?');
      setVals.push(imageDataEdit);
    }
    const setClauses = setParts.join(', ');
    if (setClauses) {
      await conn.query(
        `UPDATE raw_events SET ${setClauses}, status='approved' WHERE id=?`,
        [...setVals, id],
      );
    }
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
