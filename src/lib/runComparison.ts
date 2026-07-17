import pool from './db';
import {
  compareEventContent,
  normalizeComparableText,
  normalizeContentSessions,
  type CommunityHubInventory,
  type CommunityHubInventoryPost,
  type ContentMatch,
} from './communityHubInventory';

/**
 * Two-way, per-run comparison between what an integration extracted and what
 * the CommunityHub calendar actually shows (2026-07-16 meeting, item 1).
 *
 * Direction 1 — integration → calendar: every extracted candidate is matched
 * against the complete approved-and-pending CommunityHub inventory. Matches
 * are recorded with field-level differences; candidates rejected as
 * duplicates are preserved so their quality can be evaluated against the
 * directly posted version (the Library and Heritage workflows).
 *
 * Direction 2 — calendar → integration: CommunityHub posts attributed to the
 * organization (by calendar source name, sponsor, or organization) that match
 * neither this run's candidates nor any retained local event are reported as
 * events the integration missed.
 */

export type CandidateOutcome =
  | 'inserted'
  | 'duplicate_local'
  | 'duplicate_cross_source'
  | 'duplicate_communityhub'
  | 'auto_rejected'
  | 'invalid';

export type ComparisonFieldDiff = {
  field: string;
  local: string;
  remote: string;
  equal: boolean;
};

export type RemotePostSnapshot = {
  name: string;
  description: string;
  extended_description: string;
  calendar_source_name: string;
  calendar_source_url: string;
  location: string;
  sponsors: string[];
  organizations: string[];
  sessions: Array<{ start: number; end: number }>;
  moderation: string;
  has_image: boolean;
  /** Empty for direct human submissions; set when this application created the post. */
  ingested_post_url: string;
  submission_origin: 'direct_submission' | 'this_application';
};

export type CandidatePayloadSnapshot = {
  event_type: string;
  title: string;
  description: string;
  extended_description: string | null;
  sessions: unknown;
  sponsors: unknown;
  post_type_ids: unknown;
  location: string | null;
  calendar_source_url: string | null;
  buttons: unknown;
};

export type ComparisonCandidate = {
  index: number;
  title: string;
  outcome: CandidateOutcome;
  event_id: number | null;
  duplicate_of_event_id: number | null;
  payload: CandidatePayloadSnapshot;
  communityhub_match: null | {
    kind: ContentMatch['kind'];
    reasons: string[];
    field_diffs: ComparisonFieldDiff[];
    remote: RemotePostSnapshot;
  };
  issues: Array<{ path: string; code: string; message: string }>;
  adjustments: string[];
};

export type RunComparisonReport = {
  source_names_used: string[];
  candidates: ComparisonCandidate[];
  calendar_only: RemotePostSnapshot[];
  counts: {
    candidates: number;
    matched_both: number;
    integration_only: number;
    calendar_only: number;
    duplicates_preserved: number;
  };
  inventory_error: string | null;
};

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function remotePostSnapshot(post: CommunityHubInventoryPost): RemotePostSnapshot {
  const raw = post.raw;
  const ingestedPostUrl = raw?.ingestedPostUrl ?? '';
  return {
    name: raw?.name || post.title,
    description: raw?.description ?? post.description,
    extended_description: raw?.extendedDescription ?? post.extendedDescription,
    calendar_source_name: raw?.calendarSourceName ?? '',
    calendar_source_url: raw?.calendarSourceUrl ?? post.calendarSourceUrl,
    location: raw?.location ?? '',
    sponsors: raw?.sponsors ?? [],
    organizations: raw?.organizations ?? [],
    sessions: post.sessions,
    moderation: post.moderation,
    has_image: raw?.hasImage ?? false,
    ingested_post_url: ingestedPostUrl,
    submission_origin: ingestedPostUrl ? 'this_application' : 'direct_submission',
  };
}

function sessionsKey(value: unknown): string {
  return normalizeContentSessions(value)
    .map(session => `${session.start}-${session.end}`)
    .join(',');
}

/** Field-level differences between an imported candidate and the calendar post. */
export function diffCandidateAgainstRemote(
  candidate: CandidatePayloadSnapshot,
  remote: CommunityHubInventoryPost,
): ComparisonFieldDiff[] {
  const snapshot = remotePostSnapshot(remote);
  const pairs: Array<[string, string, string]> = [
    ['title', candidate.title, snapshot.name],
    ['description', candidate.description, snapshot.description],
    ['extended_description', candidate.extended_description ?? '', snapshot.extended_description],
    ['sessions', sessionsKey(candidate.sessions), sessionsKey(remote.sessions)],
    ['location', candidate.location ?? '', snapshot.location],
    ['calendar_source_url', candidate.calendar_source_url ?? '', snapshot.calendar_source_url],
  ];
  return pairs.map(([field, local, remoteValue]) => ({
    field,
    local,
    remote: remoteValue,
    equal: field === 'sessions'
      ? local === remoteValue
      : normalizeComparableText(local) === normalizeComparableText(remoteValue),
  }));
}

