import { buildApolloAnnouncements, parseVeeziDay } from '@/lib/sources/apolloSegments';
import { computeDedupKey } from '@/lib/eventDedup';

const film = (title: string, rating: string | null, dates: string[]) => ({
  title, code: null, rating,
  showtimes: dates.map((date, i) => ({ date, time: '7:00 PM', sessionId: String(i) })),
});
const NOON_ET_JUN30 = new Date('2026-06-30T16:00:00Z'); // run date = Jun 30
const span = (a: any) => [
  new Date(a.startTime * 1000).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' }),
  new Date(a.endTime * 1000).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' }),
];

describe('parseVeeziDay', () => {
  const today = { y: 2026, mo: 5, d: 30 };
  it('parses "Weekday DD, Month"', () => {
    expect(parseVeeziDay('Tuesday 30, June', today)).toEqual({ y: 2026, mo: 5, d: 30 });
    expect(parseVeeziDay('Thursday 9, July', today)).toEqual({ y: 2026, mo: 6, d: 9 });
  });
  it('rolls a past month into next year (Veezi shows only today-forward)', () => {
    expect(parseVeeziDay('Friday 2, January', today)).toEqual({ y: 2027, mo: 0, d: 2 });
  });
});

describe('buildApolloAnnouncements — today\'s real lineup', () => {
  // Disclosure Day (Jun 30 only), Toy Story 5 (Jun 30–Jul 9),
  // Minions & Monsters (Jul 1–Jul 9), Spider-Man (Jul 30 only).
  const FILMS = [
    film('Disclosure Day', 'PG-13', ['Tuesday 30, June']),
    film('Toy Story 5', 'PG', ['Tuesday 30, June', 'Thursday 9, July']),
    film('Minions & Monsters', 'PG', ['Wednesday 1, July', 'Thursday 9, July']),
    film('Spider-Man: Brand New Day', 'PG-13', ['Thursday 30, July']),
  ];
  const out = buildApolloAnnouncements(FILMS as any, NOON_ET_JUN30);
  const showing = out.filter(a => a.kind === 'showing_now');
  const soon = out.filter(a => a.kind === 'coming_soon');

  it('Showing Now starts a day ahead (Jul 1) — today-only Disclosure Day drops off', () => {
    expect(showing).toHaveLength(1);
    expect(showing[0].description).toBe('Minions & Monsters — now playing · Toy Story 5 — now playing');
    expect(showing[0].startTime).toBe(Math.floor(Date.UTC(2026, 6, 1, 4, 0, 0) / 1000)); // Jul 1 00:00 EDT
    expect(out.every(a => !a.description.includes('Disclosure'))).toBe(true);
  });

  it('Coming Soon is open-ended "opens <date>", never a closed single-day range', () => {
    expect(soon[0].description).toBe('Minions & Monsters — opens Jul 1 · Spider-Man: Brand New Day — opens Jul 30');
    expect(soon[soon.length - 1].description).toBe('Spider-Man: Brand New Day — opens Jul 30');
    expect(out.every(a => !/(\w+ \d+)\s*[–-]\s*\1/.test(a.description))).toBe(true);
  });
});

describe('buildApolloAnnouncements — the chained worked example', () => {
  // Toy Story 5 (–Jul 8), Minions (Jul 1–9), Moana (Jul 9–20), Ghostbusters (Jul 12–20)
  const FILMS = [
    film('Toy Story 5', 'PG', ['Tuesday 30, June', 'Tuesday 8, July']),
    film('Minions & Monsters', 'PG', ['Wednesday 1, July', 'Thursday 9, July']),
    film('Moana', 'PG', ['Thursday 9, July', 'Sunday 20, July']),
    film('Ghostbusters (1984)', 'PG', ['Saturday 12, July', 'Sunday 20, July']),
  ];
  const showing = buildApolloAnnouncements(FILMS as any, NOON_ET_JUN30).filter(a => a.kind === 'showing_now');

  it('chains forward, cutting a window at every lineup change', () => {
    expect(showing.map(a => a.description)).toEqual([
      'Toy Story 5 — through Jul 8 · Minions & Monsters — through Jul 9', // [Jul 1–8]
      'Minions & Monsters — through Jul 9 · Moana — now playing',         // [Jul 9]
      'Moana — now playing',                                             // [Jul 10–11]
      'Ghostbusters (1984) — now playing · Moana — now playing',          // [Jul 12–20]
    ]);
  });

  it('window boundaries match the example (ends on a film\'s last day / day before an opening)', () => {
    expect(showing.map(span)).toEqual([
      ['Jul 1', 'Jul 8'], ['Jul 9', 'Jul 9'], ['Jul 10', 'Jul 11'], ['Jul 12', 'Jul 20'],
    ]);
  });
});

