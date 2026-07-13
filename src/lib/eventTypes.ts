export const EVENT_TYPES = [
  { value: 'ot', label: 'Other' },
  { value: 'an', label: 'Announcement' },
  { value: 'jp', label: 'Job posting' },
  { value: 'ev', label: 'Event' },
  { value: 'cl', label: 'Class' },
  { value: 'ex', label: 'Exhibit' },
  { value: 'vt', label: 'Volunteer' },
  { value: 'sp', label: 'Sports' },
  { value: 'pe', label: 'Performance' },
  { value: 'wk', label: 'Workshop' },
  { value: 'ms', label: 'Meeting' },
  { value: 'ws', label: 'Worship service' },
] as const;

export type EventType = (typeof EVENT_TYPES)[number]['value'];

const EVENT_TYPE_VALUES = new Set<string>(EVENT_TYPES.map(type => type.value));
const EVENT_TYPE_LABELS = Object.fromEntries(
  EVENT_TYPES.map(type => [type.value, type.label]),
) as Record<EventType, string>;

/**
 * Agent output is untrusted. Keep the database value inside its declared ENUM
 * and use "Other" when an agent omits or invents a type.
 */
export function normalizeEventType(value: unknown): EventType {
  const candidate = String(value ?? '').trim().toLowerCase();
  return EVENT_TYPE_VALUES.has(candidate) ? candidate as EventType : 'ot';
}

export function getEventTypeLabel(value: unknown): string {
  return EVENT_TYPE_LABELS[normalizeEventType(value)];
}

export function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && EVENT_TYPE_VALUES.has(value);
}
