import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { getAuthUser, reviewerSourceScope, unauthorized } from '@/lib/auth';

/**
 * POST /api/events/:id/edit
 *
 * Save field edits to an event (any status) and log them as
 * agent teaching data. Used when a reviewer or editor wants
 * to fix an event's fields without immediately approving it.
 *
 * Every saved edit is written to field_edit_log so the agent
 * learns from it on its next run.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();

  const { id } = await context.params;
  const { edits = {}, note = '' } = await req.json();
  const { clause: scopeClause, params: scopeParams } = reviewerSourceScope(user, 're');

  const [[event]] = await pool.query(
    `SELECT re.*, s.agent_id FROM raw_events re
     JOIN sources s ON re.source_id = s.id WHERE re.id = ? ${scopeClause}`,
    [id, ...scopeParams]
  ) as any;
  if (!event) return Response.json({ error: 'Not found' }, { status: 404 });
  const reviewerId = user.id;

  const editableFields = [
    'title', 'description', 'extended_description', 'sessions',
    'location_type', 'location', 'place_name', 'room_num', 'url_link',
    'sponsors', 'post_type_ids', 'geo_scope', 'contact_email',
    'phone', 'website', 'image_cdn_url', 'buttons', 'display', 'calendar_source_name', 'calendar_source_url',
  ];

  const changedFields: string[] = [];
  const conn = await pool.getConnection();
  try {
    await (conn as any).beginTransaction();

    const setClauses: string[] = [];
    const setVals: any[]       = [];

    for (const field of editableFields) {
      if (edits[field] === undefined) continue;
      const oldVal = String(event[field] ?? '');
      const newVal = typeof edits[field] === 'object'
        ? JSON.stringify(edits[field])
        : String(edits[field]);

      if (oldVal !== newVal) {
        changedFields.push(field);
        setClauses.push(`${field} = ?`);
        setVals.push(newVal);

        // Log for agent learning
        await conn.query(
          `INSERT INTO field_edit_log
             (raw_event_id, source_id, reviewer_id, field_name, old_value, new_value)
           VALUES (?,?,?,?,?,?)`,
          [id, event.source_id, reviewerId, field, oldVal, newVal]
        );
      }
    }

    if (setClauses.length > 0) {
      setVals.push(id);
      await conn.query(
        `UPDATE raw_events SET ${setClauses.join(', ')} WHERE id = ?`,
        setVals
      );
    }

    // Always log field corrections to rejection_log — this is the agent's primary
    // teaching signal. Include old → new values so the agent learns exactly what
    // was wrong, not just which fields changed.
    if (changedFields.length > 0) {
      const correctionLines = changedFields.map(f => {
        const oldV = String(event[f] ?? '').slice(0, 300);
        const newV = (typeof edits[f] === 'object'
          ? JSON.stringify(edits[f])
          : String(edits[f] ?? '')).slice(0, 300);
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
      // Return the agent_id so frontend can show "agent will learn from this"
      agent_id:       event.agent_id,
    });
  } catch (err: any) {
    await (conn as any).rollback();
    return Response.json({ error: err.message }, { status: 500 });
  } finally {
    (conn as any).release();
  }
}
