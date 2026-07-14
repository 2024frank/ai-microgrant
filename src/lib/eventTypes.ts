export const EVENT_TYPES = [
  { value: 'ot', label: 'Event' },
  { value: 'an', label: 'Announcement' },
  { value: 'jp', label: 'Job' },
] as const;

export type EventType = (typeof EVENT_TYPES)[number]['value'];

/**
 * Older agents used category-like values in eventType. CommunityHub only
 * accepts ot/an/jp; categories such as class, exhibit, or workshop belong in
 * postTypeId instead. Keep these inputs readable while data is migrated.
 */
export const LEGACY_EVENT_TYPE_CODES = [
  'ev', 'cl', 'ex', 'vt', 'sp', 'pe', 'wk', 'ms', 'ws',
] as const;

const EVENT_TYPE_VALUES = new Set<string>(EVENT_TYPES.map(type => type.value));
const EVENT_TYPE_LABELS = Object.fromEntries(
  EVENT_TYPES.map(type => [type.value, type.label]),
) as Record<EventType, string>;

const LEGACY_EVENT_TYPE_VALUES = new Set<string>(LEGACY_EVENT_TYPE_CODES);
const EVENT_TYPE_ALIASES: Record<string, EventType> = {
  event: 'ot',
  announcement: 'an',
  job: 'jp',
  'job posting': 'jp',
};

/**
 * Agent output is untrusted. Collapse legacy category-like codes to the
 * canonical Event value and use Event as the compatibility fallback. Strict
 * payload validation is responsible for rejecting wholly unknown input.
 */
export function normalizeEventType(value: unknown): EventType {
  const candidate = String(value ?? '').trim().toLowerCase();
  if (EVENT_TYPE_VALUES.has(candidate)) return candidate as EventType;
  if (LEGACY_EVENT_TYPE_VALUES.has(candidate)) return 'ot';
  return EVENT_TYPE_ALIASES[candidate] ?? 'ot';
}

export function getEventTypeLabel(value: unknown): string {
  return EVENT_TYPE_LABELS[normalizeEventType(value)];
}

export function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && EVENT_TYPE_VALUES.has(value);
}

/** True for canonical codes and intentional compatibility aliases. */
export function isRecognizedEventType(value: unknown): boolean {
  const candidate = String(value ?? '').trim().toLowerCase();
  return EVENT_TYPE_VALUES.has(candidate)
    || LEGACY_EVENT_TYPE_VALUES.has(candidate)
    || Object.hasOwn(EVENT_TYPE_ALIASES, candidate);
}
