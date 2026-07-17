import { buildApolloAnnouncements, parseVeeziDay } from '@/lib/sources/apolloSegments';

const film = (title: string, rating: string | null, dates: string[]) => ({
  title, code: null, rating,
  showtimes: dates.map((date, i) => ({ date, time: '7:00 PM', sessionId: String(i) })),
});
const NOON_ET_JUN30 = new Date('2026-06-30T16:00:00Z'); // run date = Jun 30

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

  it('uses the exact agreed announcement titles', () => {
    // Requirement wording: "Now Playing", never "Now Showing";
    // "Coming Soon to the Apollo", never "Apollo Coming Soon".
    expect(showing.length).toBeGreaterThan(0);
    expect(soon.length).toBeGreaterThan(0);
    for (const a of showing) expect(a.title).toBe('Now Playing at the Apollo');
    for (const a of soon) expect(a.title).toBe('Coming Soon to the Apollo');
    expect(out.some(a => a.title.includes('Now Showing'))).toBe(false);
    expect(out.some(a => a.title.includes('Apollo Coming Soon'))).toBe(false);
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

  it('titles every chained window exactly "Now Playing at the Apollo"', () => {
    expect(showing.length).toBe(4);
    expect(showing.map(a => a.title)).toEqual(Array(4).fill('Now Playing at the Apollo'));
  });

  it('window boundaries match the example (ends on a film\'s last day / day before an opening)', () => {
    const span = (a: any) => [
      new Date(a.startTime * 1000).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' }),
      new Date(a.endTime * 1000).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' }),
    ];
    expect(showing.map(span)).toEqual([
      ['Jul 1', 'Jul 8'], ['Jul 9', 'Jul 9'], ['Jul 10', 'Jul 11'], ['Jul 12', 'Jul 20'],
    ]);
  });
});
