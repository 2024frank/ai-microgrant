import { createHash } from 'node:crypto';
import pool from './db';
import { fieldAuditValue } from './fieldAuditValue';
import { boundedEventSnapshot } from './eventImagePrivacy';
import { getAdminContact } from './adminContact';
import {
  type CommunityHubPayload,
  type CommunityHubPayloadIssue,
  getCommunityHubExpirationIssue,
  validateCommunityHubPayload,
} from './communityHubPayload';
import { computeDedupKey } from './eventDedup';
import { validatePublicHttpUrl } from './publicHttpUrl';
import { applyContentPolicy } from './contentPolicy';
import {
  fetchCommunityHubInventory,
  findBestContentMatch,
  type CommunityHubInventory,
  type ContentMatch,
} from './communityHubInventory';
import {
  buildRunComparisonReport,
  diffCandidateAgainstRemote,
  loadRetainedLocalRows,
  organizationNamesForSource,
  recordRunComparison,
  remotePostSnapshot,
  type CandidatePayloadSnapshot,
  type ComparisonCandidate,
} from './runComparison';

const MAX_POSTER_IMAGES = 4;

export interface IngestionSource {
  id: number;
  name: string;
  slug?: string;
  calendar_source_name?: string | null;
  source_kind?: 'original_org' | 'aggregator' | null;
  org_sponsor_name?: string | null;
  org_website?: string | null;
  org_phone?: string | null;
  org_contact_email?: string | null;
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
  /** Duplicates preserved as raw_events rows (status='duplicate') for quality review. */
  duplicates_preserved: number;
  /** Contract-invalid drafts automatically rejected as "Required fields are missing." */
  auto_rejected: number;
  invalid: number;
  failed: number;
  errors: IngestionIssueReport[];
  comparison: ComparisonCandidate[];
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

function parseJsonArray(value: unknown): unknown[] {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * Stamp stable organization facts from the integration configuration instead
 * of relying on the agent to rediscover them each run (2026-07-16 meeting,
 * item 9). Only explicitly configured values are used: an aggregator or a
 * shared email inbox is not the organizer of the events it relays, so nothing
 * is stamped for a source without configured metadata. Contact details only
 * fill gaps so a per-event contact from the source still wins.
 */
function applySourceOrganizationMetadata(
  candidate: Record<string, unknown>,
  source: IngestionSource,
): void {
  if (source.source_kind === 'aggregator') return;
  const sponsorOfRecord = readString(source.org_sponsor_name);
  if (sponsorOfRecord) {
    const sponsors = parseJsonArray(candidate.sponsors)
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map(item => item.trim());
    const present = sponsors.some(
      item => item.toLocaleLowerCase('en-US') === sponsorOfRecord.toLocaleLowerCase('en-US'),
    );
    candidate.sponsors = present ? sponsors : [sponsorOfRecord, ...sponsors];
  }
  if (!readString(candidate.website) && readString(source.org_website)) {
    candidate.website = readString(source.org_website);
  }
  if (!readString(candidate.phone) && readString(source.org_phone)) {
    candidate.phone = readString(source.org_phone);
  }
  if (!readString(candidate.contactEmail) && !readString(candidate.contact_email)
    && readString(source.org_contact_email)) {
    candidate.contactEmail = readString(source.org_contact_email);
  }
}

function buildCandidate(
  raw: Record<string, unknown>,
  source: IngestionSource,
  submitterEmail: string,
): {
  payload: CommunityHubPayload;
  issues: CommunityHubPayloadIssue[];
  adjustments: string[];
} {
  const rawImage = readString(raw.image_cdn_url);
  const policy = applyContentPolicy(raw);
  const candidate = {
    ...policy.record,
    email: submitterEmail,
    calendarSourceName:
      readString(raw.calendarSourceName)
      || source.calendar_source_name
      || source.name,
    // A data URI is retained as image_data below; it is not an outbound URL.
    image_cdn_url: rawImage.startsWith('data:') ? undefined : rawImage || undefined,
  };
  applySourceOrganizationMetadata(candidate, source);
  let result = validateCommunityHubPayload(candidate);
  // Venue calendars rarely name an organizer, so extractors legitimately omit
  // sponsors; the source itself is the organizer of record.
  if (
    !result.success
    && result.errors.some(current => current.path === 'sponsors' && current.code === 'required')
  ) {
    result = validateCommunityHubPayload({
      ...candidate,
      sponsors: [source.calendar_source_name || source.name],
    });
  }

  return result.success
    ? { payload: result.data, issues: policy.issues, adjustments: policy.adjustments }
    : {
        payload: result.normalized,
        issues: mergeIssues(policy.issues, result.errors),
        adjustments: policy.adjustments,
      };
}

const INVENTORY_CACHE_TTL_MS = 5 * 60 * 1000;
let inventoryCache: { fetchedAt: number; inventory: CommunityHubInventory } | null = null;

/** Test hook: clear the shared inventory cache between cases. */
export function resetInventoryCacheForTests(): void {
  inventoryCache = null;
}

async function loadInventoryForComparison(): Promise<{
  inventory: CommunityHubInventory | null;
  inventoryError: string | null;
}> {
  if (inventoryCache && Date.now() - inventoryCache.fetchedAt < INVENTORY_CACHE_TTL_MS) {
    return { inventory: inventoryCache.inventory, inventoryError: null };
  }
  try {
    const inventory = await fetchCommunityHubInventory();
    inventoryCache = { fetchedAt: Date.now(), inventory };
    return { inventory, inventoryError: null };
  } catch (error) {
    return {
      inventory: null,
      inventoryError: error instanceof Error ? error.message : 'CommunityHub inventory fetch failed',
    };
  }
}

function comparisonInventoryDigest(inventory: CommunityHubInventory): string {
  const canonical = inventory.posts
    .map(post => ({
      title: post.title,
      eventType: post.eventType,
      sessions: post.sessions,
      description: post.description,
      moderation: post.moderation,
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function candidatePayloadSnapshot(payload: CommunityHubPayload): CandidatePayloadSnapshot {
  return {
    event_type: payload.eventType,
    title: payload.title,
    description: payload.description,
    extended_description: payload.extendedDescription ?? null,
    sessions: payload.sessions,
    sponsors: payload.sponsors,
    post_type_ids: payload.postTypeId,
    location: payload.location ?? null,
    calendar_source_url: payload.calendarSourceUrl ?? null,
    buttons: payload.buttons,
  };
}

function communityHubMatchEvidence(
  payload: CommunityHubPayload,
  match: ContentMatch,
): ComparisonCandidate['communityhub_match'] {
  if (match.kind === 'none' || !match.remote) return null;
  return {
    kind: match.kind,
    reasons: match.reasons,
    field_diffs: diffCandidateAgainstRemote(candidatePayloadSnapshot(payload), match.remote),
    remote: remotePostSnapshot(match.remote),
  };
}

/**
 * Persist one run's two-way comparison. Email runs persist per message, so a
 * later call merges the earlier candidates before recomputing both directions.
 */
async function persistRunComparison(
  runId: number,
  source: IngestionSource,
  candidates: ComparisonCandidate[],
  inventory: CommunityHubInventory | null,
  inventoryError: string | null,
): Promise<void> {
  try {
    const [[existing]] = await pool.query(
      'SELECT report FROM integration_run_comparisons WHERE agent_run_id=? LIMIT 1',
      [runId],
    ) as any;
    let merged = candidates;
    if (existing?.report) {
      try {
        const prior = typeof existing.report === 'string'
          ? JSON.parse(existing.report)
          : existing.report;
        if (Array.isArray(prior?.candidates)) {
          const offset = prior.candidates.length;
          merged = [
            ...prior.candidates,
            ...candidates.map(candidate => ({ ...candidate, index: candidate.index + offset })),
          ];
        }
      } catch {
        // An unreadable prior report is replaced by this call's candidates.
      }
    }
    const report = buildRunComparisonReport({
      organizationNames: organizationNamesForSource(source),
      candidates: merged,
      inventory,
      inventoryError,
      retainedLocalRows: await loadRetainedLocalRows(source.id),
    });
    await recordRunComparison({
      runId,
      sourceId: source.id,
      report,
      inventory,
      inventorySha256: inventory ? comparisonInventoryDigest(inventory) : null,
    });
  } catch (error) {
    // The comparison is an observability artifact; never fail the run for it.
    console.error(
      `[ingestion] run=${runId} could not record the run comparison:`,
      error instanceof Error ? error.message : error,
    );
  }
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
      duplicates_preserved: 0,
      auto_rejected: 0,
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
      comparison: [],
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
  const comparison: ComparisonCandidate[] = [];
  let skipped = 0;
  let duplicates = 0;
  let duplicatesPreserved = 0;
  let autoRejected = 0;
  let invalid = 0;
  let failed = 0;

  // Correction runs replace one known local event; comparing them against the
  // remote calendar would only re-flag the original they are fixing.
  const isCorrectionRun = expectedCorrectionEventId !== undefined;
  const { inventory, inventoryError } = isCorrectionRun
    ? { inventory: null, inventoryError: null }
    : await loadInventoryForComparison();

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

      const { payload, issues, adjustments } = buildCandidate(raw, source, submitterEmail);
      const title = payload.title || cleanText(raw.title, 60) || 'Untitled item';
      const comparisonEntry: ComparisonCandidate = {
        index,
        title,
        outcome: 'invalid',
        event_id: null,
        duplicate_of_event_id: null,
        payload: candidatePayloadSnapshot(payload),
        communityhub_match: inventory
          ? communityHubMatchEvidence(payload, findBestContentMatch({
              title: payload.title,
              eventType: payload.eventType,
              description: payload.description,
              extendedDescription: payload.extendedDescription,
              calendarSourceUrl: payload.calendarSourceUrl,
              sessions: payload.sessions,
            }, inventory.posts))
          : null,
        issues: [],
        adjustments,
      };
      comparison.push(comparisonEntry);

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
        comparisonEntry.issues = mergeIssues(issues, fatalIssues);
        errors.push({
          index,
          title,
          inserted: false,
          issues: mergeIssues(issues, fatalIssues),
        });
        continue;
      }

      const expirationIssue = getCommunityHubExpirationIssue(payload.sessions);
      if (expirationIssue) {
        skipped++;
        invalid++;
        failed++;
        comparisonEntry.issues = mergeIssues(issues, [expirationIssue]);
        errors.push({
          index,
          title,
          inserted: false,
          issues: mergeIssues(issues, [expirationIssue]),
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

      // A correction may not supersede its evidence while documented payload
      // blockers remain. The original stays recoverable and the failed run is
      // surfaced to the reviewer instead of being labeled "fixed".
      if (fixedFromId && issues.length > 0) {
        skipped++;
        invalid++;
        failed++;
        errors.push({ index, title, inserted: false, issues });
        continue;
      }

      const dedupKey = computeDedupKey(
        payload.title,
        payload.sessions,
        payload.eventType,
        payload.description,
        payload.extendedDescription,
      );
      const rawImage = readString(raw.image_cdn_url);
      let imageData: string | null = null;
      const imageIssues: CommunityHubPayloadIssue[] = [];

      // Embedded images are untrusted model output. Decode and normalize them
      // once at the write boundary so malformed, oversized, or deceptive bytes
      // never become durable poster data. A bad optional poster does not discard
      // an otherwise useful event; reviewers get a precise validation issue.
      if (rawImage.startsWith('data:')) {
        try {
          const { normalizeEmbeddedImageData } = await import('./safeRemoteImage');
          imageData = await normalizeEmbeddedImageData(rawImage);
        } catch {
          imageIssues.push(issue(
            'image_cdn_url',
            'invalid_embedded_image',
            'the embedded poster was unsafe or could not be decoded; the event was kept without it',
          ));
        }
      }

      const rawPosterUrls = Array.isArray(raw.poster_urls) ? raw.poster_urls : [];
      if (rawPosterUrls.length > MAX_POSTER_IMAGES) {
        imageIssues.push(issue(
          'poster_urls',
          'too_many_posters',
          `only the first ${MAX_POSTER_IMAGES} poster URLs were inspected and processed`,
        ));
      }
      const inspectedPosterUrls = rawPosterUrls.slice(0, MAX_POSTER_IMAGES);
      const safePosterUrls = inspectedPosterUrls.filter(isSafePosterUrl);
      const unsafePosterCount = inspectedPosterUrls.length - safePosterUrls.length;
      if (unsafePosterCount > 0) {
        imageIssues.push(issue(
          'poster_urls',
          'unsafe_poster_url',
          `${unsafePosterCount} poster URL${unsafePosterCount === 1 ? ' was' : 's were'} ignored because only public HTTPS image URLs are allowed`,
        ));
      }
      const posterUrls = safePosterUrls;
      if (!imageData && posterUrls.length > 0) {
        try {
          const { mergePosterImages } = await import('./mergePosters');
          imageData = await mergePosterImages(posterUrls);
          if (!imageData) {
            imageIssues.push(issue(
              'poster_urls',
              'poster_images_unusable',
              'none of the poster images could be safely decoded and merged; the event was kept without an embedded poster',
            ));
          }
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

      // The contract requires the source's event image; an event that
      // arrives without one is held from publishing until a reviewer adds
      // it (corrections are exempt so a fix for another field can land).
      if (!imageData && !storedImageUrl && !fixedFromId) {
        imageIssues.push(issue(
          'image_cdn_url',
          'image_missing',
          'the agent supplied no event image; add the image from the source page before publishing',
        ));
      }

      const validationErrors = mergeIssues(issues, imageIssues);
      const hadValidationErrors = validationErrors.length > 0;
      comparisonEntry.issues = validationErrors;
      if (fixedFromId && hadValidationErrors) {
        skipped++;
        invalid++;
        failed++;
        errors.push({ index, title, inserted: false, issues: validationErrors });
        continue;
      }
      if (hadValidationErrors) invalid++;

      // Required-field policy (meeting item 12): a draft that cannot satisfy
      // the documented contract is rejected as "Required fields are missing"
      // and preserved with its reason so the correction workflow can requeue
      // it — instead of sitting silently blocked in the review queue.
      const missingRequiredIssues = validationErrors.filter(current => (
        current.code === 'required' || current.code === 'too_short'
      ));
      const autoRejectForMissingFields = !fixedFromId && missingRequiredIssues.length > 0;

      try {
        await (conn as any).beginTransaction();
        let originalEvent: any = null;
        if (fixedFromId) {
          const [[activeRun]] = await conn.query(
            `SELECT id FROM agent_runs
             WHERE id=? AND source_id=? AND correction_event_id=? AND status='running'
             LIMIT 1 FOR UPDATE`,
            [runId, source.id, fixedFromId],
          ) as any;
          if (!activeRun) {
            throw new Error('correction run lease is no longer active');
          }
          const [[row]] = await conn.query(
            `SELECT * FROM needs_fix
             WHERE raw_event_id = ? AND source_id = ?
             LIMIT 1 FOR UPDATE`,
            [fixedFromId, source.id],
          ) as any;
          const [[original]] = await conn.query(
            `SELECT * FROM raw_events
             WHERE id = ? AND source_id = ?
               AND (
                 status = 'pending_fix'
                 OR (status = 'rejected' AND sent_for_correction = 1)
               )
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

        // The indexed equality lookup with FOR UPDATE takes an InnoDB next-key
        // lock. Concurrent ingests for the same source+signature therefore
        // cannot both pass the check and insert an active duplicate. Preserved
        // 'duplicate' rows participate so quality evidence is captured once,
        // not on every re-scrape, and 'rejected' rows participate so a
        // re-scrape of identical content can never re-enter review or trigger
        // the auto-reject/requeue loop again. A corrected version with real
        // changes gets a different signature and still comes back.
        const [duplicateRows] = await conn.query(
          `SELECT id FROM raw_events
           WHERE source_id=? AND dedup_key=?
             AND status IN ('pending','submitted','approved','pending_fix','publishing','resubmitted','duplicate','rejected')
             ${fixedFromId ? 'AND id<>?' : ''}
           LIMIT 1 FOR UPDATE`,
          fixedFromId ? [source.id, dedupKey, fixedFromId] : [source.id, dedupKey],
        ) as any;
        if (Array.isArray(duplicateRows) && duplicateRows.length > 0) {
          await (conn as any).rollback();
          skipped++;
          duplicates++;
          comparisonEntry.outcome = 'duplicate_local';
          comparisonEntry.duplicate_of_event_id = Number(duplicateRows[0].id) || null;
          continue;
        }

        // Deterministic source priority (meeting item 11): an aggregator's
        // candidate that a more direct source already produced is preserved as
        // a duplicate of that event instead of entering review again.
        let crossSourceDuplicateOfId: number | null = null;
        if (!fixedFromId && source.source_kind === 'aggregator') {
          const [crossRows] = await conn.query(
            `SELECT re.id FROM raw_events re
             JOIN sources s ON s.id=re.source_id
             WHERE re.dedup_key=? AND re.source_id<>?
               AND s.source_kind='original_org'
               AND re.status IN ('pending','submitted','approved','pending_fix','publishing','resubmitted')
             ORDER BY re.id ASC LIMIT 1`,
            [dedupKey, source.id],
          ) as any;
          if (Array.isArray(crossRows) && crossRows.length > 0) {
            crossSourceDuplicateOfId = Number(crossRows[0].id) || null;
          }
        }

        // A candidate whose content already exists on the CommunityHub
        // calendar (approved or pending) is preserved for quality evaluation
        // instead of being discarded or re-reviewed (meeting item 1). A
        // heuristic 'probable' match may only suppress a candidate when it
        // has temporal evidence; a recurring event sharing a title and a
        // generic calendar URL with an OLDER post is a new occurrence, not a
        // duplicate, and must reach review (the match evidence still appears
        // in the run comparison for the reviewer).
        const chMatch = comparisonEntry.communityhub_match;
        const probableHasTemporalEvidence = chMatch !== null
          && chMatch.kind === 'probable'
          && chMatch.reasons.some(reason => (
            reason === 'shared session start'
            || reason === 'shared session date'
            || reason === 'session date in post content'
          ));
        const isCommunityHubDuplicate = !fixedFromId
          && crossSourceDuplicateOfId === null
          && chMatch !== null
          && (chMatch.kind === 'exact' || probableHasTemporalEvidence);

        const rowStatus = fixedFromId
          ? 'pending'
          : crossSourceDuplicateOfId !== null || isCommunityHubDuplicate
            ? 'duplicate'
            : autoRejectForMissingFields
              ? 'rejected'
              : 'pending';

        const [result] = await conn.query(
          `INSERT INTO raw_events (
            source_id, agent_run_id, event_type, title, description,
            extended_description, sponsors, post_type_ids, sessions,
            location_type, location, place_id, place_name, room_num,
            url_link, display, screen_ids, buttons, contact_email, email,
            phone, website, image_cdn_url, image_data, calendar_source_name,
            calendar_source_url, geo_scope, geo_json, corrected_from_id,
            sent_for_fix_by, dedup_key, validation_errors, duplicate_of_id,
            communityhub_match, status
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
            crossSourceDuplicateOfId,
            isCommunityHubDuplicate
              ? JSON.stringify(comparisonEntry.communityhub_match)
              : null,
            rowStatus,
          ],
        ) as any;

        const eventId = result.insertId;
        const ingestedPostUrl = `${appUrl}/reviewer/events/${eventId}`;
        await conn.query(
          `UPDATE raw_events
           SET ingested_post_url = ?
           WHERE id = ?`,
          [ingestedPostUrl, eventId],
        );

        if (rowStatus === 'rejected') {
          const missingSummary = missingRequiredIssues
            .map(current => `${current.path}: ${current.message}`)
            .join(' · ')
            .slice(0, 1900);
          await conn.query(
            `INSERT INTO rejection_log
             (raw_event_id, source_id, reviewer_id, reason_codes, reviewer_note,
              event_title, event_snapshot, rejection_origin)
             VALUES (?,?,NULL,?,?,?,?, 'system')`,
            [
              eventId,
              source.id,
              JSON.stringify(['missing_fields']),
              `Required fields are missing. ${missingSummary}`,
              payload.title,
              JSON.stringify(boundedEventSnapshot({
                ...candidatePayloadSnapshot(payload),
                validation_errors: validationErrors,
              })),
            ],
          );
        }

        if (fixedFromId && fixEntry) {
          const [supersede] = await conn.query(
            `UPDATE raw_events
             SET status = 'superseded', superseded_by_id = ?
             WHERE id = ?
               AND (
                 status = 'pending_fix'
                 OR (status = 'rejected' AND sent_for_correction = 1)
               )`,
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
                fieldAuditValue(oldValue),
                fieldAuditValue(newValue),
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
              JSON.stringify(boundedEventSnapshot(originalEvent ?? {})),
            ],
          );
          await conn.query(
            'DELETE FROM needs_fix WHERE raw_event_id = ?',
            [fixedFromId],
          );
          if (fixEntry.sent_by_user_id) {
            const parts = [
              fixEntry.correction_notes ? `You asked: ${fixEntry.correction_notes}` : '',
              raw.fixSummary ? `Agent summary: ${cleanText(raw.fixSummary, 500)}` : '',
            ].filter(Boolean);
            await conn.query(
              `INSERT INTO notifications (user_id, type, title, message, raw_event_id)
               VALUES (?, 'event_fixed', ?, ?, ?)`,
              [
                fixEntry.sent_by_user_id,
                `Correction draft ready: ${payload.title}`,
                parts.join(' · ') || 'A contract-valid correction draft is ready for human review.',
                eventId,
              ],
            );
          }
        }

        await (conn as any).commit();
        comparisonEntry.event_id = eventId;
        if (rowStatus === 'duplicate') {
          skipped++;
          duplicates++;
          duplicatesPreserved++;
          comparisonEntry.outcome = crossSourceDuplicateOfId !== null
            ? 'duplicate_cross_source'
            : 'duplicate_communityhub';
          comparisonEntry.duplicate_of_event_id = crossSourceDuplicateOfId;
          continue;
        }
        if (rowStatus === 'rejected') {
          skipped++;
          autoRejected++;
          comparisonEntry.outcome = 'auto_rejected';
          errors.push({ index, title, inserted: true, issues: validationErrors });
          continue;
        }
        comparisonEntry.outcome = 'inserted';
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

  // Record the two-way comparison for human review (meeting item 1). This is
  // observability, never a reason to fail a run that already persisted work.
  if (!isCorrectionRun) {
    await persistRunComparison(runId, source, comparison, inventory, inventoryError);
  }

  return {
    inserted,
    skipped,
    duplicates,
    duplicates_preserved: duplicatesPreserved,
    auto_rejected: autoRejected,
    invalid,
    failed,
    errors,
    comparison,
  };
}
