import { NextRequest } from 'next/server';
import { cronUnavailable, isCronAuthorized } from '@/lib/cronAuth';
import { fetchCommunityHubInventory } from '@/lib/communityHubInventory';
import { libraryImagesByTitle, libraryPosterSlug } from '@/lib/libraryPosters';
import pool from '@/lib/db';

export const maxDuration = 300;

const CH_BASE = 'https://oberlin.communityhub.cloud/api/legacy/calendar';

/**
 * POST /api/agent/communityhub-image-update (CRON_SECRET)
 *
 * Refresh the image on already-published CommunityHub posts. Some programs
 * were published before their source carried real images (the library moved
 * from WhoFi's logo to Locable's per-event photos). This reads the live
 * CommunityHub inventory, matches each library post by name to its real
 * image, and PATCHes that post by id. PATCH /post/{id}/submit updates the
 * SAME post, so it can never create a duplicate public entry.
 *
 * CommunityHub rejects the extension-less Locable CDN URLs, so it is pointed
 * at the app's /api/media/library/<slug>.jpg endpoint, which re-serves the
 * same image as a JPEG at a real extension.
 *
 * Query params: apply=1 to actually PATCH (else dry-run); limit=N to cap
 * (test with 1 first).
 */

const STOPWORDS = new Set([
  'the', 'at', 'of', 'and', 'in', 'to', 'a', 'an', 'with', 'for', 'opl',
  'oberlin', 'public', 'library', 'your',
]);

function tokens(value: string): string[] {
  return value
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(token => token.length >= 2);
}

/** Distinctive tokens for matching: drops generic library words. */
function keyTokens(value: string): Set<string> {
  return new Set(tokens(value).filter(token => !STOPWORDS.has(token)));
}

/** All alphanumerics, lowercased, no separators ("L.E.G.O." -> "lego"). */
function compact(value: string): string {
  return value.toLocaleLowerCase('en-US').replace(/[^a-z0-9]/g, '');
}

/** Best image key for a post name: containment or strong distinctive overlap. */
function matchImageTitle(postName: string, keys: string[]): string | null {
  const postCompact = compact(postName);
  const post = keyTokens(postName);
  let best: { key: string; score: number } | null = null;
  for (const key of keys) {
    const keyCompact = compact(key);
    // Compact containment handles punctuation-heavy titles ("L.E.G.O.") and
    // short-vs-long variants ("Storytime" vs "Storytime at Oberlin Public
    // Library"). Require the shorter side to be at least four characters so a
    // trivial fragment cannot match.
    const shorter = postCompact.length <= keyCompact.length ? postCompact : keyCompact;
    const longer = shorter === postCompact ? keyCompact : postCompact;
    const compactMatch = shorter.length >= 4 && longer.includes(shorter);

    const wanted = keyTokens(key);
    const shared = [...wanted].filter(token => post.has(token)).length;
    const smaller = Math.min(wanted.size, post.size);
    const coverage = smaller > 0 ? shared / smaller : 0;
    const union = new Set([...wanted, ...post]).size;
    const jaccard = union > 0 ? shared / union : 0;

    if (compactMatch || coverage >= 1 || jaccard >= 0.6) {
      const score = compactMatch ? 1 + shorter.length / 100 : Math.max(coverage, jaccard);
      if (!best || score > best.score) best = { key, score };
    }
  }
  return best?.key ?? null;
}

type UpdateItem = {
  post_id: string;
  post_name: string;
  matched_title?: string;
  image_url?: string;
  status: 'matched' | 'updated' | 'skipped_no_match' | 'error';
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

  const appUrl = (
    process.env.APP_URL
    || process.env.NEXT_PUBLIC_APP_URL
    || 'https://ai-microgrant-research-oberlin.vercel.app'
  ).replace(/\/$/, '');
  const validImages = libraryImagesByTitle();
  const keys = Object.keys(validImages);

  let inventory;
  try {
    inventory = await fetchCommunityHubInventory();
  } catch (error) {
    return Response.json({
      error: 'Could not read the CommunityHub inventory',
      detail: error instanceof Error ? error.message : 'inventory fetch failed',
    }, { status: 502 });
  }

  // Restrict to posts attributed to the Oberlin Public Library, then match
  // each by name to one of the supplied images.
  const libraryPosts = inventory.posts.filter(post => {
    const raw = post.raw;
    const labels = [raw?.calendarSourceName ?? '', ...(raw?.sponsors ?? []), ...(raw?.organizations ?? [])]
      .join(' ')
      .toLocaleLowerCase('en-US');
    return labels.includes('library') || labels.includes('oberlin public');
  });

  const items: UpdateItem[] = [];
  let touched = 0;
  for (const post of libraryPosts) {
    const postId = post.raw?.id ?? '';
    const postName = post.raw?.name ?? post.title;
    if (!postId) continue;
    const matchedTitle = matchImageTitle(postName, keys);
    if (!matchedTitle) {
      items.push({ post_id: postId, post_name: postName, status: 'skipped_no_match' });
      continue;
    }
    if (touched >= limit) break;
    // CommunityHub downloads the image from its URL and requires a real file
    // extension, so it is pointed at the app's .jpg re-serve of the poster.
    const slug = libraryPosterSlug(matchedTitle);
    const imageUrl = slug ? `${appUrl}/api/media/library/${slug}.jpg` : validImages[matchedTitle];
    if (!apply) {
      touched++;
      items.push({ post_id: postId, post_name: postName, matched_title: matchedTitle, image_url: imageUrl, status: 'matched' });
      continue;
    }
    touched++;
    try {
      const response = await fetch(`${CH_BASE}/post/${encodeURIComponent(postId)}/submit`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_cdn_url: imageUrl }),
        signal: AbortSignal.timeout(30_000),
      });
      const ok = response.ok;
      // Best-effort: reflect the new image on any local row for this post.
      if (ok) {
        await pool.query(
          `UPDATE raw_events SET image_cdn_url=?, image_data=NULL
           WHERE communityhub_post_id=?`,
          [imageUrl, postId],
        ).catch(() => undefined);
      }
      items.push({
        post_id: postId,
        post_name: postName,
        matched_title: matchedTitle,
        image_url: imageUrl,
        status: ok ? 'updated' : 'error',
        ch_status: response.status,
        error: ok ? undefined : (await response.text().catch(() => '')).slice(0, 300),
      });
    } catch (error) {
      items.push({
        post_id: postId,
        post_name: postName,
        matched_title: matchedTitle,
        image_url: imageUrl,
        status: 'error',
        error: error instanceof Error ? error.message : 'image update failed',
      });
    }
  }

  return Response.json({
    ok: items.every(item => item.status !== 'error'),
    apply,
    library_posts: libraryPosts.length,
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
