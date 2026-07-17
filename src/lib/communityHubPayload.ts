import {
  isRecognizedEventType,
  normalizeEventType,
  type EventType,
} from './eventTypes';
import { validatePublicHttpUrl } from './publicHttpUrl';

export const COMMUNITY_HUB_LOCATION_TYPES = ['ph2', 'on', 'bo', 'ne'] as const;
export const COMMUNITY_HUB_DISPLAY_TYPES = ['all', 'ps', 'sps', 'ss'] as const;
export const OBERLIN_POST_TYPE_IDS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 59, 89,
] as const;

export type CommunityHubLocationType = (typeof COMMUNITY_HUB_LOCATION_TYPES)[number];
export type CommunityHubDisplayType = (typeof COMMUNITY_HUB_DISPLAY_TYPES)[number];
export type OberlinPostTypeId = (typeof OBERLIN_POST_TYPE_IDS)[number];

export const OBERLIN_POST_TYPE_LABELS = {
  1: 'Volunteer Opportunity',
  2: 'Exhibit',
  3: 'Fair, Festival, or Public Celebration',
  4: 'Tour, Walking Tours or Open House',
  5: 'Film',
  6: 'Presentation or Lecture',
  7: 'Workshop or Class',
  8: 'Music Performance',
  9: 'Theatre or Dance',
  10: 'City Government',
  11: 'Spectator Sport',
  12: 'Participatory Sport or Game',
  13: 'Networking Event',
  59: 'Ecolympics or Environmental',
  89: 'Other',
} as const satisfies Record<OberlinPostTypeId, string>;

export interface CommunityHubSession {
  startTime: number;
  endTime: number;
}

export interface CommunityHubButton {
  title: string;
  link: string;
}

/** Exact outbound shape accepted by the Oberlin legacy calendar API. */
export interface CommunityHubPayload {
  eventType: EventType;
  email: string;
  subscribe: boolean;
  title: string;
  description: string;
  sponsors: string[];
  postTypeId: OberlinPostTypeId[];
  sessions: CommunityHubSession[];
  locationType: CommunityHubLocationType;
  display: CommunityHubDisplayType;
  screensIds: number[];
  phone: string;
  website: string;
  urlLink: string;
  placeId: string;
  buttons: CommunityHubButton[];
  public: '0' | '1';
  contactEmail?: string;
  extendedDescription?: string;
  location?: string;
  placeName?: string;
  roomNum?: string;
  image_cdn_url?: string;
  calendarSourceName?: string;
  calendarSourceUrl?: string;
  ingestedPostUrl?: string;
}

export interface CommunityHubPayloadIssue {
  path: string;
  code: string;
  message: string;
}

/** Publishing policy: at least one session must still be ongoing or upcoming. */
export function getCommunityHubExpirationIssue(
  sessions: CommunityHubSession[],
  nowSeconds = Math.floor(Date.now() / 1000),
): CommunityHubPayloadIssue | null {
  if (
    sessions.length === 0
    || sessions.some(session => Number(session.endTime) >= nowSeconds)
  ) {
    return null;
  }
  return {
    path: 'sessions',
    code: 'expired',
    message: 'must include at least one ongoing or future session',
  };
}

export interface CommunityHubPayloadNormalization {
  payload: CommunityHubPayload;
  issues: CommunityHubPayloadIssue[];
}

export type CommunityHubPayloadValidation =
  | { success: true; data: CommunityHubPayload; errors: [] }
  | {
      success: false;
      data: null;
      normalized: CommunityHubPayload;
      errors: CommunityHubPayloadIssue[];
    };

export class CommunityHubPayloadValidationError extends Error {
  readonly issues: CommunityHubPayloadIssue[];

  constructor(issues: CommunityHubPayloadIssue[]) {
    const summary = issues.slice(0, 3).map(issue => `${issue.path}: ${issue.message}`).join('; ');
    super(`Invalid CommunityHub payload${summary ? ` — ${summary}` : ''}`);
    this.name = 'CommunityHubPayloadValidationError';
    this.issues = issues;
  }
}

