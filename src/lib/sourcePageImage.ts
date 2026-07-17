import { validatePublicHttpUrl } from './publicHttpUrl';

/**
 * Deterministic poster discovery for events whose extraction carried no
 * image. Priority 1 is the event page's own share metadata (og:image /
 * twitter:image / link rel="image_src") — the image the source itself uses
 * to represent the page. Many small-organization pages declare no share
 * metadata at all yet display the event's photo in the page body, so the
 * page's content images are the fallback, filtered against icons, logos,
 * and tracking pixels. On a page announcing several events at once, plain
 * document order attaches a NEIGHBOR's photo, so content candidates are
 * ordered by proximity to the event's own title text when a title hint is
 * available. Nothing is invented: every candidate comes from the source
 * page and still goes through the safe image pipeline (public-host
 * validation, pinned-DNS fetch, sharp re-encode) before any byte is stored.
 */

const MAX_HTML_BYTES = 400_000;
const META_TAG_PATTERN = /<meta\b[^>]*>/gi;
const LINK_TAG_PATTERN = /<link\b[^>]*>/gi;
const IMG_TAG_PATTERN = /<img\b[^>]*>/gi;
const IMAGE_META_NAMES = new Set([
  'og:image',
  'og:image:secure_url',
  'og:image:url',
  'twitter:image',
  'twitter:image:src',
]);
/** Filename fragments that mark chrome, not content. */
const JUNK_IMAGE_PATTERN = /(?:logo|icon|sprite|avatar|badge|pixel|spacer|blank|placeholder|button|banner-ad|favicon)/i;
const MAX_CONTENT_CANDIDATES = 5;
/** Ubiquitous words that cannot anchor a title inside a page. */
const TITLE_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'your', 'our',
  'are', 'not', 'all', 'will', 'have', 'more', 'about',
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

function declaredDimension(tag: string, name: string): number | null {
  const raw = attribute(tag, name).replace(/px$/i, '');
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw);
}

type ContentImageCandidate = { url: string; index: number };

function collectContentImageCandidates(html: string): ContentImageCandidate[] {
  const seen = new Set<string>();
  const candidates: ContentImageCandidate[] = [];
  const pattern = new RegExp(IMG_TAG_PATTERN.source, 'gi');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const tag = match[0];
    const width = declaredDimension(tag, 'width');
    const height = declaredDimension(tag, 'height');
    if ((width !== null && width < 200) || (height !== null && height < 200)) continue;
    const srcset = decodeEntities(attribute(tag, 'srcset') || attribute(tag, 'data-srcset'));
    const fromSrcset = srcset.split(',')[0]?.trim().split(/\s+/)[0] ?? '';
    // Lazy-loading attributes are honored because server-fetched HTML often
    // carries the real URL only in data-src/srcset while src is a placeholder.
    const sources = [
      decodeEntities(attribute(tag, 'src')),
      decodeEntities(attribute(tag, 'data-src')),
      decodeEntities(attribute(tag, 'data-lazy-src')),
      decodeEntities(attribute(tag, 'data-original')),
      fromSrcset,
    ];
    const url = sources.find(value => (
      value
      && !value.startsWith('data:')
      && !/\.svg(?:[?#]|$)/i.test(value)
      && !JUNK_IMAGE_PATTERN.test(value)
    ));
    if (url && !seen.has(url)) {
      seen.add(url);
      candidates.push({ url, index: match.index });
    }
  }
  return candidates;
}

/** Content-image URL candidates from the page body, in document order. */
export function extractContentImageCandidates(html: string): string[] {
  return collectContentImageCandidates(html)
    .slice(0, MAX_CONTENT_CANDIDATES)
    .map(candidate => candidate.url);
}

/**
 * Position of the event's title inside the page, anchored on the RAREST
 * title token present: on a page announcing several events, common words
 * ("first", "church") appear everywhere while the distinctive one
 * ("crushers") appears once, exactly at the event's own section.
 */
function titleAnchorIndex(html: string, titleHint: string): number | null {
  const lower = html.toLocaleLowerCase('en-US');
  const tokens = [...new Set(
    titleHint
      .normalize('NFKC')
      .toLocaleLowerCase('en-US')
      .split(/[^\p{L}\p{N}]+/u)
      .filter(token => token.length >= 4 && !TITLE_STOPWORDS.has(token)),
  )];
  let best: { count: number; index: number } | null = null;
  for (const token of tokens) {
    let at = lower.indexOf(token);
    if (at === -1) continue;
    const first = at;
    let count = 0;
    while (at !== -1 && count < 50) {
      count++;
      at = lower.indexOf(token, at + token.length);
    }
    if (!best || count < best.count) best = { count, index: first };
  }
  return best?.index ?? null;
}

export type DiscoverSourcePageImageOptions = {
  fetcher?: typeof fetch;
  /** The event's title, used to prefer images near its section of the page. */
  titleHint?: string;
};

/**
 * Fetch the event's source page and return its publicly hosted poster
 * candidates in priority order: share metadata first, then content images
 * (nearest to the event's title first when a hint is given). The page fetch
 * itself is bounded; each candidate image is fetched later through the
 * hardened safeRemoteImage pipeline, so callers try candidates in order
 * until one loads.
 */
export async function discoverSourcePageImageCandidates(
  pageUrl: string,
  options: DiscoverSourcePageImageOptions = {},
): Promise<string[]> {
  const fetcher = options.fetcher ?? fetch;
  const page = validatePublicHttpUrl(pageUrl);
  if (!page.success) return [];

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
    return [];
  }
  if (!response.ok) return [];
  const contentType = String(response.headers?.get?.('content-type') ?? '');
  if (contentType && !/text\/html|application\/xhtml/i.test(contentType)) return [];

  let html: string;
  try {
    html = (await response.text()).slice(0, MAX_HTML_BYTES);
  } catch {
    return [];
  }

  const anchor = options.titleHint ? titleAnchorIndex(html, options.titleHint) : null;
  const contentCandidates = collectContentImageCandidates(html);
  if (anchor !== null) {
    contentCandidates.sort((left, right) => (
      Math.abs(left.index - anchor) - Math.abs(right.index - anchor)
    ));
  }

  const base = (typeof response.url === 'string' && response.url) || page.url.toString();
  const ordered = [
    ...extractMetaImageCandidates(html),
    ...contentCandidates.slice(0, MAX_CONTENT_CANDIDATES).map(candidate => candidate.url),
  ];
  const resolved: string[] = [];
  for (const candidate of ordered) {
    let absolute: string;
    try {
      absolute = new URL(candidate, base).toString();
    } catch {
      continue;
    }
    if (validatePublicHttpUrl(absolute).success && !resolved.includes(absolute)) {
      resolved.push(absolute);
    }
  }
  return resolved;
}

/** First discovered poster candidate, or null when the page yields none. */
export async function discoverSourcePageImage(
  pageUrl: string,
  options: DiscoverSourcePageImageOptions = {},
): Promise<string | null> {
  const candidates = await discoverSourcePageImageCandidates(pageUrl, options);
  return candidates[0] ?? null;
}
