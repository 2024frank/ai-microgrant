/**
 * Decide whether a source's cron schedule means it should run today.
 *
 * The platform triggers /api/agent/schedule once per day, so only the DATE
 * fields of the cron matter — minute/hour are ignored (time-of-day is the
 * trigger's job). e.g. FAVA `0 6 * * 1` runs on Mondays; Apollo `0 6 * * *`
 * runs every day.
 *
 * Conservative by design: returns `true` on anything missing/malformed so a
 * source is never silently skipped — it only returns `false` when the schedule
 * clearly excludes today.
 */
function matchField(field: string, value: number, min: number, max: number): boolean {
  if (!field || field === '*' || field === '?') return true;
  for (const part of field.split(',')) {
    const [range, stepStr] = part.split('/');
    const step = stepStr ? parseInt(stepStr, 10) : 1;
    if (!step || step < 1) return true; // malformed → don't block
    let lo: number, hi: number;
    if (range === '*') { lo = min; hi = max; }
    else if (range.includes('-')) { const [a, b] = range.split('-').map(Number); lo = a; hi = b; }
    else { lo = hi = Number(range); }
    if (Number.isNaN(lo) || Number.isNaN(hi)) return true; // malformed → don't block
    for (let v = lo; v <= hi; v += step) if (v === value) return true;
  }
  return false;
}

export function shouldRunToday(cron: string | null | undefined, date: Date = new Date()): boolean {
  const parts = String(cron ?? '').trim().split(/\s+/);
  if (parts.length < 5) return true; // no/short schedule → run (don't block)

  const [, , dom, mon, dow] = parts;
  const day     = date.getUTCDate();      // 1-31
  const month   = date.getUTCMonth() + 1;  // 1-12
  const weekday = date.getUTCDay();        // 0-6 (Sun = 0)

  if (!matchField(mon, month, 1, 12)) return false;

  // cron day-of-week allows both 0 and 7 for Sunday
  const dowOk = dom === '?' || dow === '*' || dow === '?'
    || matchField(dow, weekday, 0, 6)
    || (weekday === 0 && matchField(dow, 7, 0, 7));
  const domOk = matchField(dom, day, 1, 31);

  const domRestricted = dom !== '*' && dom !== '?';
  const dowRestricted = dow !== '*' && dow !== '?';
  // Standard cron: if BOTH day-of-month and day-of-week are restricted, match
  // EITHER; otherwise require both (the unrestricted one is always true).
  return (domRestricted && dowRestricted) ? (domOk || dowOk) : (domOk && dowOk);
}