const LOCATION_TYPE_SET = new Set<string>(COMMUNITY_HUB_LOCATION_TYPES);
const DISPLAY_TYPE_SET = new Set<string>(COMMUNITY_HUB_DISPLAY_TYPES);
const POST_TYPE_ID_SET = new Set<number>(OBERLIN_POST_TYPE_IDS);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^(?=.*\d)\+?[0-9().\-\s]{7,30}$/;

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function read(input: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (Object.hasOwn(input, key)) return input[key];
  }
  return undefined;
}

function addIssue(
  issues: CommunityHubPayloadIssue[],
  path: string,
  code: string,
  message: string,
) {
  if (!issues.some(issue => issue.path === path && issue.code === code)) {
    issues.push({ path, code, message });
  }
}

function normalizeWhitespace(value: string): string {
  // House style: plain hyphens only — em/en dashes read as machine-generated.
  return value.replace(/[–—―]/g, '-').trim().replace(/\s+/g, ' ');
}

function trimAtBoundary(value: string, maxLength: number, preferSentence = false): string {
  if (value.length <= maxLength) return value;
  const withinLimit = value.slice(0, maxLength);

  if (preferSentence) {
    const sentenceEnds = [...withinLimit.matchAll(/[.!?](?=\s|$)/g)];
    const lastSentenceEnd = sentenceEnds.at(-1)?.index;
    if (lastSentenceEnd !== undefined && lastSentenceEnd >= 20) {
      return withinLimit.slice(0, lastSentenceEnd + 1).trim();
    }
  }

  const lastWhitespace = withinLimit.lastIndexOf(' ');
  if (lastWhitespace >= Math.floor(maxLength * 0.6)) {
    return withinLimit.slice(0, lastWhitespace).trim();
  }
  return withinLimit.trim();
}

function normalizeText(
  value: unknown,
  path: string,
  maxLength: number,
  issues: CommunityHubPayloadIssue[],
  preferSentence = false,
): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    addIssue(issues, path, 'invalid_type', 'must be a string');
    return '';
  }
  return trimAtBoundary(normalizeWhitespace(value), maxLength, preferSentence);
}

function parseArray(
  value: unknown,
  path: string,
  issues: CommunityHubPayloadIssue[],
): unknown[] {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Report the same stable error as a decoded non-array value.
    }
  }
  addIssue(issues, path, 'invalid_array', 'must be an array');
  return [];
}

function normalizeStringArray(
  value: unknown,
  path: string,
  issues: CommunityHubPayloadIssue[],
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const [index, item] of parseArray(value, path, issues).entries()) {
    if (typeof item !== 'string' || !normalizeWhitespace(item)) {
      addIssue(issues, `${path}[${index}]`, 'invalid_item', 'must be a non-empty string');
      continue;
    }
    const normalized = normalizeWhitespace(item);
    const key = normalized.toLocaleLowerCase('en-US');
    if (!seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  }
  return result;
}

function toPositiveInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function toUnixSeconds(value: unknown): number | null {
  const parsed = toPositiveInteger(value);
  // Ten digits comfortably covers the event horizon while rejecting the
  // 13-digit millisecond timestamps agents commonly put in this field.
  return parsed !== null && parsed <= 9_999_999_999 ? parsed : null;
}

function normalizeIdArray(
  value: unknown,
  path: string,
  issues: CommunityHubPayloadIssue[],
  allowed?: Set<number>,
): number[] {
  const result = new Set<number>();
  for (const [index, item] of parseArray(value, path, issues).entries()) {
    const id = toPositiveInteger(item);
    if (id === null) {
      addIssue(issues, `${path}[${index}]`, 'invalid_id', 'must be a positive integer');
      continue;
    }
    if (allowed && !allowed.has(id)) {
      addIssue(issues, `${path}[${index}]`, 'unknown_id', 'is not a valid Oberlin post type ID');
      continue;
    }
    result.add(id);
  }
  return [...result].sort((a, b) => a - b);
}

