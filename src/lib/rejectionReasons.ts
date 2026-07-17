export const REJECTION_REASONS = [
  { code: 'wrong_audience', label: 'Wrong audience (staff or students only)' },
  { code: 'bad_date_parse', label: 'Date or time extracted incorrectly' },
  { code: 'duplicate_missed', label: 'Duplicate already in CommunityHub' },
  { code: 'description_hallucinated', label: 'Description contains invented details' },
  { code: 'missing_fields', label: 'Required fields are missing' },
  { code: 'wrong_geo_scope', label: 'Geographic scope is wrong' },
  { code: 'not_public_event', label: 'Private or invitation-only' },
  { code: 'wrong_post_type', label: 'Post kind or category is wrong' },
  { code: 'bad_location', label: 'Location is missing or wrong' },
  { code: 'communityhub_rejected', label: 'Rejected by CommunityHub moderation' },
  { code: 'other', label: 'Other' },
] as const;

export type RejectionReasonCode = (typeof REJECTION_REASONS)[number]['code'];

const REJECTION_REASON_CODE_SET = new Set<string>(
  REJECTION_REASONS.map(reason => reason.code),
);

export function isRejectionReasonCode(value: unknown): value is RejectionReasonCode {
  return typeof value === 'string' && REJECTION_REASON_CODE_SET.has(value);
}

/** Read stored JSON/arrays without carrying arbitrary strings into prompts. */
export function normalizeRejectionReasonCodes(value: unknown): RejectionReasonCode[] {
  let candidate = value;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(candidate)) return [];
  return [...new Set(candidate.filter(isRejectionReasonCode))];
}
