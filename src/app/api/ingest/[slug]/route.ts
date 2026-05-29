import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { sendReviewNotification } from '@/lib/email';
import { isValidFixToken } from '@/lib/fixToken';

const MAX_EVENTS_PER_INGEST = 200;

// Sanitise a string field: strip NUL bytes, truncate to maxLen
function san(v: unknown, maxLen: number): string | null {
  if (v == null) return null;
  const s = String(v).replace(/\0/g, '').trim();
  return s.length > 0 ? s.slice(0, maxLen) : null;
}

function parsePositiveInt(v: unknown): number | null {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function conflict(message: string): Error {
  const err = new Error(message) as Error & { statusCode?: number };
  err.statusCode = 409;
  return err;
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
  const isFixedSource = source.slug === 'fixed-events';

  // ── auth ──────────────────────────────────────────────────────────
  const ingestSecret = process.env.INGEST_SECRET?.trim();
  const hasIngestSecret = !!ingestSecret && req.headers.get('x-ingest-secret') === ingestSecret;
  if (!hasIngestSecret) {
    const fixedFromId = events.length === 1 ? parsePositiveInt(events[0]?.fixedFromEventId) : null;
    const fixToken = req.headers.get('x-fix-token');
    if (!isFixedSource || !fixedFromId || !isValidFixToken(fixedFromId, fixToken)) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  // ── payload size guard ────────────────────────────────────────────
  if (events.length > MAX_EVENTS_PER_INGEST) {
    return Response.json(
      { error: `Too many events — max ${MAX_EVENTS_PER_INGEST} per request` },
      { status: 422 }
    );
  }

  if (isFixedSource && events.some(ev => !parsePositiveInt(ev.fixedFromEventId))) {
    return Response.json(
      { error: 'fixed-events ingest requires fixedFromEventId on every event' },
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
      // The dedicated fixed-events source must resolve exactly one queued correction by id.
      const fixedFromId: number | null = isFixedSource ? parsePositiveInt(ev.fixedFromEventId) : null;
      let fixEntry: any = null;
      if (isFixedSource) {
        const [[row]] = await conn.query(
          `SELECT nf.*, re.status AS raw_status
           FROM needs_fix nf
           JOIN raw_events re ON re.id = nf.raw_event_id
           WHERE nf.raw_event_id = ?
           FOR UPDATE`,
          [fixedFromId]
        ) as any;
        fixEntry = row || null;
        if (!fixEntry) throw conflict('No pending correction exists for fixedFromEventId');
        if (fixEntry.raw_status !== 'pending_fix') {
          throw conflict('Original event is no longer pending correction');
        }
      }

      const [res] = await conn.query(
        `INSERT INTO raw_events (
          source_id, agent_run_id, event_type, title, description,
          extended_description, sponsors, post_type_ids, sessions,
          location_type, location, place_id, place_name, room_num,
          url_link, display, screen_ids, buttons, contact_email, email,
          phone, website, image_cdn_url, calendar_source_name,
          calendar_source_url, geo_scope, geo_json,
          corrected_from_id, sent_for_fix_by, status
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')`,
        [
          source.id, runId,
          ['ot','ev','cl','ex','vt','sp','pe','wk','ms','ws'].includes(ev.eventType) ? ev.eventType : 'ot',
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
          san(ev.image_cdn_url, 500),
          san(ev.calendarSourceName || source.calendar_source_name || source.name, 200),
          san(ev.calendarSourceUrl, 500),
          ['local','hyper_local','regional','national'].includes(ev.geo_scope) ? ev.geo_scope : null,
          ev.geo ? JSON.stringify(ev.geo) : null,
          fixedFromId,
          san(fixEntry?.sent_by_email, 150),
        ]
      ) as any;

      const eventId = res.insertId;
      const ingestedPostUrl = `${process.env.NEXT_PUBLIC_APP_URL}/events/${eventId}`;
      await conn.query(
        'UPDATE raw_events SET ingested_post_url = ? WHERE id = ?',
        [ingestedPostUrl, eventId]
      );

      // If this resolves a fix request: remove original pending_fix event, clean needs_fix, notify sender
      if (isFixedSource && fixedFromId && fixEntry) {
        await conn.query('DELETE FROM needs_fix WHERE raw_event_id = ?', [fixedFromId]);
        // Remove the original pending_fix event so only the corrected version stays in the queue
        const [deleteRes] = await conn.query(
          'DELETE FROM raw_events WHERE id = ? AND status = ?',
          [fixedFromId, 'pending_fix']
        ) as any;
        if (deleteRes.affectedRows !== 1) {
          throw conflict('Original event is no longer pending correction');
        }
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
    const status = err.statusCode ?? 500;
    return Response.json(
      { error: status === 500 ? `DB error: ${err.message}` : err.message },
      { status }
    );
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
      'Access-Control-Allow-Headers': 'Content-Type, x-ingest-secret, x-fix-token',
    },
  });
}
