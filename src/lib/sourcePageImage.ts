import { validatePublicHttpUrl } from './publicHttpUrl';

/**
 * Deterministic poster discovery for events whose extraction carried no
 * image: the event page's own share metadata (og:image / twitter:image /
 * link rel="image_src") names the image the source itself uses to represent
 * the event. Nothing is invented; a page without share metadata yields
 * nothing, and every discovered URL still goes through the safe image
 * pipeline (public-host validation, pinned-DNS fetch, sharp re-encode)
 * before any byte is stored.
 */

const MAX_HTML_BYTES = 400_000;
const META_TAG_PATTERN = /<meta\b[^>]*>/gi;
const LINK_TAG_PATTERN = /<link\b[^>]*>/gi;
const IMAGE_META_NAMES = new Set([
  'og:image',
  'og:image:secure_url',
  'og:image:url',
  'twitter:image',
  'twitter:image:src',
]);

function attribute(tag: string, name: string): string {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return (match?.[2] ?? match?.[3] ?? '').trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&#0*38;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'");
}

/** All share-image URL candidates in document order (may be relative). */
export function extractMetaImageCandidates(html: string): string[] {
  const candidates: string[] = [];
  for (const tag of html.match(META_TAG_PATTERN) ?? []) {
    const key = (attribute(tag, 'property') || attribute(tag, 'name')).toLowerCase();
    if (!IMAGE_META_NAMES.has(key)) continue;
    const content = decodeEntities(attribute(tag, 'content'));
    if (content) candidates.push(content);
  }
  for (const tag of html.match(LINK_TAG_PATTERN) ?? []) {
    if (attribute(tag, 'rel').toLowerCase() !== 'image_src') continue;
    const href = decodeEntities(attribute(tag, 'href'));
    if (href) candidates.push(href);
  }
  return [...new Set(candidates)];
}

/**
 * Fetch the event's source page and return its first publicly hosted share
 * image URL, or null when the page names none. The page fetch itself is
 * bounded and parsed only for metadata; the image is fetched later through
 * the hardened safeRemoteImage pipeline.
 */
export async function discoverSourcePageImage(
  pageUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  const page = validatePublicHttpUrl(pageUrl);
  if (!page.success) return null;

  let response: Response;
  try {
    response = await fetcher(page.url.toString(), {
      redirect: 'follow',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'CommunityHub-EventIntake/1.0',
      },
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const contentType = String(response.headers?.get?.('content-type') ?? '');
  if (contentType && !/text\/html|application\/xhtml/i.test(contentType)) return null;

  let html: string;
  try {
    html = (await response.text()).slice(0, MAX_HTML_BYTES);
  } catch {
    return null;
  }

  const base = (typeof response.url === 'string' && response.url) || page.url.toString();
  for (const candidate of extractMetaImageCandidates(html)) {
    let absolute: string;
    try {
      absolute = new URL(candidate, base).toString();
    } catch {
      continue;
    }
    if (validatePublicHttpUrl(absolute).success) return absolute;
  }
  return null;
}
