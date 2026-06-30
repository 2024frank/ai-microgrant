import { createHash } from 'node:crypto';

function norm(s: unknown): string {
  return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function sessionWindows(sessions: Array<{ startTime?: unknown; endTime?: unknown }> | null | undefined): string {
  return Array.isArray(sessions)
    ? sessions.map(s => `${s?.startTime ?? ''}-${s?.endTime ?? ''}`).sort().join(',')
    : '';
}

/**
 * Build a stable dedup signature so the same listing is not ingested twice
 * (the Apollo / FAVA re-scrape problem), scoped by source_id at the lookup.
 *
 *  - **Announcements** (`eventType: 'an'`, e.g. Apollo "Showing Now"): a true
 *    duplicate is ONLY when the short description AND the extended description
 *    AND the date ranges (sessions) are all identical. If any of those differ —
 *    a changed lineup, a different window — it is a new announcement. (This is
 *    the rule for the segmented Apollo announcements.)
 *
 *  - **Events**: title + the SET of session start/end windows, so the same
 *    title at a different time (a different segment, a class re-offered on new
 *    dates) stays distinct while an exact re-scrape collides.
 */
export function computeDedupKey(
  title: string,
  sessions: Array<{ startTime?: unknown; endTime?: unknown }> | null | undefined,
  eventType?: string,
  description?: string,
  extendedDescription?: string,
): string {
  const normTitle = norm(title);
  const windows = sessionWindows(sessions);

  if (eventType === 'an') {
    // Key on the window END only. The feed runs "a day ahead", so an unchanged
    // lineup's leading window advances its START by one day every run; including
    // the start would mint a new dedup key daily and pile up near-duplicate review
    // rows. The end is fixed by a film's last day / the next opening, so it is
    // stable run-to-run, while a changed lineup still changes the description.
    const endWindows = Array.isArray(sessions)
      ? sessions.map(s => String(s?.endTime ?? '')).sort().join(',')
      : '';
    return createHash('sha1')
      .update(`an::${normTitle}::${norm(description)}::${norm(extendedDescription)}::${endWindows}`)
      .digest('hex');
  }

  return createHash('sha1').update(`${normTitle}::${windows}`).digest('hex');
}
