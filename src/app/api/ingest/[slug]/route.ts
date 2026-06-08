import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { sendReviewNotification } from '@/lib/email';
import { mergePosterImages } from '@/lib/mergePosters';

const MAX_EVENTS_PER_INGEST = 200;

// Sanitise a string field: strip NUL bytes, truncate to maxLen
function san(v: unknown, maxLen: number): string | null {
  if (v == null) return null;
  const s = String(v).replace(/\0/g, '').trim();
  return s.length > 0 ? s.slice(0, maxLen) : null;
}

/**
 * POST /api/ingest/:slug
 *
 * Requires x-ingest-secret header matching INGEST_SECRET env var.
 *
 * Body: { events: Event[], count?: number }
 * Response: { ok: true, run_id: number, inserted: number }
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ slug: string }> }
) {
  // ── auth ──────────────────────────────────────────────────────────
  const secret = req.headers.get('x-ingest-secret');
  if (!secret || secret !== process.env.INGEST_SECRET) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { slug } = await context.params;

  // Look up source by slug — don't reveal which slug failed
  const [[source]] = await pool.query(
    'SELECT * FROM sources WHERE slug = ? AND active = 1', [slug]
  ) as any;
  if (!source) return Response.json({ error: 'Not found' }, { status: 404 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const events: any[] = Array.isArray(body.events) ? body.events : [];
  const agentCount: number = body.count ?? events.length;

  // ── payload size guard ────────────────────────────────────────────
  if (events.length > MAX_EVENTS_PER_INGEST) {
    return Response.json(
      { error: `Too many events — max ${MAX_EVENTS_PER_INGEST} per request` },
      { status: 422 }
    );
  }

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

      // If agent passed poster_urls, merge them into a single base64 image.
      // base64 images go into image_data; image_cdn_url stores a public URL.
      let imageData: string | null = null;
      let imageCdnUrl = san(ev.image_cdn_url, 500);
      if (Array.isArray(ev.poster_urls) && ev.poster_urls.length > 0) {
        const merged = await mergePosterImages(ev.poster_urls);
        if (merged) { imageData = merged; imageCdnUrl = null; }
      } else if (imageCdnUrl?.startsWith('data:')) {
        imageData = imageCdnUrl;
        imageCdnUrl = null;
      }

      const [res] = await conn.query(
        `INSERT INTO raw_events (
          source_id, agent_run_id, event_type, title, description,
          extended_description, sponsors, post_type_ids, sessions,
          location_type, location, place_id, place_name, room_num,
          url_link, display, screen_ids, buttons, contact_email, email,
          phone, website, image_cdn_url, image_data, calendar_source_name,
          calendar_source_url, geo_scope, geo_json,
          corrected_from_id, sent_for_fix_by, status
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')`,
        [
          source.id, runId,
          ['ot','ev','cl','ex','vt','sp','pe','wk','ms','ws','an'].includes(ev.eventType) ? ev.eventType : 'ot',
          san(ev.title, 200)           || 'Untitled',
          san(ev.description, 2000)    || '',
          san(ev.extendedDescription, 5000),
          JSON.stringify(Array.isArray(ev.sponsors)   ? ev.sponsors.slice(0,20)   : []),
          JSON.stringify(Array.isArray(ev.postTypeId) ? ev.postTypeId.slice(0,20) : []),
          JSON.stringify(Array.isArray(ev.sessions)   ? ev.sessions.slice(0,50)   : []),
          ['ph','on','bo','ne'].includes(ev.locationType) ? ev.locationType : 'ne',
          san(ev.location, 300),
          san(ev.placeId,  100),
          san(ev.placeName,200),
          san(ev.roomNum,  50),
          san(ev.urlLink,  500),
          ['all','screen','none'].includes(ev.display) ? ev.display : 'all',
          JSON.stringify(Array.isArray(ev.screensIds) ? ev.screensIds.slice(0,20) : []),
          JSON.stringify(Array.isArray(ev.buttons)    ? ev.buttons.slice(0,10)    : []),
          san(ev.contactEmail, 150),
          san(ev.email, 150)           || 'fkusiapp@Oberlin.edu',
          san(ev.phone,   30),
          san(ev.website, 500),
          imageCdnUrl,
          imageData,
          san(ev.calendarSourceName || source.calendar_source_name || source.name, 200),
          san(ev.calendarSourceUrl, 500),
          ['local','hyper_local','regional','national'].includes(ev.geo_scope) ? ev.geo_scope : null,
          ev.geo ? JSON.stringify(ev.geo) : null,
          fixedFromId,
          san(fixEntry?.sent_by_email, 150),
        ]
      ) as any;

      const eventId = res.insertId;
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://ai-microgrant-research-oberlin.vercel.app';
      const ingestedPostUrl = `${appUrl}/events/${eventId}`;
      // If we stored a base64 image, set image_cdn_url to the serving endpoint URL
      const imageServingUrl = imageData ? `${appUrl}/api/events/${eventId}/image` : null;
      await conn.query(
        'UPDATE raw_events SET ingested_post_url = ?, image_cdn_url = COALESCE(?, image_cdn_url) WHERE id = ?',
        [ingestedPostUrl, imageServingUrl, eventId]
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

  // Email all active users about new events (skip fixed-events,
  // which has its own per-reviewer bell notification flow)
  if (inserted > 0 && source.slug !== 'fixed-events') {
    const [[{ pending }]] = await pool.query(
      `SELECT COUNT(*) AS pending FROM raw_events WHERE status IN ('pending','pending_fix')`
    ) as any;
    const [reviewers] = await pool.query(
      `SELECT id, email, full_name FROM users WHERE active = 1`
    ) as any;
    // Pending count broken down by source
    const [pendingBySource] = await pool.query(
      `SELECT s.name, COUNT(*) AS pending
       FROM raw_events re JOIN sources s ON s.id = re.source_id
       WHERE re.status IN ('pending','pending_fix')
       GROUP BY s.id, s.name`
    ) as any;
    const pendingMap: Record<string, number> = {};
    for (const row of pendingBySource as any[]) pendingMap[row.name] = Number(row.pending);

    // Build event preview from the events we just inserted (first 5 titles)
    const previewEvents = events.slice(0, 5).map((ev: any) => ({
      title:  String(ev.title || 'Untitled').slice(0, 80),
      source: source.name,
    }));
    for (const u of reviewers as any[]) {
      sendReviewNotification({
        reviewerEmail: u.email,
        reviewerName:  u.full_name,
        pendingCount:  pending,
        sources:       [{ name: source.name, count: inserted, pending: pendingMap[source.name] ?? inserted }],
        oldestDate:    null,
        previewEvents,
      }).catch((err: Error) => console.error(`[ingest] email failed for ${u.email}:`, err.message));
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