// ── Regression: a single stale/yesterday date must not create a phantom year run ──
describe('buildApolloAnnouncements — stale date does not poison the chain', () => {
  it('parseVeeziDay keeps a recent past date in the current year (no +1y roll)', () => {
    const today = { y: 2026, mo: 5, d: 30 };
    expect(parseVeeziDay('Monday 29, June', today)).toEqual({ y: 2026, mo: 5, d: 29 }); // yesterday, NOT 2027
    expect(parseVeeziDay('Friday 2, January', today)).toEqual({ y: 2027, mo: 0, d: 2 }); // true wrap still rolls
  });

  it('a currently-playing film whose page still lists yesterday is bounded, not ~365 days', () => {
    // Without the fix, "Monday 29, June" rolled to Jun 2027 -> toRun [Jul 1 2026, Jun 29 2027],
    // pinning Indie Drama "now playing" for a year and emitting a backwards Jul 6 -> Jun 29 window.
    const FILMS = [
      film('Indie Drama', 'R', ['Monday 29, June', 'Wednesday 1, July', 'Friday 3, July']),
      film('Family Toon', 'PG', ['Thursday 2, July', 'Sunday 5, July']),
    ];
    const showing = buildApolloAnnouncements(FILMS as any, NOON_ET_JUN30).filter(a => a.kind === 'showing_now');
    // Every window ends on/before the real horizon (Jul 5) — no year-long phantom window.
    for (const a of showing) {
      expect(a.endTime - a.startTime).toBeLessThan(40 * 86400); // < 40 days, never ~365
      expect(a.endTime).toBeGreaterThan(a.startTime);            // never a backwards span
      expect(new Date(a.endTime * 1000).getUTCFullYear()).toBe(2026);
    }
  });
});

// ── Regression: a dark house immediately after today must not empty the feed ──
describe('buildApolloAnnouncements — dark day at showStart', () => {
  const FILMS = [
    film('Current Hit', 'PG-13', ['Tuesday 30, June']),                       // ends today -> dropped
    film('New Release X', 'PG', ['Thursday 2, July', 'Monday 13, July']),     // Jul 1 is dark
    film('New Release Y', 'PG', ['Thursday 2, July', 'Monday 13, July']),
  ];
  const showing = buildApolloAnnouncements(FILMS as any, NOON_ET_JUN30).filter(a => a.kind === 'showing_now');

  it('still emits Showing Now when T+1 (Jul 1) is a dark house', () => {
    expect(showing).toHaveLength(1);
    expect(showing[0].description).toBe('New Release X — now playing · New Release Y — now playing');
    expect(span(showing[0])).toEqual(['Jul 2', 'Jul 13']);
  });

  it('a FAR pre-sale after a real gap stays Coming Soon only (not promoted to now-playing)', () => {
    const far = buildApolloAnnouncements(
      [film('Big Sequel', 'PG-13', ['Thursday 30, July', 'Sunday 2, August'])] as any, // opens Jul 30
      NOON_ET_JUN30,
    );
    expect(far.filter(a => a.kind === 'showing_now')).toHaveLength(0);
    expect(far.some(a => a.kind === 'coming_soon' && /Big Sequel — opens Jul 30/.test(a.description))).toBe(true);
  });
});

// ── Regression: window start lands on the correct ET day across the spring-forward DST ──
describe('buildApolloAnnouncements — spring-forward DST window start', () => {
  it('a window beginning on the DST Sunday opens Mar 8 00:00 ET, not Mar 7 23:00', () => {
    const SPRING = new Date('2026-03-05T17:00:00Z'); // ~noon ET Mar 5 2026
    const FILMS = [
      film('Film A', 'PG', ['Friday 6, March', 'Saturday 7, March']),
      film('Film B', 'PG', ['Sunday 8, March', 'Friday 20, March']),
    ];
    const showing = buildApolloAnnouncements(FILMS as any, SPRING).filter(a => a.kind === 'showing_now');
    const b = showing.find(a => a.description.includes('Film B'))!;
    expect(b).toBeDefined();
    expect(new Date(b.startTime * 1000).toLocaleString('en-US',
      { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }))
      .toBe('Mar 8, 00:00');
  });
});

// ── Regression: the 'an' dedup key is stable across daily reruns of an unchanged lineup ──
describe('computeDedupKey — Showing Now leading window is stable run-to-run', () => {
  const FILMS = [
    film('Toy Story 5', 'PG', ['Tuesday 30, June', 'Wednesday 8, July']),
    film('Minions & Monsters', 'PG', ['Wednesday 1, July', 'Thursday 9, July']),
  ];
  const keyOfLeading = (runIso: string) => {
    const a = buildApolloAnnouncements(FILMS as any, new Date(runIso)).filter(x => x.kind === 'showing_now')[0];
    return computeDedupKey(a.title, [{ startTime: a.startTime, endTime: a.endTime }], 'an', a.description, '');
  };
  it('Jun 30, Jul 1, Jul 2 runs collapse to ONE key (no daily duplicate pile-up)', () => {
    const keys = new Set([
      keyOfLeading('2026-06-30T16:00:00Z'),
      keyOfLeading('2026-07-01T16:00:00Z'),
      keyOfLeading('2026-07-02T16:00:00Z'),
    ]);
    expect(keys.size).toBe(1);
  });
});
