import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { canReviewSource, forbidden, getAuthUser, unauthorized } from '@/lib/auth';

const CH_BASE = 'https://oberlin.communityhub.cloud/api/legacy/calendar';

// mysql2 auto-parses JSON columns into objects/arrays; if the value is
// already parsed, return it directly — otherwise JSON.parse the string.
function j(val: any, fallback: any = []): any {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'string') { try { return JSON.parse(val); } catch { return fallback; } }
  return val; // already an object/array from mysql2
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();

  const { edits = {}, time_spent_sec = null, action } = await req.json();
  const { id: eventId } = await context.params;

  const [[event]] = await pool.query('SELECT * FROM raw_events WHERE id = ?', [eventId]) as any;
  if (!event) return Response.json({ error: 'Not found' }, { status: 404 });
  if (!(await canReviewSource(user, event.source_id))) return forbidden();

  // Reject: only allowed on pending events
  // Approve/resubmit: allowed from any status (pending, rejected, or re-editing approved events)
  if (action === 'reject' && event.status !== 'pending') {
    return Response.json({ error: 'Can only reject pending events' }, { status: 409 });
  }

  const [[dbUser]] = await pool.query('SELECT id FROM users WHERE firebase_uid = ?', [user.uid]) as any;
  const reviewerId = dbUser?.id;

  const conn = await pool.getConnection();
  try {
    await (conn as any).beginTransaction();

    if (action === 'reject') {
      const { reason_codes, reviewer_note = '' } = edits;
      if (!reason_codes?.length) return Response.json({ error: 'reason_codes required' }, { status: 400 });

      await conn.query("UPDATE raw_events SET status='rejected' WHERE id=?", [eventId]);
      await conn.query(
        `INSERT INTO rejection_log (raw_event_id, source_id, reviewer_id, reason_codes, reviewer_note, event_title, event_snapshot)
         VALUES (?,?,?,?,?,?,?)`,
        [eventId, event.source_id, reviewerId, JSON.stringify(reason_codes), reviewer_note, event.title, JSON.stringify(event)]
      );
      await conn.query(
        `INSERT INTO review_sessions (raw_event_id, reviewer_id, action, time_spent_sec, submitted_to_ch) VALUES (?,?,'rejected',?,0)`,
        [eventId, reviewerId, time_spent_sec]
      );
      await (conn as any).commit();
      return Response.json({ ok: true });
    }

    // APPROVE
    const editableFields = ['title','description','extended_description','sessions','location_type',
      'location','place_name','room_num','url_link','sponsors','post_type_ids','geo_scope',
      'contact_email','phone','website','image_cdn_url','buttons','display'];

    for (const field of editableFields) {
      if (edits[field] !== undefined) {
        const oldVal = String(event[field] ?? '');
        const newVal = String(edits[field]);
        if (oldVal !== newVal) {
          await conn.query(
            `INSERT INTO field_edit_log (raw_event_id, source_id, reviewer_id, field_name, old_value, new_value) VALUES (?,?,?,?,?,?)`,
            [eventId, event.source_id, reviewerId, field, oldVal, newVal]
          );
        }
      }
    }

    // Persist edits back to raw_events so the DB reflects what was approved
    const updateFields = editableFields.filter(f => edits[f] !== undefined);
    if (updateFields.length > 0) {
      const setClauses = updateFields.map(f => `${f} = ?`);
      const setVals: any[] = updateFields.map(f =>
        typeof edits[f] === 'object' ? JSON.stringify(edits[f]) : String(edits[f])
      );
      setVals.push(eventId);
      await conn.query(`UPDATE raw_events SET ${setClauses.join(', ')} WHERE id = ?`, setVals);
    }

    const merged = { ...event, ...edits };
    const payload: any = {
      eventType: merged.event_type, email: process.env.COMMUNITYHUB_EMAIL || 'fkusiapp@oberlin.edu',
      subscribe: true, title: merged.title, description: merged.description,
      sponsors: j(merged.sponsors), postTypeId: j(merged.post_type_ids),
      sessions: j(merged.sessions), locationType: merged.location_type,
      display: merged.display || 'all', screensIds: j(merged.screen_ids),
      public: '1', calendarSourceName: merged.calendar_source_name,
      calendarSourceUrl: merged.calendar_source_url, ingestedPostUrl: merged.ingested_post_url,
    };
    // CommunityHub requires these as empty string, not null/undefined
    payload.phone      = merged.phone      || '';
    payload.website    = merged.website    || '';
    payload.urlLink    = merged.url_link   || '';
    // placeId must always be sent as a string (PHP typed setter rejects null)
    payload.placeId    = merged.place_id   || '';
    if (merged.extended_description) payload.extendedDescription = merged.extended_description;
    if (merged.contact_email) payload.contactEmail = merged.contact_email;
    if (merged.image_cdn_url) payload.imageCdnUrl = merged.image_cdn_url;
    if (merged.buttons) payload.buttons = j(merged.buttons);
    if (merged.place_name) payload.placeName = merged.place_name;
    if (merged.room_num) payload.roomNum = merged.room_num;
    if (['ph2','bo'].includes(merged.location_type)) payload.location = merged.location || '';
    if (['on','bo'].includes(merged.location_type)) payload.urlLink = merged.url_link   || '';

    const chRes  = await fetch(`${CH_BASE}/post/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    // CommunityHub may return HTML on errors — parse safely
    const rawText = await chRes.text();
    let chData: any;
    try { chData = JSON.parse(rawText); } catch { chData = { raw: rawText.slice(0, 200) }; }
    if (!chRes.ok) throw new Error(`CommunityHub ${chRes.status}: ${chData.raw ?? JSON.stringify(chData)}`);

    await conn.query(`UPDATE raw_events SET status='approved', communityhub_post_id=? WHERE id=?`, [chData?.id || null, eventId]);
    await conn.query(
      `INSERT INTO review_sessions (raw_event_id, reviewer_id, action, time_spent_sec, submitted_to_ch, ch_response) VALUES (?,?,'approved',?,1,?)`,
      [eventId, reviewerId, time_spent_sec, JSON.stringify(chData)]
    );

    await (conn as any).commit();
    return Response.json({ ok: true, communityhub: chData });
  } catch (err: any) {
    await (conn as any).rollback();
    return Response.json({ error: err.message }, { status: 500 });
  } finally {
    (conn as any).release();
  }
}
