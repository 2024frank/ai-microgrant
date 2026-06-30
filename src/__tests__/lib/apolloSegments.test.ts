import { buildApolloAnnouncements, parseVeeziDay } from '@/lib/sources/apolloSegments';

const film = (title: string, rating: string | null, dates: string[]) => ({
  title, code: null, rating,
  showtimes: dates.map((date, i) => ({ date, time: '7:00 PM', sessionId: String(i) })),
});

// Today's real Apollo lineup (run date 2026-06-30):
//   Disclosure Day      Jun 30 only      (ends today)
//   Toy Story 5         Jun 30 → Jul 9   (now showing, at the horizon → ongoing)
//   Minions & Monsters  Jul 1  → Jul 9   (opens tomorrow → folds into Showing Now)
//   Spider-Man          Jul 30 only      (far pre-sale → Coming Soon, open-ended)
const FILMS = [
  film('Disclosure Day', 'PG-13', ['Tuesday 30, June']),
  film('Toy Story 5', 'PG', ['Tuesday 30, June', 'Thursday 9, July']),
  film('Minions & Monsters', 'PG', ['Wednesday 1, July', 'Thursday 9, July']),
  film('Spider-Man: Brand New Day', 'PG-13', ['Thursday 30, July']),
];
const NOON_ET_JUN30 = new Date('2026-06-30T16:00:00Z');

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

describe('buildApolloAnnouncements', () => {
  const out = buildApolloAnnouncements(FILMS as any, NOON_ET_JUN30);
  const showing = out.filter(a => a.kind === 'showing_now');
  const soon = out.filter(a => a.kind === 'coming_soon');

  it('produces 2 Showing Now + 2 Coming Soon windows', () => {
    expect(showing).toHaveLength(2);
    expect(soon).toHaveLength(2);
  });

  it('window 1: ending film gets a real end, ongoing film is open-ended', () => {
    expect(showing[0].description).toBe('Disclosure Day — through Jun 30 · Toy Story 5 — now playing');
  });

  it('folds the soon-film (Minions, opens Jul 1) into the Jul 1–9 Showing Now window', () => {
    expect(showing[1].description).toBe('Minions & Monsters — now playing · Toy Story 5 — now playing');
  });

  it('Coming Soon is open-ended "opens <date>", never a closed single-day range', () => {
    expect(soon[0].description).toBe('Minions & Monsters — opens Jul 1 · Spider-Man: Brand New Day — opens Jul 30');
    expect(soon[1].description).toBe('Spider-Man: Brand New Day — opens Jul 30');
    expect(out.every(a => !/(\w+ \d+)\s*[–-]\s*\1/.test(a.description))).toBe(true); // no "Jul 30–Jul 30"
  });

  it('Showing Now window 1 starts at ET midnight today (matches existing payloads)', () => {
    expect(showing[0].startTime).toBe(Math.floor(Date.UTC(2026, 5, 30, 4, 0, 0) / 1000)); // 00:00 EDT
  });
});
