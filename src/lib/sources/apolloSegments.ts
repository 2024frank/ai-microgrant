/**
 * Deterministic Apollo announcement segmenter.
 *
 * Takes the films parsed off the Veezi sessions page (see ./veezi.ts) and the
 * current date, and produces the exact "Apollo - Showing Now" / "Apollo - Coming
 * Soon" announcement payloads — no LLM, no hand-reading of HTML, no date math by
 * the model. The agent only adds posters and POSTs.
 *
 * Rules (from the product owner's worked example):
 *  - The agent fetches a day ahead, so Showing Now windows START at today + 1.
 *    A movie that only plays today is not announced.
 *  - Showing Now is forward-looking and chains: a new window begins at every
 *    lineup change — when a film ENDS (window ends on its last day) AND when a
 *    new film OPENS (window ends the day before it opens). Films fold in as they
 *    open and drop as they end, for as long as the schedule is contiguous. A gap
 *    in coverage stops the chain (a far pre-sale after a gap is Coming Soon only).
 *      e.g. ToyStory(–Jul8), Minions(–Jul9), Moana(Jul9–), Ghostbusters(Jul12–):
 *        [Jul1–8] Toy Story·Minions → [Jul9] Minions·Moana
 *        [Jul10–11] Moana → [Jul12–…] Ghostbusters·Moana
 *  - Ends are observed, never invented. A film at the far edge of the contiguous
 *    run (its last visible date == the horizon) is still on sale → "now playing".
 *    A film that ends earlier while others continue → "through <last day>". Its
 *    true end is only confirmed once it disappears from a later weekly run
 *    (tracked server-side, not here).
 *  - Coming Soon announces upcoming films from the run date, segmented by opening
 *    date, each window ending the day before a film opens — "opens <date>"
 *    (open-ended, never a closed single-day range).
 */
import type { VeeziFilm } from './veezi';

export interface ApolloAnnouncement {
  kind: 'showing_now' | 'coming_soon';
  title: string;                 // "Now Playing at the Apollo" | "Coming Soon to the Apollo"
  description: string;           // " · "-joined per-film lines
  startTime: number;             // unix seconds, 00:00:00 America/New_York of window start
  endTime: number;               // unix seconds, 23:59:59 America/New_York of window end
  movies: { title: string; rating: string | null }[]; // for poster lookup
}

interface Day { y: number; mo: number; d: number } // mo 0-11
interface Run { title: string; rating: string | null; start: Day; end: Day }

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

const dayNum = (x: Day) => Math.floor(Date.UTC(x.y, x.mo, x.d) / 86400000);
const fromNum = (n: number): Day => { const t = new Date(n * 86400000); return { y: t.getUTCFullYear(), mo: t.getUTCMonth(), d: t.getUTCDate() }; };
const fmt = (x: Day) => `${MONTHS[x.mo].slice(0, 3).replace(/^\w/, c => c.toUpperCase())} ${x.d}`;

/** "Tuesday 30, June" → Day. Year inferred from `today` (Veezi shows only
 *  today-forward dates, so any computed past date is next year's). */
export function parseVeeziDay(s: string, today: Day): Day | null {
  const m = s.match(/(\d{1,2})\s*,\s*([A-Za-z]+)/);
  if (!m) return null;
  const d = parseInt(m[1], 10);
  const mo = MONTHS.indexOf(m[2].toLowerCase());
  if (mo < 0 || d < 1 || d > 31) return null;
  let day: Day = { y: today.y, mo, d };
  if (dayNum(day) < dayNum(today)) day = { y: today.y + 1, mo, d };
  return day;
}

// Epoch seconds for a wall-clock America/New_York time on a given day.
function etOffsetMinutes(day: Day): number {
  const at = new Date(Date.UTC(day.y, day.mo, day.d, 12, 0, 0));
  const name = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' })
    .formatToParts(at).find(p => p.type === 'timeZoneName')?.value || 'GMT-5';
  const m = name.match(/GMT([+-]?\d{1,2})(?::?(\d{2}))?/);
  if (!m) return -300;
  const h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  return h * 60 + (h < 0 ? -min : min);
}
function etEpoch(day: Day, endOfDay: boolean): number {
  const off = etOffsetMinutes(day);
  const [hh, mm, ss] = endOfDay ? [23, 59, 59] : [0, 0, 0];
  return Math.floor((Date.UTC(day.y, day.mo, day.d, hh, mm, ss) - off * 60000) / 1000);
}

function todayInET(now: Date): Day {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const g = (t: string) => parseInt(p.find(x => x.type === t)!.value, 10);
  return { y: g('year'), mo: g('month') - 1, d: g('day') };
}

/** Collapse a film's showtimes into a [start, end] run (min/max visible date). */
function toRun(f: VeeziFilm, today: Day): Run | null {
  const days = f.showtimes.map(s => parseVeeziDay(s.date, today)).filter((x): x is Day => !!x);
  if (!days.length) return null;
  const nums = days.map(dayNum).sort((a, b) => a - b);
  return { title: f.title, rating: f.rating, start: fromNum(nums[0]), end: fromNum(nums[nums.length - 1]) };
}

