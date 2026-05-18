import { NextRequest } from 'next/server';
import pool from '@/lib/db';

/**
 * POST /api/ingest/:slug
 *
 * Public endpoint — no auth, no secret.
 * The slug IS the identifier. Agents POST their extracted events here.
 *
 * Body:
 * {
 *   events: Event[],          // array of extracted events (camelCase)
 *   source_name?: string,     // optional — for logging
 *   count?: number            // optional — agent's own count for verification
 * }
 *
 * Response:
 * { ok: true, run_id: number, inserted: number, pending_review: number }
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ slug: string }> }
) {
  const { slug } = await context.params;

  // Look up source by slug
  const [[source]] = await pool.query(
    'SELECT * FROM sources WHERE slug = ?', [slug]
  ) as any;

  if (!source) {
    return Response.json(
      { error: `No active source found for slug: ${slug}` },
      { status: 404 }
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const events: any[] = body.events || [];
  const agentCount: number = body.count ?? events.length;

  if (!Array.isArray(events) || events.length === 0) {
    // Agent called in but found nothing — still record the run
    const [runRes] = await pool.query(
      `INSERT INTO agent_runs (source_id, status, started_at, finished_at, events_found, events_extracted)
       VALUES (?, 'completed', NOW(), NOW(), 0, 0)`,
      [source.id]
    ) as any;
    return Response.json({ ok: true, run_id: runRes.insertId, inserted: 0, message: 'No events in payload' });
  }

  // Create agent_run record
  const [runRes] = await pool.query(
    `INSERT INTO agent_runs (source_id, status, started_at, events_found)
     VALUES (?, 'running', NOW(), ?)`,
    [source.id, agentCount]
  ) as any;
  const runId = runRes.insertId;

  // Write events inside a transaction
  const conn = await pool.getConnection();
  let inserted = 0;
  try {
    await (conn as any).beginTransaction();

    for (const ev of events) {
      // If this event resolves a correction request, find the matching needs_fix entry.
      // Primary lookup: by raw_event_id (exact match from fix-queue response).
      // Fallback: by calendar_source_url, in case the agent submitted the wrong ID.
      const fixedFromId: number | null = ev.fixedFromEventId ? parseInt(ev.fixedFromEventId) : null;
      let fixEntry: any = null;
      if (fixedFromId) {
        const [[row]] = await conn.query(
          'SELECT * FROM needs_fix WHERE raw_event_id = ?', [fixedFromId]
        ) as any;
        fixEntry = row || null;
      }
      if (!fixEntry && ev.calendarSourceUrl) {
        const [[row]] = await conn.query(
          `SELECT nf.* FROM needs_fix nf
           JOIN raw_events re ON re.id = nf.raw_event_id
           WHERE re.calendar_source_url = ?
           LIMIT 1`,
          [ev.calendarSourceUrl]
        ) as any;
        fixEntry = row || null;
      }

      const [res] = await conn.query(
        `INSERT INTO raw_events (
          source_id, agent_run_id, event_type, title, description,
          extended_description, sponsors, post_type_ids, sessions,
          location_type, location, place_id, place_name, room_num,
          url_link, display, screen_ids, buttons, contact_email,
          phone, website, image_cdn_url, calendar_source_name,
          calendar_source_url, geo_scope, geo_json,
          corrected_from_id, sent_for_fix_by, status
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')`,
        [
          source.id, runId,
          ev.eventType       || 'ot',
          ev.title           || 'Untitled',
          ev.description     || '',
          ev.extendedDescription  || null,
          JSON.stringify(ev.sponsors     || []),
          JSON.stringify(ev.postTypeId   || []),
          JSON.stringify(ev.sessions     || []),
          ev.locationType    || 'ne',
          ev.location        || null,
          ev.placeId         || null,
          ev.placeName       || null,
          ev.roomNum         || null,
          ev.urlLink         || null,
          ev.display         || 'all',
          JSON.stringify(ev.screensIds   || []),
          JSON.stringify(ev.buttons      || []),
          ev.contactEmail    || null,
          ev.phone           || null,
          ev.website         || null,
          ev.image_cdn_url   || null,
          ev.calendarSourceName || source.calendar_source_name || source.name,
          ev.calendarSourceUrl  || null,
          ev.geo_scope       || null,
          ev.geo ? JSON.stringify(ev.geo) : null,
          fixedFromId,
          fixEntry?.sent_by_email || null,
        ]
      ) as any;

      const eventId = res.insertId;
      const ingestedPostUrl = `${process.env.NEXT_PUBLIC_APP_URL}/events/${eventId}`;
      await conn.query(
        'UPDATE raw_events SET ingested_post_url = ? WHERE id = ?',
        [ingestedPostUrl, eventId]
      );

      // If this resolves a fix request: remove original pending_fix event, clean needs_fix, notify sender
      if (fixedFromId && fixEntry) {
        await conn.query('DELETE FROM needs_fix WHERE raw_event_id = ?', [fixedFromId]);
        // Remove the original pending_fix event so only the corrected version stays in the queue
        await conn.query('DELETE FROM raw_events WHERE id = ? AND status = ?', [fixedFromId, 'pending_fix']);
        if (fixEntry.sent_by_user_id) {
          const notifTitle = `Fixed: ${ev.title || 'Event'}`;
          const parts: string[] = [];
          if (fixEntry.correction_notes) parts.push(`You asked: ${fixEntry.correction_notes}`);
          if (ev.fixSummary) parts.push(`Fixed: ${ev.fixSummary}`);
          if (!parts.length) parts.push('The corrected event is ready to review.');
          await conn.query(
            `INSERT INTO notifications (user_id, type, title, message, raw_event_id)
             VALUES (?, 'event_fixed', ?, ?, ?)`,
            [fixEntry.sent_by_user_id, notifTitle, parts.join(' · '), eventId]
          );
        }
      }

      inserted++;
    }

    await (conn as any).commit();
  } catch (err: any) {
    await (conn as any).rollback();
    await pool.query(
      `UPDATE agent_runs SET status='failed', finished_at=NOW(), error_log=? WHERE id=?`,
      [JSON.stringify([err.message]), runId]
    );
    return Response.json({ error: `DB error: ${err.message}` }, { status: 500 });
  } finally {
    (conn as any).release();
  }

  // Mark this run complete
  await pool.query(
    `UPDATE agent_runs SET status='completed', finished_at=NOW(),
     events_found=?, events_extracted=? WHERE id=?`,
    [agentCount, inserted, runId]
  );

  // Close any other stale running sessions for this source (agent is done)
  await pool.query(
    `UPDATE agent_runs SET status='completed', finished_at=NOW()
     WHERE source_id=? AND status='running' AND id != ?`,
    [source.id, runId]
  );

  // Notify all active reviewers and admins about new events (skip fixed-events source,
  // which has its own per-reviewer notification flow)
  if (inserted > 0 && source.slug !== 'fixed-events') {
    const [[{ pending }]] = await pool.query(
      `SELECT COUNT(*) AS pending FROM raw_events WHERE status IN ('pending','pending_fix')`
    ) as any;
    const [reviewers] = await pool.query(
      `SELECT id FROM users WHERE active = 1`
    ) as any;
    if ((reviewers as any[]).length > 0) {
      const notifTitle   = `${inserted} new event${inserted !== 1 ? 's' : ''} from ${source.name}`;
      const notifMessage = `${pending} event${pending !== 1 ? 's' : ''} total waiting for review`;
      const values = (reviewers as any[]).map((u: any) =>
        `(${u.id}, 'new_events', ${pool.escape(notifTitle)}, ${pool.escape(notifMessage)}, NULL)`
      ).join(', ');
      await pool.query(
        `INSERT INTO notifications (user_id, type, title, message, raw_event_id) VALUES ${values}`
      );
    }
  }

  console.log(`[ingest] source=${source.name} slug=${slug} run=${runId} inserted=${inserted}`);

  return Response.json({
    ok:             true,
    run_id:         runId,
    source:         source.name,
    inserted,
    pending_review: inserted,
    message:        `${inserted} events queued for review`,
  });
}

// Allow CORS so agents can POST from anywhere
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