function normalizeSessions(
  value: unknown,
  issues: CommunityHubPayloadIssue[],
): CommunityHubSession[] {
  const result: CommunityHubSession[] = [];
  const seen = new Set<string>();

  for (const [index, item] of parseArray(value, 'sessions', issues).entries()) {
    const session = asRecord(item);
    if (Object.keys(session).length === 0) {
      addIssue(issues, `sessions[${index}]`, 'invalid_session', 'must be an object');
      continue;
    }
    const startTime = toUnixSeconds(session.startTime);
    const endTime = toUnixSeconds(session.endTime);
    if (startTime === null) {
      addIssue(issues, `sessions[${index}].startTime`, 'invalid_timestamp', 'must be a positive Unix timestamp in seconds');
    }
    if (endTime === null) {
      addIssue(issues, `sessions[${index}].endTime`, 'invalid_timestamp', 'must be a positive Unix timestamp in seconds');
    }
    if (startTime === null || endTime === null) continue;
    if (endTime < startTime) {
      addIssue(issues, `sessions[${index}].endTime`, 'invalid_range', 'must be greater than or equal to startTime');
      continue;
    }
    const key = `${startTime}:${endTime}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push({ startTime, endTime });
    }
  }

  return result.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeButtons(
  value: unknown,
  issues: CommunityHubPayloadIssue[],
): CommunityHubButton[] {
  const result: CommunityHubButton[] = [];
  const seen = new Set<string>();

  for (const [index, item] of parseArray(value, 'buttons', issues).entries()) {
    const button = asRecord(item);
    const title = normalizeText(button.title, `buttons[${index}].title`, 120, issues);
    const link = normalizeText(button.link, `buttons[${index}].link`, 2048, issues);
    if (!title) addIssue(issues, `buttons[${index}].title`, 'required', 'is required');
    if (!link) addIssue(issues, `buttons[${index}].link`, 'required', 'is required');
    if (link && !isHttpUrl(link)) {
      addIssue(issues, `buttons[${index}].link`, 'invalid_url', 'must be an absolute HTTP or HTTPS URL');
    }
    if (!title || !link || !isHttpUrl(link)) continue;
    const key = `${title.toLocaleLowerCase('en-US')}|${link}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push({ title, link });
    }
  }
  return result;
}

function normalizeLocationType(
  value: unknown,
  issues: CommunityHubPayloadIssue[],
): CommunityHubLocationType {
  if (value === undefined || value === null || value === '') {
    addIssue(issues, 'locationType', 'required', 'is required');
    return 'ne';
  }
  const candidate = String(value).trim().toLowerCase();
  if (LOCATION_TYPE_SET.has(candidate)) return candidate as CommunityHubLocationType;
  addIssue(issues, 'locationType', 'invalid_enum', 'must be ph2, on, bo, or ne');
  return 'ne';
}

function normalizeDisplayType(
  value: unknown,
  issues: CommunityHubPayloadIssue[],
): CommunityHubDisplayType {
  if (value === undefined || value === null || value === '') {
    addIssue(issues, 'display', 'required', 'is required');
    return 'all';
  }
  const candidate = String(value).trim().toLowerCase();
  if (DISPLAY_TYPE_SET.has(candidate)) return candidate as CommunityHubDisplayType;
  if (candidate === 'screen' || candidate === 'none') return 'ss';
  addIssue(issues, 'display', 'invalid_enum', 'must be all, ps, sps, or ss');
  return 'all';
}

function normalizeBoolean(
  value: unknown,
  fallback: boolean,
  path: string,
  issues: CommunityHubPayloadIssue[],
): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  addIssue(issues, path, 'invalid_boolean', 'must be a boolean');
  return fallback;
}

function validateOptionalUrl(
  value: string,
  path: string,
  issues: CommunityHubPayloadIssue[],
) {
  if (value && !isHttpUrl(value)) {
    addIssue(issues, path, 'invalid_url', 'must be an absolute HTTP or HTTPS URL');
  }
}

/**
 * Normalize agent output, API camelCase input, or raw_events snake_case rows.
 * Normalization is loss-limiting: invalid array members are omitted but always
 * recorded as issues so buildCommunityHubPayload can never silently publish.
 */
