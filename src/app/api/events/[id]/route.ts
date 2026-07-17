import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { getAuthUser } from '@/lib/auth';
import { isEventType } from '@/lib/eventTypes';
import { canAccessSource } from '@/lib/reviewerAccess';
import { createEventMediaToken } from '@/lib/eventMediaToken';
import { fieldAuditValue } from '@/lib/fieldAuditValue';
import { eventImageEditErrorStatus, normalizeEventImageEdit } from '@/lib/eventImageEdits';
import {
  CommunityHubUpdateConflictError,
  deliverCommunityHubUpdate,
  prepareCommunityHubUpdate,
  type CommunityHubUpdateAuditEntry,
} from '@/lib/communityHubUpdates';
import {
  buildCommunityHubPayload,
  CommunityHubPayloadValidationError,
} from '@/lib/communityHubPayload';

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
            re.geo_scope, re.geo_json, re.status, re.sent_for_correction,
            re.communityhub_post_id, re.communityhub_moderation_status,
            re.communityhub_checked_at, re.communityhub_moderation_error,
            re.superseded_by_id, re.created_at, re.source_id,
            s.name AS source_name, s.calendar_source_name AS source_calendar_name,
            s.source_kind AS source_kind, s.source_type AS source_type
     FROM raw_events re LEFT JOIN sources s ON re.source_id = s.id WHERE re.id = ?`, [id]
  ) as any;
  if (!event) return Response.json({ error: 'Not found' }, { status: 404 });

  let user: Awaited<ReturnType<typeof getAuthUser>> = null;
  const publiclyApproved = event.status === 'approved'
    && event.communityhub_moderation_status === 'approved';
  if (!publiclyApproved) {
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
    // Where this record came from (2026-07-16 meeting, item 10): a direct
    // human calendar submission never exists in this table, so every row is
    // either an original-organization integration or an aggregator.
    collected_via: event.source_type === 'email'
      ? 'organization_email'
      : event.source_kind === 'aggregator'
        ? 'aggregator'
        : 'original_organization',
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
  if (!['approved', 'resubmitted'].includes(event.status)
      || event.communityhub_moderation_status !== 'approved') {
    return Response.json({ error: 'Only published events can be updated through this endpoint' }, { status: 409 });
  }

  const editableFields = ['event_type','title','description','extended_description','sessions','location_type',
    'location','place_id','place_name','room_num','url_link','sponsors','post_type_ids','geo_scope',
    'contact_email','phone','website','image_cdn_url','buttons','display','screen_ids'];

  const updateFields = Object.keys(edits).filter(field => editableFields.includes(field));
  if (updateFields.length === 0) {
    return Response.json({ error: 'No valid fields' }, { status: 400 });
  }

  const base = process.env.APP_URL
    || process.env.NEXT_PUBLIC_APP_URL
    || 'https://ai-microgrant-research-oberlin.vercel.app';
  const merged = { ...event, ...Object.fromEntries(updateFields.map(field => [field, edits[field]])) };
  let imageDataEdit: string | null | undefined;
  if (edits.image_cdn_url !== undefined) {
    try {
      const normalizedImage = await normalizeEventImageEdit(edits.image_cdn_url);
      imageDataEdit = normalizedImage.imageData;
      merged.image_cdn_url = normalizedImage.imageCdnUrl;
    } catch (error) {
      const status = eventImageEditErrorStatus(error);
      return Response.json({
        error: error instanceof Error ? error.message : 'Invalid embedded image',
      }, { status });
    }
    if (imageDataEdit) {
      merged.image_data = imageDataEdit;
      const mediaToken = createEventMediaToken(id, imageDataEdit);
      merged.image_cdn_url = `${base.replace(/\/$/, '')}/api/events/${id}/poster.jpg?media_token=${encodeURIComponent(mediaToken)}`;
    } else {
      // Selecting or clearing an external image must not keep stale embedded data.
      merged.image_data = null;
    }
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

  const fieldMap: Record<string,string> = {
    event_type:'eventType', title:'title', description:'description', extended_description:'extendedDescription',
    sessions:'sessions', location_type:'locationType', location:'location',
    place_id:'placeId', place_name:'placeName', room_num:'roomNum', url_link:'urlLink', sponsors:'sponsors',
    post_type_ids:'postTypeId', contact_email:'contactEmail', phone:'phone',
    website:'website', image_cdn_url:'image_cdn_url', buttons:'buttons', display:'display', screen_ids:'screensIds',
  };
  const chEdits: Record<string, unknown> = {};
  const localEdits: Record<string, unknown> = {};
  const auditEntries: CommunityHubUpdateAuditEntry[] = [];
  const nullableFields = new Set([
    'extended_description', 'location', 'place_id', 'place_name', 'room_num',
    'contact_email', 'image_cdn_url',
  ]);
  for (const field of updateFields) {
    const chKey = fieldMap[field];
    const requestedValue = edits[field];
    const clearsNullableField = nullableFields.has(field)
      && (requestedValue === null
        || (typeof requestedValue === 'string' && requestedValue.trim() === ''));
    const localValue = field === 'image_cdn_url' && imageDataEdit
      ? null
      : clearsNullableField
        ? null
        : chKey ? (canonicalPayload as any)[chKey] : edits[field];
    const auditNewValue = field === 'image_cdn_url' && imageDataEdit
      ? imageDataEdit
      : localValue;
    localEdits[field] = localValue;
    if (storedComparable(event[field]) !== storedComparable(auditNewValue)) {
      auditEntries.push({
        field,
        oldValue: fieldAuditValue(event[field]),
        newValue: fieldAuditValue(auditNewValue),
      });
    }
    if (chKey) {
      // CommunityHub PATCH distinguishes an omitted key (leave unchanged)
      // from an explicit empty string (clear an optional text field).
      chEdits[chKey] = clearsNullableField ? '' : (canonicalPayload as any)[chKey];
    }
  }
  if (imageDataEdit !== undefined) localEdits.image_data = imageDataEdit;

  // geo_scope is local review metadata and does not exist in CommunityHub's
  // PATCH contract. Apply a local-only change atomically without re-moderation.
  if (Object.keys(chEdits).length === 0) {
    const conn = await pool.getConnection();
    try {
      await (conn as any).beginTransaction();
      const fields = Object.keys(localEdits);
      const [updated] = await conn.query(
        `UPDATE raw_events SET ${fields.map(field => `${field}=?`).join(',')}
         WHERE id=? AND communityhub_post_id=? AND status=?`,
        [
          ...fields.map(field => databaseStoredValue(localEdits[field])),
          id,
          event.communityhub_post_id,
          event.status,
        ],
      ) as any;
      if (Number(updated?.affectedRows || 0) !== 1) {
        await (conn as any).rollback();
        return Response.json({ error: 'Event changed before the update could be saved' }, { status: 409 });
      }
      for (const entry of auditEntries) {
        await conn.query(
          `INSERT INTO field_edit_log
           (raw_event_id, source_id, reviewer_id, field_name, old_value, new_value)
           VALUES (?,?,?,?,?,?)`,
          [id, event.source_id, user.id, entry.field, entry.oldValue, entry.newValue],
        );
      }
      await (conn as any).commit();
      return Response.json({ ok: true, status: event.status, communityhub: null });
    } catch (error) {
      await (conn as any).rollback().catch(() => undefined);
      return Response.json({ error: error instanceof Error ? error.message : 'Unable to update event' }, { status: 500 });
    } finally {
      (conn as any).release();
    }
  }

  let prepared: { id: number; operationKey: string };
  try {
    prepared = await prepareCommunityHubUpdate({
      rawEventId: Number(id),
      sourceId: Number(event.source_id),
      communityHubPostId: String(event.communityhub_post_id),
      originalStatus: event.status,
      chEdits,
      localEdits,
      auditEntries,
      reviewerId: user.id,
    });
  } catch (error) {
    if (error instanceof CommunityHubUpdateConflictError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    console.error(`[events/${id}] unable to prepare CommunityHub update:`, error);
    return Response.json({ error: 'Unable to prepare CommunityHub update' }, { status: 500 });
  }

  const delivery = await deliverCommunityHubUpdate(
    prepared.id,
    Number(id),
    String(event.communityhub_post_id),
    chEdits,
    { rollbackOnPermanentFailure: true },
  );
  if (delivery.status === 'succeeded') {
    return Response.json({
      ok: true,
      status: 'submitted',
      moderation_status: 'unknown',
      update_id: prepared.id,
      communityhub: delivery.response ?? null,
    });
  }
  if (delivery.status === 'failed') {
    const remoteMissing = delivery.response_status === 404 || delivery.response_status === 410;
    return Response.json({
      error: delivery.error,
      update_id: prepared.id,
      retry_safe: !remoteMissing,
      ...(remoteMissing ? { moderation_status: 'missing' } : {}),
    }, { status: remoteMissing ? 409 : delivery.response_status && delivery.response_status < 500 ? 422 : 502 });
  }
  return Response.json({
    error: delivery.error || 'CommunityHub update outcome is unresolved',
    update_id: prepared.id,
    submission_state: 'unresolved',
    retry_safe: false,
  }, { status: 502 });
}

function storedComparable(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed !== null && typeof parsed === 'object') return JSON.stringify(parsed);
    } catch {
      // Plain string.
    }
  }
  return String(value);
}

function databaseStoredValue(value: unknown): unknown {
  return value !== null && typeof value === 'object' ? JSON.stringify(value) : value ?? null;
}

function pj(val: any, fallback: any): any {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch { return fallback; }
}
