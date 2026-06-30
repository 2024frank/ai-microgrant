import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { parseVeeziSessions, dedupeFilms } from '@/lib/sources/veezi';
import { buildApolloAnnouncements, filmRunsForTracking } from '@/lib/sources/apolloSegments';

/**
 * GET /api/sources/apollo/feed   (x-ingest-secret required)
 *
 * Does ALL of Apollo's extraction deterministically, server-side — the agent
 * never reads Veezi or computes dates:
 *   1. fetch the Veezi sessions page (token stays in env, never in the prompt)
 *   2. parse every film + showtime with the deterministic parser
 *   3. record each film's run for disappearance-based end detection
 *   4. segment into ready-made "Apollo - Showing Now / Coming Soon" payloads
 *
 * Returns { events: [...complete ingest payloads...] }; the agent only adds a
 * poster per movie and POSTs them to /api/ingest/apollo-theater.
 */
const APP_URL = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://ai-microgrant-research-oberlin.vercel.app';
const APOLLO_PAGE = 'https://www.clevelandcinemas.com/our-locations/x03gq-apollo-theatre/';
const ADDRESS = 'Apollo Theatre · 19 East College Street, Oberlin OH';

export async function GET(req: NextRequest) {
  if (!process.env.INGEST_SECRET || req.headers.get('x-ingest-secret') !== process.env.INGEST_SECRET) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const token = process.env.APOLLO_VEEZI_SITE_TOKEN;
  if (!token) return Response.json({ error: 'APOLLO_VEEZI_SITE_TOKEN not configured' }, { status: 500 });
  const ticketsUrl = `https://ticketing.uswest.veezi.com/sessions/?siteToken=${token}`;

  let html: string;
  try {
    const res = await fetch(ticketsUrl, { headers: { 'user-agent': 'Mozilla/5.0' }, cache: 'no-store' });
    if (!res.ok) return Response.json({ error: `Veezi fetch failed (${res.status})` }, { status: 502 });
    html = await res.text();
  } catch (e: any) {
    return Response.json({ error: `Veezi fetch error: ${e?.message}` }, { status: 502 });
  }

  const films = dedupeFilms(parseVeeziSessions(html));
  const now = new Date();

  // Disappearance-based end tracking — best effort; the feed still works if the
  // apollo_film_runs migration hasn't been applied yet.
  try {
    const runs = filmRunsForTracking(films, now);
    for (const r of runs) {
      await pool.query(
        `INSERT INTO apollo_film_runs (film_key, title, opened_on, last_seen_on, still_showing, ended_on)
           VALUES (?,?,?,?,1,NULL)
         ON DUPLICATE KEY UPDATE
           title=VALUES(title),
           opened_on=LEAST(opened_on, VALUES(opened_on)),
           last_seen_on=GREATEST(last_seen_on, VALUES(last_seen_on)),
           still_showing=1, ended_on=NULL`,
        [r.key, r.title, r.openedOn, r.lastSeenOn]
      );
    }
    const keys = runs.map(r => r.key);
    if (keys.length) {
      await pool.query(
        `UPDATE apollo_film_runs SET ended_on = last_seen_on, still_showing = 0
         WHERE still_showing = 1 AND film_key NOT IN (${keys.map(() => '?').join(',')})`,
        keys
      );
    }
  } catch { /* table not migrated yet — ends fall back to the per-run horizon */ }

  const extendedDescription = `${ADDRESS}\n\nGet tickets: ${ticketsUrl}\nMore info: ${APOLLO_PAGE}`;
  const events = buildApolloAnnouncements(films, now).map(a => ({
    eventType: 'an',
    email: process.env.ADMIN_EMAIL || 'fkusiapp@oberlin.edu',
    title: a.title,
    description: a.description,
    sessions: [{ startTime: a.startTime, endTime: a.endTime }],
    extendedDescription,
    sponsors: ['Cleveland Cinemas'],
    postTypeId: [5],
    locationType: 'ne',
    buttons: [{ title: 'Buy Tickets', link: ticketsUrl }],
    display: 'all',
    screensIds: [],
    calendarSourceName: 'Apollo Theatre',
    calendarSourceUrl: APOLLO_PAGE,
    geo_scope: 'hyper_local',
    movies: a.movies,         // helper for poster lookup; the ingest route ignores unknown fields
    poster_urls: [] as string[],
  }));

  return Response.json({
    generatedAt: now.toISOString(),
    ingestEndpoint: `${APP_URL}/api/ingest/apollo-theater`,
    filmsSeen: films.map(f => ({ title: f.title, rating: f.rating, showtimes: f.showtimes.length })),
    events,
  });
}
