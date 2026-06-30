import { createHash } from 'node:crypto';

function norm(s: unknown): string {
  return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Build a stable dedup signature so the same listing is not ingested twice
 * (the Apollo / FAVA re-scrape problem), scoped by source_id at the lookup.
 *
 * Two identities, because the two content types are stable along different axes:
 *
 *  - **Announcements** (`eventType: 'an'`, e.g. Apollo "Showing Now") roll their
 *    display window EVERY run (`windowStart = today`), so the session times are
 *    NOT a stable identity — keying on them re-posts the same lineup daily. Their
 *    stable identity is the CONTENT: title + description (the movie lineup). So a
 *    re-run with the same lineup collides (skipped); a genuinely changed lineup
 *    gets a new key (kept).
 *
 *  - **Events** keep title + the SET of session start/end windows, so the same
 *    title with a different time (a different segment, a class re-offered on new
 *    dates) stays distinct while an exact re-scrape collides.
 */
export function computeDedupKey(
  title: string,
  sessions: Array<{ startTime?: unknown; endTime?: unknown }> | null | undefined,
  eventType?: string,
  description?: string,
): string {
  const normTitle = norm(title);

  if (eventType === 'an') {
    return createHash('sha1').update(`an::${normTitle}::${norm(description)}`).digest('hex');
  }

  const windows = Array.isArray(sessions)
    ? sessions.map(s => `${s?.startTime ?? ''}-${s?.endTime ?? ''}`).sort().join(',')
    : '';
  return createHash('sha1').update(`${normTitle}::${windows}`).digest('hex');
}
