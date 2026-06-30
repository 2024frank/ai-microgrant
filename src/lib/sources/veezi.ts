/**
 * Deterministic parser for the Veezi sessions embed
 * (https://ticketing.<region>.veezi.com/sessions/?siteToken=…).
 *
 * The page is server-rendered HTML with a stable structure — one `.film` block
 * per film, each with a `.title`, a stable poster `code`, and `.date-container`s
 * holding a `.date` and `.session-times` (`<time>` linking to `purchase/<id>`).
 * Parsing it directly extracts EVERY film and showtime reliably, which an LLM
 * hand-reading the 60KB grid does not (it silently drops entries — the cause of
 * "the agent sometimes misses movies").
 *
 * Cleveland Cinemas' Apollo page is a JS "WidgetShowtimes" front-end over this
 * same Veezi data, so this is the reliable source for both.
 */

export interface VeeziShowtime { date: string; time: string; sessionId: string }
export interface VeeziFilm { title: string; code: string | null; rating: string | null; showtimes: VeeziShowtime[] }

function decode(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .trim();
}

/** Parse all films + showtimes from a Veezi sessions page's HTML. */
export function parseVeeziSessions(html: string): VeeziFilm[] {
  const films: VeeziFilm[] = [];
  for (const block of html.split(/class="film\s*"/i).slice(1)) {
    const title = decode(block.match(/class="title"[^>]*>\s*([^<]+?)\s*</i)?.[1] ?? '');
    if (!title) continue;
    const code = block.match(/code=0*([0-9]+)/i)?.[1] ?? null;
    const rating = decode(block.match(/class="censor"[^>]*>\s*([^<]+?)\s*</i)?.[1] ?? '') || null;

    const showtimes: VeeziShowtime[] = [];
    for (const dc of block.split(/class="date-container"/i).slice(1)) {
      const date = decode(dc.match(/class="date"[^>]*>\s*([^<]+?)\s*</i)?.[1] ?? '');
      const re = /purchase\/(\d+)[\s\S]*?<time>\s*([^<]+?)\s*<\/time>/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(dc))) showtimes.push({ date, time: decode(m[2]), sessionId: m[1] });
    }
    films.push({ title, code, rating, showtimes });
  }
  return films;
}

/** Collapse repeated film blocks into one entry per film (by code, else title),
 *  merging showtimes — the form a segmenter/announcement builder wants. */
export function dedupeFilms(films: VeeziFilm[]): VeeziFilm[] {
  const byKey = new Map<string, VeeziFilm>();
  for (const f of films) {
    const key = f.code ?? f.title.toLowerCase();
    const existing = byKey.get(key);
    if (existing) existing.showtimes.push(...f.showtimes);
    else byKey.set(key, { ...f, showtimes: [...f.showtimes] });
  }
  return [...byKey.values()];
}