export function normalizeCommunityHubPayload(input: unknown): CommunityHubPayloadNormalization {
  const source = asRecord(input);
  const issues: CommunityHubPayloadIssue[] = [];

  const rawEventType = read(source, 'eventType', 'event_type');
  if (rawEventType === undefined || rawEventType === null || rawEventType === '') {
    addIssue(issues, 'eventType', 'required', 'is required');
  } else if (!isRecognizedEventType(rawEventType)) {
    addIssue(issues, 'eventType', 'invalid_enum', 'must be ot, an, or jp');
  }

  const display = normalizeDisplayType(read(source, 'display'), issues);
  const rawScreenIds = normalizeIdArray(read(source, 'screensIds', 'screen_ids'), 'screensIds', issues);
  const postTypeId = normalizeIdArray(
    read(source, 'postTypeId', 'post_type_ids'),
    'postTypeId',
    issues,
    POST_TYPE_ID_SET,
  ) as OberlinPostTypeId[];
  const locationType = normalizeLocationType(read(source, 'locationType', 'location_type'), issues);
  const normalizedPlaceId = normalizeText(read(source, 'placeId', 'place_id'), 'placeId', 120, issues);

  const payload: CommunityHubPayload = {
    eventType: normalizeEventType(rawEventType),
    email: normalizeText(read(source, 'email'), 'email', 254, issues),
    subscribe: normalizeBoolean(read(source, 'subscribe'), true, 'subscribe', issues),
    title: normalizeText(read(source, 'title', 'name'), 'title', 60, issues),
    description: normalizeText(read(source, 'description'), 'description', 200, issues, true),
    sponsors: normalizeStringArray(read(source, 'sponsors'), 'sponsors', issues),
    postTypeId,
    sessions: normalizeSessions(read(source, 'sessions'), issues),
    locationType,
    display,
    screensIds: display === 'ss' ? rawScreenIds : [],
    phone: normalizeText(read(source, 'phone'), 'phone', 30, issues),
    website: normalizeText(read(source, 'website'), 'website', 2048, issues),
    urlLink: normalizeText(read(source, 'urlLink', 'url_link'), 'urlLink', 2048, issues),
    placeId: locationType === 'ph2' || locationType === 'bo' ? normalizedPlaceId : '',
    buttons: normalizeButtons(read(source, 'buttons'), issues),
    public: normalizeBoolean(read(source, 'public'), true, 'public', issues) ? '1' : '0',
  };

  const optionalText: Array<[
    keyof Pick<
      CommunityHubPayload,
      | 'contactEmail'
      | 'extendedDescription'
      | 'location'
      | 'placeName'
      | 'roomNum'
      | 'image_cdn_url'
      | 'calendarSourceName'
      | 'calendarSourceUrl'
      | 'ingestedPostUrl'
    >,
    unknown,
    string,
    number,
    boolean?,
  ]> = [
    ['contactEmail', read(source, 'contactEmail', 'contact_email'), 'contactEmail', 254],
    ['extendedDescription', read(source, 'extendedDescription', 'extended_description'), 'extendedDescription', 1000, true],
    ['location', read(source, 'location'), 'location', 255],
    ['placeName', read(source, 'placeName', 'place_name'), 'placeName', 120],
    ['roomNum', read(source, 'roomNum', 'room_num'), 'roomNum', 80],
    ['image_cdn_url', read(source, 'image_cdn_url'), 'image_cdn_url', 2048],
    ['calendarSourceName', read(source, 'calendarSourceName', 'calendar_source_name'), 'calendarSourceName', 120],
    ['calendarSourceUrl', read(source, 'calendarSourceUrl', 'calendar_source_url'), 'calendarSourceUrl', 2048],
    ['ingestedPostUrl', read(source, 'ingestedPostUrl', 'ingested_post_url'), 'ingestedPostUrl', 2048],
  ];

  for (const [key, value, path, maxLength, preferSentence = false] of optionalText) {
    const normalized = normalizeText(value, path, maxLength, issues, preferSentence);
    if (normalized) Object.assign(payload, { [key]: normalized });
  }

  return { payload, issues };
}

