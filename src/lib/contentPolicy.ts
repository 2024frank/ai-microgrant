import type { CommunityHubPayloadIssue } from './communityHubPayload';
import { normalizeComparableText } from './communityHubInventory';

/**
 * Deterministic description/content policy agreed in the 2026-07-16 meeting.
 * Applied to every extracted candidate at the ingestion write boundary so the
 * outcome does not depend on any one agent prompt:
 *
 *  - A valid registration URL belongs in the registration button, never inside
 *    a description. When registration is required, the short description ends
 *    with "Registration required."
 *  - When the event costs money, the short description includes "Paid event."
 *  - Long descriptions may not contain URLs or repeat the event address.
 *  - When the entire source description fits in the short-description limit,
 *    the long description is dropped instead of duplicating it.
 *  - Ambiguous location wording ("held here", "takes place there") is flagged
 *    for the reviewer; prose is never rewritten beyond safe removals.
 *
 * Adjustments are silent, deterministic transformations recorded for the run
 * report. Issues are blocking problems that need agent or reviewer action.
 */

export const REGISTRATION_SENTENCE = 'Registration required.';
export const PAID_SENTENCE = 'Paid event.';

export const SHORT_DESCRIPTION_MAX = 200;

export interface ContentPolicyResult {
  record: Record<string, unknown>;
  issues: CommunityHubPayloadIssue[];
  adjustments: string[];
}

type ButtonDraft = { title: string; link: string };

const REGISTRATION_BUTTON_PATTERN = /\b(register|registration|sign[\s-]?up|rsvp|apply|enroll)\b/i;
const REGISTRATION_TEXT_PATTERN =
  /\b(registration\s+(?:is\s+)?required|register\s+(?:now|today|online|here|at|by|in\s+advance)|must\s+register|sign[\s-]?up\s+(?:is\s+)?required|pre-?registration)\b/i;
