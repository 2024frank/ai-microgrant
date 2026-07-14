import pool from './db';
import { getAdminContact } from './adminContact';
import {
  type CommunityHubPayload,
  type CommunityHubPayloadIssue,
  validateCommunityHubPayload,
} from './communityHubPayload';
import { computeDedupKey } from './eventDedup';
import { validatePublicHttpUrl } from './publicHttpUrl';

export interface IngestionSource {
  id: number;
  name: string;
  slug?: string;
  calendar_source_name?: string | null;
}

export interface IngestionIssueReport {
  index: number;
  title: string;
  inserted: boolean;
  issues: CommunityHubPayloadIssue[];
}

export interface PersistedEvent {
  id: number;
  title: string;
  ingested_post_url: string;
  validation_errors: CommunityHubPayloadIssue[];
}

export interface PersistedEventsResult {
  inserted: PersistedEvent[];
  skipped: number;
  duplicates: number;
  invalid: number;
  failed: number;
  errors: IngestionIssueReport[];
}

export interface PersistExtractedEventsOptions {
  /**
   * When this run was created for a reviewer correction, accept exactly one
   * object and require it to identify the claimed event. This keeps an agent
   * from turning a correction run into an unrelated batch ingestion.
   */
  expectedCorrectionEventId?: number;
}

const GEO_SCOPES = new Set([
  'local', 'hyper_local', 'city_wide', 'county', 'regional', 'national',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\0/g, '').trim();
  return text ? text.slice(0, maxLength) : null;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseCorrectionId(value: unknown): number | null {
  if (
    typeof value !== 'number'
    && (typeof value !== 'string' || !/^\d+$/.test(value))
  ) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function isSafePosterUrl(value: unknown): value is string {
  return typeof value === 'string'
    && value.startsWith('https:')
    && validatePublicHttpUrl(value).success;
}

function canonicalStoredValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed !== null && typeof parsed === 'object') return JSON.stringify(parsed);
    } catch {
      // Plain text.
    }
  }
  return String(value);
}

function issue(path: string, code: string, message: string): CommunityHubPayloadIssue {
  return { path, code, message };
}