export function buildApolloAnnouncements(films: VeeziFilm[], now: Date = new Date()): ApolloAnnouncement[] {
  const today = todayInET(now);
  const T = dayNum(today);
  const allRuns = films.map(f => toRun(f, today)).filter((r): r is Run => !!r);
  const out: ApolloAnnouncement[] = [];

  // ── Showing Now ────────────────────────────────────────────────────────────
  // Start a day ahead and chain forward through the contiguous run.
  const showStart = T + 1;
  const showRuns = allRuns.filter(r => dayNum(r.end) >= showStart);

  // Contiguous coverage from showStart → lastCovered (stop at the first gap).
  const covered = new Set<number>();
  for (const r of showRuns) {
    for (let d = Math.max(dayNum(r.start), showStart); d <= dayNum(r.end); d++) covered.add(d);
  }
  let lastCovered = showStart - 1;
  if (covered.has(showStart)) { let d = showStart; while (covered.has(d)) d++; lastCovered = d - 1; }

  if (lastCovered >= showStart) {
    const cands = showRuns.filter(r => dayNum(r.start) <= lastCovered && dayNum(r.end) >= showStart);
    const horizon = lastCovered; // films still on sale at the run's edge are "now playing"

    // Cut points: today+1, every opening within the run, every (end + 1).
    const points = [...new Set([
      showStart,
      ...cands.filter(r => dayNum(r.start) > showStart).map(r => dayNum(r.start)),
      ...cands.map(r => dayNum(r.end) + 1),
    ])].filter(p => p >= showStart && p <= lastCovered + 1).sort((a, b) => a - b);

    for (let i = 0; i < points.length - 1; i++) {
      const ws = points[i], we = points[i + 1] - 1;
      if (we < ws || we > lastCovered) continue;
      const lineup = cands
        .filter(r => dayNum(r.start) <= ws && dayNum(r.end) >= we)
        .sort((a, b) => dayNum(a.end) - dayNum(b.end) || a.title.localeCompare(b.title));
      if (!lineup.length) continue;
      const description = lineup
        .map(r => dayNum(r.end) >= horizon ? `${r.title} — now playing` : `${r.title} — through ${fmt(r.end)}`)
        .join(' · ');
      out.push({
        // Exact title wording agreed 2026-07-16: "Now Playing at the Apollo"
        // (not "Now Showing"). The upcoming/current decision above is the
        // existing segmenter and is intentionally unchanged.
        kind: 'showing_now', title: 'Now Playing at the Apollo', description,
        startTime: etEpoch(fromNum(ws), false), endTime: etEpoch(fromNum(we), true),
        movies: lineup.map(r => ({ title: r.title, rating: r.rating })),
      });
    }
  }

  // ── Coming Soon ────────────────────────────────────────────────────────────
  // From the run date, one window per opening; each ends the day before a film
  // opens. A film here also folds into Showing Now once it has opened.
  const comingSoon = allRuns.filter(r => dayNum(r.start) > T);
  if (comingSoon.length) {
    const starts = [...new Set(comingSoon.map(r => dayNum(r.start)))].sort((a, b) => a - b);
    let prev = T; // coming-soon announcements start on the run date
    for (const s of starts) {
      const ws = prev, we = s - 1;
      prev = s;
      if (we < ws) continue;
      const lineup = comingSoon
        .filter(r => dayNum(r.start) > we)
        .sort((a, b) => dayNum(a.start) - dayNum(b.start) || a.title.localeCompare(b.title));
      if (!lineup.length) continue;
      out.push({
        kind: 'coming_soon', title: 'Coming Soon to the Apollo',
        description: lineup.map(r => `${r.title} — opens ${fmt(r.start)}`).join(' · '),
        startTime: etEpoch(fromNum(ws), false), endTime: etEpoch(fromNum(we), true),
        movies: lineup.map(r => ({ title: r.title, rating: r.rating })),
      });
    }
  }

  return out;
}

export interface FilmRun { key: string; title: string; openedOn: string; lastSeenOn: string }

/** Per-film run rows (ISO dates) for disappearance-based end tracking: opened_on
 *  = earliest visible date, last_seen_on = latest visible date this run. When a
 *  film stops appearing, last_seen_on becomes its real end. */
export function filmRunsForTracking(films: VeeziFilm[], now: Date = new Date()): FilmRun[] {
  const today = todayInET(now);
  const iso = (x: Day) => `${x.y}-${String(x.mo + 1).padStart(2, '0')}-${String(x.d).padStart(2, '0')}`;
  const out: FilmRun[] = [];
  for (const f of films) {
    const nums = f.showtimes.map(s => parseVeeziDay(s.date, today)).filter((x): x is Day => !!x).map(dayNum).sort((a, b) => a - b);
    if (!nums.length) continue;
    out.push({ key: f.code ?? f.title.toLowerCase().trim(), title: f.title, openedOn: iso(fromNum(nums[0])), lastSeenOn: iso(fromNum(nums[nums.length - 1])) });
  }
  return out;
}