// "No registration required" and friends are the OPPOSITE evidence.
const NEGATED_REGISTRATION_PATTERN =
  /\b(?:no|not|without|isn'?t|is\s+not)\s+(?:any\s+)?(?:pre-?)?(?:registration|sign[\s-]?up)\b|\bregistration\s+(?:is\s+)?(?:not\s+required|unnecessary|optional)\b/i;
const PAID_BUTTON_PATTERN = /\b(buy|purchase|get)\b.*\btickets?\b|\btickets?\b.*\b(buy|purchase|sale)\b/i;
const PAID_TEXT_PATTERN =
  /\$\s?\d|\b(admission|cover\s+charge|ticket(?:s)?\s+(?:cost|price|prices|required|on\s+sale|available\s+for\s+purchase))\b|\bpaid\s+event\b/i;
const FREE_TEXT_PATTERN =
  /\b(free\s+(?:admission|event|of\s+charge|and\s+open\s+to)|admission\s+is\s+free|no\s+(?:charge|cost|fee)|free\s+to\s+(?:attend|the\s+public))\b/i;
const AMBIGUOUS_LOCATION_PATTERN =
  /\b(?:held|happening|hosted|located|takes?\s+place|taking\s+place|join\s+us|meet\s+us|see\s+you)\s+(?:right\s+)?(?:out\s+)?\b(here|there)\b/i;
const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>()"']+/gi;

// Schedule restatements in the LONG description duplicate the dedicated
// sessions field. Only sentences that are clearly about the event's own
// schedule are removed: they lead with a schedule verb or label, or consist
// of nothing but date/time material. "Deadline to register is August 1"
// stays; "Meets August 19, 2026, from 5:30 to 7:30pm." goes.
const MONTH_OR_DAY =
  '(?:january|february|march|april|may|june|july|august|september|october|november|december|'
  + 'jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec|'
  + 'monday|tuesday|wednesday|thursday|friday|saturday|sunday)';
const TIME_TOKEN = String.raw`(?:\d{1,2}(?::\d{2})?\s*(?:a|p)\.?m\.?|\d{1,2}:\d{2}|\d{4})`;
const SCHEDULE_LEAD_PATTERN = new RegExp(
  String.raw`^(?:meets?|held|happening|takes?\s+place|taking\s+place|runs?|occurs?|scheduled|open(?:s)?|begins?|starts?)\b`
  + String.raw`(?=[^.!?]*\b${MONTH_OR_DAY}\b)(?=[^.!?]*${TIME_TOKEN})`,
  'i',
);
const SCHEDULE_LABEL_PATTERN = /^(?:when|date|dates|time|times|schedule)\s*:/i;
const SCHEDULE_ONLY_PATTERN = new RegExp(
  String.raw`^(?:\b${MONTH_OR_DAY}\b|${TIME_TOKEN}|\d{1,2}(?:st|nd|rd|th)?|from|to|until|through|at|and|on|noon|midnight|[\s,;:.&-]|(?:a|p)\.?m\.?)+$`,
  'i',
);

function isScheduleRestatement(sentence: string): boolean {
  const trimmed = sentence.trim();
  if (!trimmed) return false;
  return SCHEDULE_LEAD_PATTERN.test(trimmed)
    || SCHEDULE_LABEL_PATTERN.test(trimmed)
    || SCHEDULE_ONLY_PATTERN.test(trimmed);
}

function stripScheduleRestatements(value: string): { value: string; removed: number } {
  const sentences = value.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter(sentence => !isScheduleRestatement(sentence));
  if (kept.length === sentences.length) return { value, removed: 0 };
  return {
    value: collapseWhitespace(kept.join(' ')),
    removed: sentences.length - kept.length,
  };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function collapseWhitespace(value: string): string {
  return value.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

function parseButtons(value: unknown): ButtonDraft[] {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap(item => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return [];
    const button = item as Record<string, unknown>;
    const title = text(button.title).trim();
    const link = text(button.link).trim();
    return title || link ? [{ title, link }] : [];
  });
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function issue(path: string, code: string, message: string): CommunityHubPayloadIssue {
  return { path, code, message };
}

/** Trim on a word boundary so an appended policy sentence never overflows. */
function fitWithSuffix(base: string, suffix: string, maxLength: number): string {
  // Reserve room for the separating space and a possible closing period.
  const budget = maxLength - suffix.length - (base ? 2 : 0);
  if (budget <= 0) return suffix.slice(0, maxLength);
  let trimmed = base;
  if (trimmed.length > budget) {
    const cut = trimmed.slice(0, budget);
    const sentenceEnds = [...cut.matchAll(/[.!?](?=\s|$)/g)];
    const lastSentenceEnd = sentenceEnds.at(-1)?.index;
    if (lastSentenceEnd !== undefined && lastSentenceEnd >= 20) {
      trimmed = cut.slice(0, lastSentenceEnd + 1);
    } else {
      const lastSpace = cut.lastIndexOf(' ');
      trimmed = lastSpace >= Math.floor(budget * 0.6) ? cut.slice(0, lastSpace) : cut;
    }
    trimmed = trimmed.trim();
  }
  // The marker is its own sentence; close the preceding one when needed.
  if (trimmed && !/[.!?]$/.test(trimmed)) trimmed += '.';
  return trimmed ? `${trimmed} ${suffix}` : suffix;
}

export function findRegistrationUrl(record: Record<string, unknown>): string {
  const explicit = text(record.registrationUrl ?? record.registration_url).trim();
  if (explicit && isHttpUrl(explicit)) return explicit;
  const buttons = parseButtons(record.buttons);
  const registrationButton = buttons.find(
    button => REGISTRATION_BUTTON_PATTERN.test(button.title) && isHttpUrl(button.link),
  );
  return registrationButton?.link ?? '';
}

export function hasRegistrationEvidence(record: Record<string, unknown>): boolean {
  if (record.registrationRequired === true || record.registration_required === true) return true;
  if (text(record.registrationUrl ?? record.registration_url).trim()) return true;
  const buttons = parseButtons(record.buttons);
  if (buttons.some(button => REGISTRATION_BUTTON_PATTERN.test(button.title) && isHttpUrl(button.link))) {
    return true;
  }
  const copy = `${text(record.description)} ${text(record.extendedDescription ?? record.extended_description)}`;
  if (NEGATED_REGISTRATION_PATTERN.test(copy)) return false;
  return REGISTRATION_TEXT_PATTERN.test(copy);
}

export function hasPaidEvidence(record: Record<string, unknown>): boolean {
  if (record.isPaid === true || record.is_paid === true || record.paid === true) return true;
  const cost = record.cost ?? record.price;
  if (typeof cost === 'number' && cost > 0) return true;
  if (typeof cost === 'string' && /\d/.test(cost) && !/^\s*(0+(\.0+)?|free)\s*$/i.test(cost)) return true;
  const copy = `${text(record.description)} ${text(record.extendedDescription ?? record.extended_description)}`;
  if (FREE_TEXT_PATTERN.test(copy)) return false;
  if (PAID_TEXT_PATTERN.test(copy)) return true;
  const buttons = parseButtons(record.buttons);
  return buttons.some(button => PAID_BUTTON_PATTERN.test(button.title) && isHttpUrl(button.link));
}

function stripUrls(value: string): { value: string; removed: string[] } {
  const removed = [...value.matchAll(URL_PATTERN)].map(match => match[0]);
  if (removed.length === 0) return { value, removed };
  const stripped = value
    .replace(URL_PATTERN, '')
    // Labels that only existed to introduce a link ("Get tickets:", "More
    // info:") carry no information once the URL is gone.
    .replace(/^[^\S\n]*[\w '&/-]{0,40}:[^\S\n]*$/gm, '')
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]{2,}/g, ' ');
  return { value: collapseWhitespace(stripped), removed };
}

function stripAddress(value: string, address: string): { value: string; removed: boolean } {
  const trimmedAddress = address.trim();
  if (!trimmedAddress || trimmedAddress.length < 8) return { value, removed: false };
  const escaped = trimmedAddress
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // Tolerate whitespace and separator differences between the stored
    // address and how the description spells it.
    .replace(/(?:\\?[\s,·–-])+/g, '[\\s,·–-]+');
  const pattern = new RegExp(escaped, 'gi');
  if (!pattern.test(value)) return { value, removed: false };
  return {
    value: collapseWhitespace(value.replace(pattern, '').replace(/^[ \t]*(?:at|in)?[ \t]*[,·-]+[ \t]*/gim, '')),
    removed: true,
  };
}

/**
 * Apply the meeting's description policy to one extracted candidate. The
 * input record is not mutated; callers persist the returned record. Issues
 * use the CommunityHub payload issue shape so they merge into
 * raw_events.validation_errors like every other contract problem.
 */
export function applyContentPolicy(input: Record<string, unknown>): ContentPolicyResult {
  const record: Record<string, unknown> = { ...input };
  const issues: CommunityHubPayloadIssue[] = [];
  const adjustments: string[] = [];

  let description = collapseWhitespace(text(record.description));
  let extended = collapseWhitespace(text(record.extendedDescription ?? record.extended_description));
  const address = text(record.location);
  let buttons = parseButtons(record.buttons);

  // 1. Registration URL placement: the button field is the home for the
  //    registration link; descriptions must not carry URLs.
  const explicitRegistrationUrl = text(record.registrationUrl ?? record.registration_url).trim();
  if (explicitRegistrationUrl && !isHttpUrl(explicitRegistrationUrl)) {
    issues.push(issue('registrationUrl', 'invalid_url', 'must be an absolute HTTP or HTTPS URL'));
  }
  const registrationEvidence = hasRegistrationEvidence(record);
  let registrationUrl = findRegistrationUrl(record);
  if (registrationEvidence && !registrationUrl) {
    // Legacy prompts placed the registration link in `website`; adopt it only
    // when the source text itself says registration applies.
    const website = text(record.website).trim();
    const textEvidence = REGISTRATION_TEXT_PATTERN.test(`${description} ${extended}`);
    if (website && isHttpUrl(website) && textEvidence) {
      registrationUrl = website;
      adjustments.push('registration URL adopted from website field');
    } else if (textEvidence) {
      // The link is sometimes only in the prose ("Register now at https://...").
      const proseUrl = (`${description} ${extended}`.match(URL_PATTERN) ?? [])
        .map(candidate => candidate.replace(/[.,;:)\]]+$/, ''))
        .map(candidate => (candidate.toLowerCase().startsWith('www.') ? `https://${candidate}` : candidate))
        .find(isHttpUrl);
      if (proseUrl) {
        registrationUrl = proseUrl;
        adjustments.push('registration URL adopted from the description text');
        const strippedDescription = stripUrls(description);
        if (strippedDescription.removed.length > 0) {
          description = strippedDescription.value;
          adjustments.push('removed the registration URL from the short description');
        }
      }
    }
  }
  if (registrationUrl && !buttons.some(button => button.link === registrationUrl
    && REGISTRATION_BUTTON_PATTERN.test(button.title))) {
    buttons = [{ title: 'Register', link: registrationUrl }, ...buttons];
    adjustments.push('registration button added from registration URL');
  }
  if (registrationEvidence && !registrationUrl) {
    issues.push(issue(
      'registrationUrl',
      'required',
      'registration is required but no valid registration URL was provided',
    ));
  }

  // 2. Long descriptions never contain URLs or the event address, and never
  //    exist only to repeat the short description.
  if (extended) {
    const withoutUrls = stripUrls(extended);
    if (withoutUrls.removed.length > 0) {
      extended = withoutUrls.value;
      adjustments.push(`removed ${withoutUrls.removed.length} URL${withoutUrls.removed.length === 1 ? '' : 's'} from the long description`);
    }
    const withoutAddress = stripAddress(extended, address);
    if (withoutAddress.removed) {
      extended = withoutAddress.value;
      adjustments.push('removed the event address from the long description');
    }
    const withoutSchedule = stripScheduleRestatements(extended);
    if (withoutSchedule.removed > 0) {
      extended = withoutSchedule.value;
      adjustments.push(`removed ${withoutSchedule.removed} schedule restatement${withoutSchedule.removed === 1 ? '' : 's'} from the long description`);
    }
  }

  // 3. Ambiguous location wording is a human judgment call; flag, never edit.
  const ambiguous = `${description} ${extended}`.match(AMBIGUOUS_LOCATION_PATTERN);
  if (ambiguous) {
    issues.push(issue(
      'description',
      'ambiguous_location_wording',
      `refers to the location as "${ambiguous[1]}"; use the actual venue name or omit the sentence`,
    ));
  }

  // 4. If the whole source description fits in the short field, use it there
  //    and drop the long description instead of padding two fields.
  if (extended) {
    const normalizedExtended = normalizeComparableText(extended);
    const normalizedDescription = normalizeComparableText(description);
    if (normalizedExtended === normalizedDescription) {
      // Identical text that FITS the short field is duplication; identical
      // text that overflows preserves the tail the 200-character trim will
      // cut from the short description, so it stays.
      if (extended.length <= SHORT_DESCRIPTION_MAX) {
        extended = '';
        adjustments.push('dropped the long description because it duplicated the short description');
      }
    } else if (
      extended.length <= SHORT_DESCRIPTION_MAX
      && normalizedDescription
      && (normalizedExtended.startsWith(normalizedDescription)
        || normalizedDescription.startsWith(normalizedExtended))
    ) {
      description = extended;
      extended = '';
      adjustments.push('used the full source description as the short description and dropped the long description');
    }
  }

  // 5. Meeting-agreed marker sentences on the short description.
  const paidEvidence = hasPaidEvidence(record);
  if (paidEvidence && !description.includes(PAID_SENTENCE)) {
    description = fitWithSuffix(description, PAID_SENTENCE, SHORT_DESCRIPTION_MAX);
    adjustments.push('marked the short description as a paid event');
  }
  if (registrationUrl && registrationEvidence) {
    if (!description.endsWith(REGISTRATION_SENTENCE)) {
      const withoutInlineMarker = description.replace(
        new RegExp(`\\s*${REGISTRATION_SENTENCE.replace('.', '\\.')}`, 'g'),
        '',
      ).trim();
      description = fitWithSuffix(withoutInlineMarker, REGISTRATION_SENTENCE, SHORT_DESCRIPTION_MAX);
      adjustments.push('marked the short description as registration required');
    }
  }

  record.description = description;
  if (extended) {
    record.extendedDescription = extended;
  } else {
    delete record.extendedDescription;
  }
  delete record.extended_description;
  record.buttons = buttons;
  delete record.registrationUrl;
  delete record.registration_url;
  delete record.registrationRequired;
  delete record.registration_required;

  return { record, issues, adjustments };
}