function mergeIssues(...groups: CommunityHubPayloadIssue[][]): CommunityHubPayloadIssue[] {
  const seen = new Set<string>();
  return groups.flat().filter(current => {
    const key = `${current.path}\u0000${current.code}\u0000${current.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildCandidate(
  raw: Record<string, unknown>,
  source: IngestionSource,
  submitterEmail: string,
): { payload: CommunityHubPayload; issues: CommunityHubPayloadIssue[] } {
  const rawImage = readString(raw.image_cdn_url);
  const result = validateCommunityHubPayload({
    ...raw,
    email: submitterEmail,
    calendarSourceName:
      readString(raw.calendarSourceName)
      || source.calendar_source_name
      || source.name,
    // A data URI is retained as image_data below; it is not an outbound URL.
    image_cdn_url: rawImage.startsWith('data:') ? undefined : rawImage || undefined,
  });

  return result.success
    ? { payload: result.data, issues: [] }
    : { payload: result.normalized, issues: result.errors };
}

/**
 * Persist untrusted extractor output without letting one malformed item roll
 * back the rest of a run. Drafts with fixable contract issues remain visible
 * to reviewers and carry field-level validation errors. Drafts without a title
 * or description are rejected because the database cannot represent them
 * truthfully.
 */
export async function persistExtractedEvents(
  events: unknown[],
  source: IngestionSource,
  runId: number,
  options: PersistExtractedEventsOptions = {},
): Promise<PersistedEventsResult> {
  const expectedCorrectionEventId = options.expectedCorrectionEventId;
  if (expectedCorrectionEventId !== undefined && events.length !== 1) {
    const count = Math.max(events.length, 1);
    return {
      inserted: [],
      skipped: count,
      duplicates: 0,
      invalid: count,
      failed: count,
      errors: [{
        index: -1,
        title: 'Correction output',
        inserted: false,
        issues: [issue(
          '$',
          'correction_count',
          'a correction run must return exactly one event',
        )],
      }],
    };
  }

  const adminContact = await getAdminContact();
  const submitterEmail = (
    process.env.COMMUNITYHUB_EMAIL?.trim()
    || adminContact
    || ''
  );
  const appUrl = (
    process.env.APP_URL
    || process.env.NEXT_PUBLIC_APP_URL
    || 'https://ai-microgrant-research-oberlin.vercel.app'
  ).replace(/\/$/, '');

  const inserted: PersistedEvent[] = [];
  const errors: IngestionIssueReport[] = [];
  let skipped = 0;
  let duplicates = 0;
  let invalid = 0;
  let failed = 0;
  const conn = await pool.getConnection();

  try {
    for (const [index, input] of events.entries()) {
      const raw = asRecord(input);
      if (!raw) {
        skipped++;
        invalid++;
        failed++;
        errors.push({
          index,
          title: 'Untitled item',
          inserted: false,
          issues: [issue('$', 'invalid_type', 'event must be an object')],
        });
        continue;
      }

      const { payload, issues } = buildCandidate(raw, source, submitterEmail);
      const title = payload.title || cleanText(raw.title, 60) || 'Untitled item';

      // Do not invent the two core content fields. Other missing required
      // fields can be corrected in the review studio.
      const fatalIssues: CommunityHubPayloadIssue[] = [];
      if (!payload.title) fatalIssues.push(issue('title', 'required', 'is required for ingestion'));
      if (!payload.description) {
        fatalIssues.push(issue('description', 'required', 'is required for ingestion'));
      }
      if (fatalIssues.length > 0) {
        skipped++;
        invalid++;
        failed++;
        errors.push({
          index,
          title,
          inserted: false,
          issues: mergeIssues(issues, fatalIssues),
        });
        continue;
      }

      const fixedFromId = parseCorrectionId(raw.fixedFromEventId);
      if (
        expectedCorrectionEventId !== undefined
        && fixedFromId !== expectedCorrectionEventId
      ) {
        skipped++;
        invalid++;
        failed++;
        errors.push({
          index,
          title,
          inserted: false,
          issues: [issue(
            'fixedFromEventId',
            'correction_mismatch',
            `must equal the correction run target ${expectedCorrectionEventId}`,
          )],
        });
        continue;
      }
      let fixEntry: any = null;
      if (raw.fixedFromEventId !== undefined) {
        if (!fixedFromId) {
          skipped++;
          invalid++;
          failed++;
          errors.push({
            index,
            title,
            inserted: false,
            issues: [issue('fixedFromEventId', 'invalid_id', 'must identify an open correction request')],
          });
          continue;
        }
        // The request is claimed with row locks inside the per-item
        // transaction below. Looking it up here would allow concurrent direct
        // posts to both observe and replace the same original.
      }

      const dedupKey = computeDedupKey(
        payload.title,
        payload.sessions,
        payload.eventType,
        payload.description,
        payload.extendedDescription,
      );
      if (!fixedFromId) {
        const [duplicateRows] = await conn.query(
          `SELECT id FROM raw_events
           WHERE source_id = ? AND dedup_key = ?
             AND status IN ('pending','approved','pending_fix','publishing')
           LIMIT 1`,
          [source.id, dedupKey],
        ) as any;
        if (Array.isArray(duplicateRows) && duplicateRows.length > 0) {
          skipped++;
          duplicates++;
          continue;
        }
      }

      const rawImage = readString(raw.image_cdn_url);
      let imageData: string | null = rawImage.startsWith('data:') ? rawImage : null;
      const imageIssues: CommunityHubPayloadIssue[] = [];
      const posterUrls = Array.isArray(raw.poster_urls)
        ? raw.poster_urls.filter(isSafePosterUrl).slice(0, 8)
        : [];
      if (!imageData && posterUrls.length > 0) {
        try {
          const { mergePosterImages } = await import('./mergePosters');
          imageData = await mergePosterImages(posterUrls);
        } catch {
          imageIssues.push(issue(
            'poster_urls',
            'image_processing_failed',
            'poster images could not be decoded; the event was kept without an embedded poster',
          ));
        }
      }
      const storedImageUrl = rawImage && !rawImage.startsWith('data:')
        ? payload.image_cdn_url ?? null
        : null;

      const validationErrors = mergeIssues(issues, imageIssues);
      const hadValidationErrors = validationErrors.length > 0;
      if (hadValidationErrors) invalid++;

      try {
        await (conn as any).beginTransaction();
        let originalEvent: any = null;
        if (fixedFromId) {
          const [[row]] = await conn.query(
            `SELECT * FROM needs_fix
             WHERE raw_event_id = ? AND source_id = ?
             LIMIT 1 FOR UPDATE`,
            [fixedFromId, source.id],
          ) as any;
          const [[original]] = await conn.query(
            `SELECT * FROM raw_events
             WHERE id = ? AND source_id = ? AND status = 'pending_fix'
             LIMIT 1 FOR UPDATE`,
            [fixedFromId, source.id],
          ) as any;
          fixEntry = row ?? null;
          originalEvent = original ?? null;
          if (!fixEntry || !original) {
            await (conn as any).rollback();
            skipped++;
            invalid++;
            failed++;
            errors.push({
              index,
              title,
              inserted: false,
              issues: [issue(
                'fixedFromEventId',
                'not_found',
                'does not match an open correction request',
              )],
            });
            continue;
          }
        }

        const [result] = await conn.query(
          `INSERT INTO raw_events (
            source_id, agent_run_id, event_type, title, description,
            extended_description, sponsors, post_type_ids, sessions,
            location_type, location, place_id, place_name, room_num,
            url_link, display, screen_ids, buttons, contact_email, email,
            phone, website, image_cdn_url, image_data, calendar_source_name,
            calendar_source_url, geo_scope, geo_json, corrected_from_id,
            sent_for_fix_by, dedup_key, validation_errors, status
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')`,
          [
            source.id,
            runId,
            payload.eventType,
            payload.title,
            payload.description,
            payload.extendedDescription ?? null,
            JSON.stringify(payload.sponsors),
            JSON.stringify(payload.postTypeId),
            JSON.stringify(payload.sessions),
            payload.locationType,
            payload.location ?? null,
            payload.placeId || null,
            payload.placeName ?? null,
            payload.roomNum ?? null,
            payload.urlLink || null,
            payload.display,
            JSON.stringify(payload.screensIds),
            JSON.stringify(payload.buttons),
            payload.contactEmail ?? null,
            payload.email || null,
            payload.phone || null,
            payload.website || null,
            storedImageUrl,
            imageData,
            payload.calendarSourceName ?? source.calendar_source_name ?? source.name,
            payload.calendarSourceUrl ?? null,
            GEO_SCOPES.has(readString(raw.geo_scope)) ? readString(raw.geo_scope) : null,
            raw.geo ? JSON.stringify(raw.geo) : null,
            fixedFromId,
            cleanText(fixEntry?.sent_by_email, 150),
            dedupKey,
            validationErrors.length ? JSON.stringify(validationErrors) : null,
          ],
        ) as any;

        const eventId = result.insertId;
        const ingestedPostUrl = `${appUrl}/reviewer/events/${eventId}`;
        const servingImageUrl = imageData
          ? `${appUrl}/api/events/${eventId}/poster.jpg`
          : null;
        await conn.query(
          `UPDATE raw_events
           SET ingested_post_url = ?, image_cdn_url = COALESCE(?, image_cdn_url)
           WHERE id = ?`,
          [ingestedPostUrl, servingImageUrl, eventId],
        );

        if (fixedFromId && fixEntry) {
          const [supersede] = await conn.query(
            `UPDATE raw_events
             SET status = 'superseded', superseded_by_id = ?
             WHERE id = ? AND status = 'pending_fix'`,
            [eventId, fixedFromId],
          ) as any;
          if (supersede.affectedRows !== 1) {
            throw new Error('correction target is no longer pending');
          }

          const correctedValues: Record<string, unknown> = {
            event_type: payload.eventType,
            title: payload.title,
            description: payload.description,
            extended_description: payload.extendedDescription ?? null,
            sponsors: payload.sponsors,
            post_type_ids: payload.postTypeId,
            sessions: payload.sessions,
            location_type: payload.locationType,
            location: payload.location ?? null,
            place_id: payload.placeId ?? null,
            place_name: payload.placeName ?? null,
            room_num: payload.roomNum ?? null,
            url_link: payload.urlLink ?? null,
            display: payload.display,
            screen_ids: payload.screensIds,
            buttons: payload.buttons,
            contact_email: payload.contactEmail ?? null,
            phone: payload.phone ?? null,
            website: payload.website ?? null,
            calendar_source_name: payload.calendarSourceName ?? null,
            calendar_source_url: payload.calendarSourceUrl ?? null,
          };
          for (const [field, correctedValue] of Object.entries(correctedValues)) {
            const oldValue = canonicalStoredValue(originalEvent?.[field]);
            const newValue = canonicalStoredValue(correctedValue);
            if (oldValue === newValue) continue;
            await conn.query(
              `INSERT INTO field_edit_log
               (raw_event_id, source_id, reviewer_id, field_name, old_value, new_value)
               VALUES (?,?,?,?,?,?)`,
              [
                fixedFromId,
                source.id,
                fixEntry.sent_by_user_id ?? null,
                field,
                oldValue,
                newValue,
              ],
            );
          }
          await conn.query(
            `INSERT INTO rejection_log
             (raw_event_id, source_id, reviewer_id, reason_codes, reviewer_note, event_title, event_snapshot)
             VALUES (?,?,?,?,?,?,?)`,
            [
              fixedFromId,
              source.id,
              fixEntry.sent_by_user_id ?? null,
              JSON.stringify(['field_correction']),
              cleanText(fixEntry.correction_notes, 2000),
              originalEvent?.title ?? payload.title,
              JSON.stringify(originalEvent ?? {}),
            ],
          );
          await conn.query('DELETE FROM needs_fix WHERE raw_event_id = ?', [fixedFromId]);
          if (fixEntry.sent_by_user_id) {
            const parts = [
              fixEntry.correction_notes ? `You asked: ${fixEntry.correction_notes}` : '',
              raw.fixSummary ? `Fixed: ${cleanText(raw.fixSummary, 500)}` : '',
            ].filter(Boolean);
            await conn.query(
              `INSERT INTO notifications (user_id, type, title, message, raw_event_id)
               VALUES (?, 'event_fixed', ?, ?, ?)`,
              [
                fixEntry.sent_by_user_id,
                `Fixed: ${payload.title}`,
                parts.join(' · ') || 'The corrected event is ready to review.',
                eventId,
              ],
            );
          }
        }

        await (conn as any).commit();
        inserted.push({
          id: eventId,
          title: payload.title,
          ingested_post_url: ingestedPostUrl,
          validation_errors: validationErrors,
        });
        if (validationErrors.length > 0) {
          errors.push({ index, title, inserted: true, issues: validationErrors });
        }
      } catch (error) {
        await (conn as any).rollback();
        skipped++;
        failed++;
        if (!hadValidationErrors) invalid++;
        errors.push({
          index,
          title,
          inserted: false,
          issues: [issue('$', 'database_error', error instanceof Error ? error.message : 'database write failed')],
        });
      }
    }
  } finally {
    (conn as any).release();
  }

  return { inserted, skipped, duplicates, invalid, failed, errors };
}
