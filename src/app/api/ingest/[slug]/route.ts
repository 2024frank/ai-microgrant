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
    'SELECT * FROM sources WHERE slug = ? AND active = 1', [slug]
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
      const [res] = await conn.query(
        `INSERT INTO raw_events (
          source_id, agent_run_id, event_type, title, description,
          extended_description, sponsors, post_type_ids, sessions,
          location_type, location, place_id, place_name, room_num,
          url_link, display, screen_ids, buttons, contact_email,
          phone, website, image_cdn_url, calendar_source_name,
          calendar_source_url, geo_scope, geo_json, status
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')`,
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
        ]
      ) as any;

      const eventId = res.insertId;
      const ingestedPostUrl = `${process.env.NEXT_PUBLIC_APP_URL}/events/${eventId}`;
      await conn.query(
        'UPDATE raw_events SET ingested_post_url = ? WHERE id = ?',
        [ingestedPostUrl, eventId]
      );
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

  // Mark run complete
  await pool.query(
    `UPDATE agent_runs SET status='completed', finished_at=NOW(),
     events_found=?, events_extracted=? WHERE id=?`,
    [agentCount, inserted, runId]
  );

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