/** Validate all documented Oberlin payload and conditional-field rules. */
export function validateCommunityHubPayload(input: unknown): CommunityHubPayloadValidation {
  const { payload, issues } = normalizeCommunityHubPayload(input);

  if (!payload.title) addIssue(issues, 'title', 'required', 'is required');
  if (payload.description.length < 10) {
    addIssue(issues, 'description', 'too_short', 'must contain at least 10 characters');
  }
  if (!payload.email) addIssue(issues, 'email', 'required', 'is required');
  if (payload.email && !EMAIL_PATTERN.test(payload.email)) {
    addIssue(issues, 'email', 'invalid_email', 'must be a valid email address');
  }
  if (payload.contactEmail && !EMAIL_PATTERN.test(payload.contactEmail)) {
    addIssue(issues, 'contactEmail', 'invalid_email', 'must be a valid email address');
  }
  if (payload.phone && !PHONE_PATTERN.test(payload.phone)) {
    addIssue(issues, 'phone', 'invalid_phone', 'must be a valid phone number');
  }
  if (payload.sponsors.length === 0) {
    addIssue(issues, 'sponsors', 'required', 'must contain at least one sponsor');
  }
  if (payload.postTypeId.length === 0) {
    addIssue(issues, 'postTypeId', 'required', 'must contain at least one Oberlin post type ID');
  }
  if (payload.sessions.length === 0) {
    addIssue(issues, 'sessions', 'required', 'must contain at least one valid session');
  } else {
    const expirationIssue = getCommunityHubExpirationIssue(payload.sessions);
    if (expirationIssue) {
      addIssue(issues, expirationIssue.path, expirationIssue.code, expirationIssue.message);
    }
    // Observed live 2026-07-16: CommunityHub answers 500 "Session Start Date
    // & End Date can not be same" for events. Announcements legitimately use
    // one instant as their display window per CommunityHub's own docs.
    if (payload.eventType !== 'an') {
      for (const [index, session] of payload.sessions.entries()) {
        if (session.endTime === session.startTime) {
          addIssue(
            issues,
            `sessions[${index}].endTime`,
            'end_equals_start',
            'CommunityHub rejects events whose end time equals the start time; set the real end time from the source (a reviewer must supply it when the source states none)',
          );
        }
      }
    }
  }

  const needsPhysicalLocation = payload.locationType === 'ph2' || payload.locationType === 'bo';
  const needsOnlineLocation = payload.locationType === 'on' || payload.locationType === 'bo';
  if (needsPhysicalLocation && !payload.location) {
    addIssue(issues, 'location', 'required', `is required for locationType ${payload.locationType}`);
  }
  if (needsOnlineLocation && !payload.urlLink) {
    addIssue(issues, 'urlLink', 'required', `is required for locationType ${payload.locationType}`);
  }
  if (payload.display === 'ss' && payload.screensIds.length === 0) {
    addIssue(issues, 'screensIds', 'required', 'must contain at least one screen when display is ss');
  }

  validateOptionalUrl(payload.website, 'website', issues);
  validateOptionalUrl(payload.urlLink, 'urlLink', issues);
  if (payload.image_cdn_url) {
    const imageUrl = validatePublicHttpUrl(payload.image_cdn_url);
    if (!imageUrl.success) {
      addIssue(
        issues,
        'image_cdn_url',
        imageUrl.code === 'non_public_host' ? 'non_public_url' : 'invalid_url',
        `must be an absolute HTTP or HTTPS URL on a public host (${imageUrl.message})`,
      );
    }
  }
  validateOptionalUrl(payload.calendarSourceUrl ?? '', 'calendarSourceUrl', issues);
  validateOptionalUrl(payload.ingestedPostUrl ?? '', 'ingestedPostUrl', issues);

  if (issues.length > 0) {
    return { success: false, data: null, normalized: payload, errors: issues };
  }
  return { success: true, data: payload, errors: [] };
}

/** Build a publishable payload or throw with field-level validation issues. */
export function buildCommunityHubPayload(input: unknown): CommunityHubPayload {
  const result = validateCommunityHubPayload(input);
  if (!result.success) throw new CommunityHubPayloadValidationError(result.errors);
  return result.data;
}