/** CommunityHub posts attributable to the organization behind a source. */
export function attributeRemotePosts(
  posts: CommunityHubInventoryPost[],
  organizationNames: string[],
): CommunityHubInventoryPost[] {
  const normalized = organizationNames
    .map(normalizeComparableText)
    .filter(name => name.length > 2);
  if (normalized.length === 0) return [];
  return posts.filter(post => {
    const raw = post.raw;
    const labels = [
      raw?.calendarSourceName ?? '',
      ...(raw?.sponsors ?? []),
      ...(raw?.organizations ?? []),
    ];
    return labels.some(label => {
      const candidate = normalizeComparableText(label);
      return candidate.length > 2 && normalized.includes(candidate);
    });
  });
}

type LocalComparableRow = {
  title: unknown;
  event_type: unknown;
  description: unknown;
  extended_description: unknown;
  calendar_source_url: unknown;
  sessions: unknown;
};

function matchesAnyLocal(
  post: CommunityHubInventoryPost,
  locals: LocalComparableRow[],
): boolean {
  return locals.some(local => compareEventContent(local, post).kind !== 'none');
}

/**
 * Compute the calendar → integration direction: attributed CommunityHub posts
 * that neither this run's candidates nor any retained local event match.
 */
export function findCalendarOnlyPosts(
  inventory: CommunityHubInventory,
  organizationNames: string[],
  candidates: ComparisonCandidate[],
  retainedLocalRows: LocalComparableRow[],
): CommunityHubInventoryPost[] {
  const attributed = attributeRemotePosts(inventory.posts, organizationNames);
  const candidateRows: LocalComparableRow[] = candidates.map(candidate => ({
    title: candidate.payload.title,
    event_type: candidate.payload.event_type,
    description: candidate.payload.description,
    extended_description: candidate.payload.extended_description,
    calendar_source_url: candidate.payload.calendar_source_url,
    sessions: candidate.payload.sessions,
  }));
  return attributed.filter(post => (
    !matchesAnyLocal(post, candidateRows) && !matchesAnyLocal(post, retainedLocalRows)
  ));
}

export async function loadRetainedLocalRows(sourceId: number): Promise<LocalComparableRow[]> {
  const [rows] = await pool.query(
    `SELECT title, event_type, description, extended_description,
            calendar_source_url, sessions
     FROM raw_events
     WHERE source_id=?
       AND status IN ('pending','submitted','approved','publishing',
                      'resubmitted','pending_fix','duplicate')`,
    [sourceId],
  ) as any;
  return Array.isArray(rows) ? rows as LocalComparableRow[] : [];
}

export function buildRunComparisonReport(options: {
  organizationNames: string[];
  candidates: ComparisonCandidate[];
  inventory: CommunityHubInventory | null;
  inventoryError: string | null;
  retainedLocalRows: LocalComparableRow[];
}): RunComparisonReport {
  const { organizationNames, candidates, inventory, inventoryError, retainedLocalRows } = options;
  const calendarOnly = inventory
    ? findCalendarOnlyPosts(inventory, organizationNames, candidates, retainedLocalRows)
    : [];
  const matchedBoth = candidates.filter(candidate => candidate.communityhub_match !== null).length;
  return {
    source_names_used: organizationNames.filter(Boolean),
    candidates,
    calendar_only: calendarOnly.map(remotePostSnapshot),
    counts: {
      candidates: candidates.length,
      matched_both: matchedBoth,
      integration_only: candidates.length - matchedBoth,
      calendar_only: calendarOnly.length,
      duplicates_preserved: candidates.filter(candidate => (
        candidate.outcome === 'duplicate_communityhub'
        || candidate.outcome === 'duplicate_cross_source'
      )).length,
    },
    inventory_error: inventoryError,
  };
}

/** Persist one run's comparison; reruns for the same run id replace the report. */
export async function recordRunComparison(options: {
  runId: number;
  sourceId: number;
  report: RunComparisonReport;
  inventory: CommunityHubInventory | null;
  inventorySha256: string | null;
}): Promise<void> {
  const { runId, sourceId, report, inventory, inventorySha256 } = options;
  await pool.query(
    `INSERT INTO integration_run_comparisons
     (agent_run_id, source_id, status, inventory_sha256, remote_approved,
      remote_pending, matched_both, integration_only, calendar_only,
      duplicates_preserved, report)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       status=VALUES(status), inventory_sha256=VALUES(inventory_sha256),
       remote_approved=VALUES(remote_approved), remote_pending=VALUES(remote_pending),
       matched_both=VALUES(matched_both), integration_only=VALUES(integration_only),
       calendar_only=VALUES(calendar_only),
       duplicates_preserved=VALUES(duplicates_preserved), report=VALUES(report)`,
    [
      runId,
      sourceId,
      inventory ? 'complete' : 'inventory_unavailable',
      inventorySha256,
      inventory?.approved ?? 0,
      inventory?.pending ?? 0,
      report.counts.matched_both,
      report.counts.integration_only,
      report.counts.calendar_only,
      report.counts.duplicates_preserved,
      JSON.stringify(report),
    ],
  );
}

/** Names that identify the organization behind a source on the calendar. */
export function organizationNamesForSource(source: {
  name?: unknown;
  calendar_source_name?: unknown;
  org_sponsor_name?: unknown;
}): string[] {
  return [...new Set([
    text(source.org_sponsor_name).trim(),
    text(source.calendar_source_name).trim(),
    text(source.name).trim(),
  ].filter(Boolean))];
}
