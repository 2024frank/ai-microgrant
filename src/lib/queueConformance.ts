import {
  validateCommunityHubPayload,
  type CommunityHubPayloadIssue,
} from './communityHubPayload';
import { applyContentPolicy, hasRegistrationEvidence } from './contentPolicy';
import { computeDedupKey } from './eventDedup';

/**
 * Queue conformance (follow-up to the 2026-07-16 implementation): events that
 * were ingested BEFORE the new content policy shipped are still sitting in
 * the review queue in the old shape. This module decides, for one pending
 * event, how to bring it up to the agreed format:
 *
 *  - apply the deterministic corrections the policy would have applied at
 *    ingestion (markers, URL/address stripping, registration button, exact
 *    Apollo titles) and leave the event for human approval;
 *  - reject it as "Required fields are missing" when the documented contract
 *    still cannot be satisfied (the system-corrections dispatcher then routes
 *    it through the AI correction agent once);
 *  - reject it as format-nonconforming when an announcement advertises an
 *    actionable opportunity but its title states no action (the correction
 *    agent rewrites the title from the source; the corrected draft returns to
 *    the queue for human approval).
 *
 * All logic is pure; the route applies the returned plan.
 */

export const APOLLO_TITLE_CORRECTIONS: Record<string, string> = {
  'Apollo - Showing Now': 'Now Playing at the Apollo',
  'Apollo - Now Playing': 'Now Playing at the Apollo',
  'Apollo Now Playing': 'Now Playing at the Apollo',
  'Now Showing at the Apollo': 'Now Playing at the Apollo',
  'Apollo - Coming Soon': 'Coming Soon to the Apollo',
  'Apollo Coming Soon': 'Coming Soon to the Apollo',
};

// Titles that already lead with the action the reader can take. Kept
// deliberately broad so only clearly noun-only opportunity titles are flagged.
const ACTION_TITLE_PATTERN = new RegExp(
  '^(register|sign[ -]?up|apply|participate|join|attend|recycle|volunteer|'
  + 'donate|enroll|rsvp|support|celebrate|come|visit|explore|learn|watch|'
  + 'shop|order|reserve|book|submit|enter|audition|vote|adopt|foster|'
  + 'now playing|coming soon|camp:|class:|workshop:|drop-in:)',
  'i',
);

export type PendingEventRow = Record<string, unknown> & {
  id: number;
  source_id: number;
  event_type: string;
  title: string;
  description: string;
  extended_description: string | null;
  buttons: unknown;
  website: string | null;
  location: string | null;
  image_cdn_url: string | null;
};

export type ConformancePlan = {
  event_id: number;
  decision: 'leave' | 'correct' | 'reject_missing_required' | 'reject_format';
  /** Column updates to apply (already normalized payload values). */
  updates: Record<string, unknown>;
  /** Full re-derived validation issues to store on the row. */
  validation_errors: CommunityHubPayloadIssue[];
  /** Human-readable notes for the rejection or the audit trail. */
  notes: string[];
  adjustments: string[];
};

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Deterministic JSON with sorted object keys at every depth. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

// MySQL JSON columns store object keys sorted, while the policy emits
// {title, link} order; comparisons must ignore key order or every sweep
// rewrites identical content forever.
function canonical(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return stableJson(value);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed !== null && typeof parsed === 'object') return stableJson(parsed);
    } catch {
      // Plain string.
    }
  }
  return String(value);
}

/** True when an announcement advertises something to do but names no action. */
export function announcementTitleNeedsAction(row: PendingEventRow): boolean {
  if (row.event_type !== 'an') return false;
  const title = text(row.title).trim();
  if (!title || ACTION_TITLE_PATTERN.test(title)) return false;
  // Only flag when the copy itself proves there is an action to take;
  // a plain informational announcement keeps its title.
  return hasRegistrationEvidence({
    description: row.description,
    extended_description: row.extended_description,
    buttons: row.buttons,
    website: row.website,
  });
}

/**
 * Build the conformance plan for one pending row. Deterministic corrections
 * are computed exactly like ingestion would have: content policy first, then
 * contract validation on the corrected fields. The publishing email is
 * supplied by the server at approval time, so revalidation injects it the
 * same way the approve and edit routes do.
 */
export function planQueueConformance(
  row: PendingEventRow,
  options: { submitterEmail?: string } = {},
): ConformancePlan {
  const notes: string[] = [];
  const correctedTitle = APOLLO_TITLE_CORRECTIONS[text(row.title).trim()] ?? row.title;
  if (correctedTitle !== row.title) {
    notes.push(`title corrected to the agreed wording "${correctedTitle}"`);
  }

  const policy = applyContentPolicy({
    title: correctedTitle,
    description: row.description,
    extended_description: row.extended_description ?? undefined,
    buttons: row.buttons,
    website: row.website ?? undefined,
    location: row.location ?? undefined,
  });

  const merged: Record<string, unknown> = {
    ...row,
    email: options.submitterEmail || row.email || '',
    title: correctedTitle,
    description: policy.record.description,
    extended_description: (policy.record.extendedDescription as string | undefined) ?? null,
    buttons: policy.record.buttons,
  };
  const validation = validateCommunityHubPayload(merged);
  const payload = validation.success ? validation.data : validation.normalized;
  const issues = validation.success
    ? [...policy.issues]
    : [...policy.issues, ...validation.errors];

  const updates: Record<string, unknown> = {};
  const fieldPairs: Array<[string, unknown]> = [
    ['title', payload.title],
    ['description', payload.description],
    ['extended_description', payload.extendedDescription ?? null],
    ['buttons', payload.buttons],
  ];
  for (const [field, nextValue] of fieldPairs) {
    if (canonical(row[field]) !== canonical(nextValue)) updates[field] = nextValue;
  }
  if (Object.keys(updates).length > 0) {
    // Keep the re-scrape signature aligned with the corrected content so the
    // next agent run dedups against this row instead of re-inserting it.
    updates.dedup_key = computeDedupKey(
      payload.title,
      payload.sessions,
      payload.eventType,
      payload.description,
      payload.extendedDescription,
    );
  }

  const missingRequired = issues.filter(issue => (
    issue.code === 'required' || issue.code === 'too_short'
  ));
  if (missingRequired.length > 0) {
    return {
      event_id: row.id,
      decision: 'reject_missing_required',
      updates,
      validation_errors: issues,
      notes: [
        'Required fields are missing.',
        ...missingRequired.map(issue => `${issue.path}: ${issue.message}`),
        ...notes,
      ],
      adjustments: policy.adjustments,
    };
  }

  if (announcementTitleNeedsAction({ ...row, title: payload.title } as PendingEventRow)) {
    return {
      event_id: row.id,
      decision: 'reject_format',
      updates,
      validation_errors: issues,
      notes: [
        `The announcement title "${payload.title}" does not state the action the reader can take.`,
        'Rewrite the title to lead with the action supported by the source, for example "Register for ..." or "Participate in ...". Never invent an action the source does not support.',
        ...notes,
      ],
      adjustments: policy.adjustments,
    };
  }

  return {
    event_id: row.id,
    decision: Object.keys(updates).length > 0 ? 'correct' : 'leave',
    updates,
    validation_errors: issues,
    notes,
    adjustments: policy.adjustments,
  };
}

/** SafeImageError codes that can never succeed on retry. */
export function isPermanentImageFailure(code: string): boolean {
  return ['INVALID_URL', 'NON_PUBLIC_ADDRESS', 'UNSUPPORTED_TYPE', 'INVALID_IMAGE', 'TOO_LARGE']
    .includes(code);
}
