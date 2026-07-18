import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { cronUnavailable, isCronAuthorized } from '@/lib/cronAuth';
import { createEventMediaToken } from '@/lib/eventMediaToken';
import { normalizeCommunityHubPostId } from '@/lib/communityHubResponse';
import { validatePublicHttpUrl } from '@/lib/publicHttpUrl';

export const maxDuration = 300;

const CH_BASE = 'https://oberlin.communityhub.cloud/api/legacy/calendar';

/**
 * POST /api/agent/communityhub-image-update (CRON_SECRET)
 *
 * Refresh the image on already-published CommunityHub posts. Some events were
 * published before their source was pointed at a feed that carries real
 * images (the library moved from WhoFi's logo to Locable's per-event photos).
 * This updates each matched event's stored poster and PATCHes the existing
 * CommunityHub post by its id. PATCH /post/{id}/submit updates the SAME post,
 * so it cannot create a duplicate public entry.
 *
 * Query params:
 *  - apply=1        actually materialize and PATCH; otherwise dry-run only.
 *  - limit=N        cap how many events to touch (test on one first).
 *  - source_id=N    which source's events to refresh (default 7, the library).
 * Body (optional): { images: { "<title>": "<public https image url>" } } to
 * override the default title-to-image map.
 */

// The seven live Oberlin Public Library programs and their real Locable
// images, gathered from the library's own calendar.
const LIBRARY_IMAGES: Record<string, string> = {
  'Storytime at Oberlin Public Library': 'https://images.locable.com/eyJidWNrZXQiOiJpbXBhY3QtcHJvZHVjdGlvbiIsImtleSI6Il9vcmlnaW5hbHMvNTg1MDZhYjktNmMxZC00MzUxLTljYzQtZGY3ZmI5ZGNkNGM4L1N0b3J5dGltZS5wbmciLCJlZGl0cyI6eyJyZXNpemUiOnsid2lkdGgiOjQwMH0sInBuZyI6eyJxdWFsaXR5Ijo4MCwiYWRhcHRpdmVGaWx0ZXJpbmciOnRydWV9fX0=',
  'Kitten Storytime at OPL': 'https://images.locable.com/eyJidWNrZXQiOiJpbXBhY3QtcHJvZHVjdGlvbiIsImtleSI6Il9vcmlnaW5hbHMvYmUyMTQ4ZWEtMzAxZC00ZjRmLTk0MTQtZmM3YTc0ZWRmNGEwL0tpdHRlbiBTdG9yeXRpbWUgMjAyNiAoMSkucG5nIiwiZWRpdHMiOnsicmVzaXplIjp7IndpZHRoIjo0MDB9LCJwbmciOnsicXVhbGl0eSI6ODAsImFkYXB0aXZlRmlsdGVyaW5nIjp0cnVlfX19',
  'Reading Buddies with Maya the Therapy Dog': 'https://images.locable.com/eyJidWNrZXQiOiJpbXBhY3QtcHJvZHVjdGlvbiIsImtleSI6Il9vcmlnaW5hbHMvOTY2OTI2ODItMTIyMC00NDM2LTgyNTgtMDA2Mzc4Y2Q5M2FkL1JlYWRpbmcgQnVkZGllcyBGbHllciAoSW5zdGFncmFtIFBvc3QgKDQ1KSkgKDMpLnBuZyIsImVkaXRzIjp7InJlc2l6ZSI6eyJ3aWR0aCI6NDAwfSwicG5nIjp7InF1YWxpdHkiOjgwLCJhZGFwdGl2ZUZpbHRlcmluZyI6dHJ1ZX19fQ==',
  'Kombucha In Your Kitchen (OPL Modern Homesteading)': 'https://images.locable.com/eyJidWNrZXQiOiJpbXBhY3QtcHJvZHVjdGlvbiIsImtleSI6Il9vcmlnaW5hbHMvNjRmYzc0OGQtZTc5Ny00Mjk2LTkwNTEtMGViNDA3NWM5MTgxLzc0NDMzMzAwNl8yODYyMTE3NzEyMDgwNTI1OV8yNDU4MzEzOTk0NjE1MzY3ODI2X24uanBnIiwiZWRpdHMiOnsicmVzaXplIjp7IndpZHRoIjo0MDB9LCJqcGVnIjp7InF1YWxpdHkiOjgwfX19',
  'L.E.G.O.': 'https://images.locable.com/eyJidWNrZXQiOiJpbXBhY3QtcHJvZHVjdGlvbiIsImtleSI6Il9lZGl0ZWQvMDJkOTYzOTYtZmRmYy00M2VhLTlmOWEtZWE2YTUxYzBlZWRkL0xFR08ucG5nIiwiZWRpdHMiOnsicmVzaXplIjp7IndpZHRoIjo0MDB9LCJwbmciOnsicXVhbGl0eSI6ODAsImFkYXB0aXZlRmlsdGVyaW5nIjp0cnVlfX19',
  'Music Open Mic': 'https://images.locable.com/eyJidWNrZXQiOiJpbXBhY3QtcHJvZHVjdGlvbiIsImtleSI6Il9vcmlnaW5hbHMvYTk5ODY3NmUtYWIzOS00ZmQzLWI4ZWQtMWRiOWY1NzE5N2NkLzAucG5nIiwiZWRpdHMiOnsicmVzaXplIjp7IndpZHRoIjo0MDB9LCJwbmciOnsicXVhbGl0eSI6ODAsImFkYXB0aXZlRmlsdGVyaW5nIjp0cnVlfX19',
  'Bird Conversation: Where Have All The Birds Gone?': 'https://images.locable.com/eyJidWNrZXQiOiJpbXBhY3QtcHJvZHVjdGlvbiIsImtleSI6Il9vcmlnaW5hbHMvNzI2NGJlMzAtM2ViMS00ZjRkLTg5NTQtYjY1ODM5ZmM3MjdmL0JpcmRzLnBuZyIsImVkaXRzIjp7InJlc2l6ZSI6eyJ3aWR0aCI6NDAwfSwicG5nIjp7InF1YWxpdHkiOjgwLCJhZGFwdGl2ZUZpbHRlcmluZyI6dHJ1ZX19fQ==',
};

