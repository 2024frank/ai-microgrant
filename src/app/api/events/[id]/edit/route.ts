import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { forbidden, getAuthUser, unauthorized } from '@/lib/auth';
import { isEventType } from '@/lib/eventTypes';
import { validateCommunityHubPayload } from '@/lib/communityHubPayload';
import { canAccessSource } from '@/lib/reviewerAccess';

const FIELD_TO_PAYLOAD: Record<string, string> = {
  event_type: 'eventType',
  title: 'title',
  description: 'description',
  extended_description: 'extendedDescription',
  sessions: 'sessions',
  location_type: 'locationType',
  location: 'location',
  place_id: 'placeId',
  place_name: 'placeName',
  room_num: 'roomNum',
  url_link: 'urlLink',
  sponsors: 'sponsors',
  post_type_ids: 'postTypeId',
  contact_email: 'contactEmail',
  phone: 'phone',
  website: 'website',
  image_cdn_url: 'image_cdn_url',
  buttons: 'buttons',
  display: 'display',
  screen_ids: 'screensIds',
  calendar_source_name: 'calendarSourceName',
  calendar_source_url: 'calendarSourceUrl',
};

function storedValue(field: string, rawValue: unknown, normalizedPayload: any) {
  const value = FIELD_TO_PAYLOAD[field]
    ? normalizedPayload[FIELD_TO_PAYLOAD[field]]
    : rawValue;
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return value === null || value === undefined ? '' : String(value);
}

/**
 * POST /api/events/:id/edit
 *
 * Save field edits to a pending event and record them as
 * reviewer feedback. Used when a reviewer or editor wants to
 * fix an event's fields without immediately approving it.
 *
 * Every saved edit is written to field_edit_log. The feedback policy may use
 * repeated, stable corrections as future extraction guidance.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();

  const { id } = await context.params;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const edits = body?.edits ?? {};
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 2000) : '';
  if (edits === null || typeof edits !== 'object' || Array.isArray(edits)) {
    return Response.json({ error: 'edits must be an object' }, { status: 400 });
  }
  if (edits.event_type !== undefined && !isEventType(edits.event_type)) {
    return Response.json({ error: 'Invalid event type' }, { status: 400 });
  }

  const [[event]] = await pool.query(
    `SELECT re.*, s.agent_id FROM raw_events re
     JOIN sources s ON re.source_id = s.id WHERE re.id = ?`, [id]
  ) as any;
  if (!event) return Response.json({ error: 'Not found' }, { status: 404 });
  if (!await canAccessSource(user, Number(event.source_id))) return forbidden();
  if (event.status !== 'pending') {
    return Response.json({
      error: 'Only pending events can be edited here; published events use the CommunityHub update endpoint',
    }, { status: 409 });
  }

  const [[dbUser]] = await pool.query(
    'SELECT id FROM users WHERE firebase_uid = ?', [user.uid]
  ) as any;
  const reviewerId = dbUser?.id;

  const editableFields = [
    'event_type', 'title', 'description', 'extended_description', 'sessions',
    'location_type', 'location', 'place_id', 'place_name', 'room_num', 'url_link',
    'sponsors', 'post_type_ids', 'geo_scope', 'contact_email',
    'phone', 'website', 'image_cdn_url', 'buttons', 'display', 'screen_ids',
    'calendar_source_name', 'calendar_source_url',
  ];

  const proposedEvent = {
    ...event,
    email:
      process.env.COMMUNITYHUB_EMAIL?.trim()
      || event.email
      || process.env.ADMIN_EMAIL?.trim()
      || '',
  };
  for (const field of editableFields) {
    if (edits[field] !== undefined) proposedEvent[field] = edits[field];
  }
  const payloadValidation = validateCommunityHubPayload(proposedEvent);
  const validationErrors = payloadValidation.success ? [] : payloadValidation.errors;
  const normalizedPayload = payloadValidation.success
    ? payloadValidation.data
    : payloadValidation.normalized;

  const changedFields: string[] = [];
  const conn = await pool.getConnection();
  try {
    await (conn as any).beginTransaction();

    const [[lockedEvent]] = await conn.query(
      `SELECT id FROM raw_events
       WHERE id=? AND status='pending'
       LIMIT 1 FOR UPDATE`,
      [id],
    ) as any;
    if (!lockedEvent) {
      await (conn as any).rollback();
      return Response.json({ error: 'Event is no longer editable' }, { status: 409 });
    }

    const setClauses: string[] = [];
    const setVals: any[]       = [];

    for (const field of editableFields) {
      if (edits[field] === undefined) continue;
      const oldVal = String(event[field] ?? '');
      const newVal = storedValue(field, edits[field], normalizedPayload);

      if (oldVal !== newVal) {
        changedFields.push(field);
        setClauses.push(`${field} = ?`);
        setVals.push(newVal);

        // Preserve the exact before/after example for the feedback policy.
        await conn.query(
          `INSERT INTO field_edit_log
             (raw_event_id, source_id, reviewer_id, field_name, old_value, new_value)
           VALUES (?,?,?,?,?,?)`,
          [id, event.source_id, reviewerId, field, oldVal, newVal]
        );
      }
    }

    if (setClauses.length > 0 || editableFields.some(field => edits[field] !== undefined)) {
      setClauses.push('validation_errors = ?');
      setVals.push(JSON.stringify(validationErrors), id);
      await conn.query(
        `UPDATE raw_events SET ${setClauses.join(', ')} WHERE id = ?`,
        setVals
      );
    }

    // Keep a reviewer-readable correction record alongside the exact field log.
    if (changedFields.length > 0) {
      const correctionLines = changedFields.map(f => {
        const oldV = String(event[f] ?? '').slice(0, 300);
        const newV = storedValue(f, edits[f], normalizedPayload).slice(0, 300);
        return `${f}: was "${oldV}" → corrected to "${newV}"`;
      });
      const fullNote = note.trim()
        ? `${note.trim()} | ${correctionLines.join(' | ')}`
        : `Human correction: ${correctionLines.join(' | ')}`;

      await conn.query(
        `INSERT INTO rejection_log
           (raw_event_id, source_id, reviewer_id, reason_codes, reviewer_note, event_title, event_snapshot)
         VALUES (?,?,?,?,?,?,?)`,
        [
          id, event.source_id, reviewerId,
          JSON.stringify(['field_correction']),
          fullNote,
          event.title,
          JSON.stringify(event),
        ]
      );
    }

    await (conn as any).commit();

    // Return the updated event
    const [[updated]] = await pool.query(
      'SELECT * FROM raw_events WHERE id = ?', [id]
    ) as any;

    return Response.json({
      ok:             true,
      changed_fields: changedFields,
      event:          updated,
      validation_errors: validationErrors,
      ready_to_publish: validationErrors.length === 0,
      feedback_recorded: changedFields.length > 0,
    });
  } catch (err: any) {
    await (conn as any).rollback();
    return Response.json({ error: err.message }, { status: 500 });
  } finally {
    (conn as any).release();
  }
}