function normalizeTitle(value: unknown): string {
  return String(value ?? '')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

type UpdateItem = {
  event_id: number;
  title: string;
  post_id: string | null;
  status: 'matched' | 'updated' | 'skipped_no_match' | 'skipped_no_post_id' | 'error';
  image_url?: string;
  ch_status?: number;
  error?: string;
};

async function handle(req: NextRequest) {
  if (cronUnavailable()) {
    return Response.json({ error: 'CRON_SECRET is not configured' }, { status: 503 });
  }
  if (!isCronAuthorized(req)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const apply = url.searchParams.get('apply') === '1';
  const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit')) || 50));
  const sourceId = Number(url.searchParams.get('source_id')) || 7;

  let images = LIBRARY_IMAGES;
  try {
    const body = await req.json();
    if (body && typeof body.images === 'object' && body.images) images = body.images;
  } catch {
    // No body: use the default map.
  }
  const imageByTitle = new Map<string, string>();
  for (const [title, imageUrl] of Object.entries(images)) {
    if (typeof imageUrl === 'string' && validatePublicHttpUrl(imageUrl).success) {
      imageByTitle.set(normalizeTitle(title), imageUrl);
    }
  }

  const appUrl = (
    process.env.APP_URL
    || process.env.NEXT_PUBLIC_APP_URL
    || 'https://ai-microgrant-research-oberlin.vercel.app'
  ).replace(/\/$/, '');

  // Only events already on CommunityHub (they have a post id) in a live or
  // in-moderation state. PATCH updates that exact post; no new post is created.
  const [rows] = await pool.query(
    `SELECT id, title, communityhub_post_id, status
     FROM raw_events
     WHERE source_id=?
       AND communityhub_post_id IS NOT NULL
       AND status IN ('approved','submitted','publishing','resubmitted')
     ORDER BY id ASC`,
    [sourceId],
  ) as any;
  const events = Array.isArray(rows) ? rows : [];

  const items: UpdateItem[] = [];
  let touched = 0;
  for (const event of events) {
    if (touched >= limit) break;
    const eventId = Number(event.id);
    const title = String(event.title ?? '');
    const postId = normalizeCommunityHubPostId(event.communityhub_post_id);
    const imageUrl = imageByTitle.get(normalizeTitle(title));

    if (!imageUrl) {
      items.push({ event_id: eventId, title, post_id: postId, status: 'skipped_no_match' });
      continue;
    }
    if (!postId) {
      items.push({ event_id: eventId, title, post_id: null, status: 'skipped_no_post_id', image_url: imageUrl });
      continue;
    }
    if (!apply) {
      touched++;
      items.push({ event_id: eventId, title, post_id: postId, status: 'matched', image_url: imageUrl });
      continue;
    }

    touched++;
    try {
      const { loadImageAsJpeg } = await import('@/lib/safeRemoteImage');
      const jpeg = await loadImageAsJpeg(imageUrl);
      const dataUri = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
      await pool.query(
        `UPDATE raw_events SET image_data=?, image_cdn_url=? WHERE id=?`,
        [dataUri, imageUrl, eventId],
      );
      const mediaToken = createEventMediaToken(String(eventId), dataUri);
      const posterUrl = `${appUrl}/api/events/${eventId}/poster.jpg?media_token=${encodeURIComponent(mediaToken)}`;
      const response = await fetch(`${CH_BASE}/post/${encodeURIComponent(postId)}/submit`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_cdn_url: posterUrl }),
        signal: AbortSignal.timeout(30_000),
      });
      items.push({
        event_id: eventId,
        title,
        post_id: postId,
        status: response.ok ? 'updated' : 'error',
        image_url: imageUrl,
        ch_status: response.status,
        error: response.ok ? undefined : (await response.text().catch(() => '')).slice(0, 300),
      });
    } catch (error) {
      items.push({
        event_id: eventId,
        title,
        post_id: postId,
        status: 'error',
        image_url: imageUrl,
        error: error instanceof Error ? error.message : 'image update failed',
      });
    }
  }

  return Response.json({
    ok: items.every(item => item.status !== 'error'),
    apply,
    source_id: sourceId,
    candidates: events.length,
    matched: items.filter(i => i.status === 'matched' || i.status === 'updated').length,
    updated: items.filter(i => i.status === 'updated').length,
    unmatched: items.filter(i => i.status === 'skipped_no_match').length,
    errors: items.filter(i => i.status === 'error').length,
    items,
  });
}

export async function POST(req: NextRequest) {
  return handle(req);
}

export async function GET(req: NextRequest) {
  return handle(req);
}
