import {
  EVENT_TYPES,
  getEventTypeLabel,
  isEventType,
  isRecognizedEventType,
  normalizeEventType,
} from '@/lib/eventTypes';

describe('event type contract', () => {
  it('exposes only the three CommunityHub post kinds', () => {
    expect(EVENT_TYPES).toEqual([
      { value: 'ot', label: 'Event' },
      { value: 'an', label: 'Announcement' },
      { value: 'jp', label: 'Job' },
    ]);
  });

  it('normalizes legacy category-like agent output to Event', () => {
    expect(normalizeEventType(' EV ')).toBe('ot');
    expect(normalizeEventType('wk')).toBe('ot');
    expect(normalizeEventType('Announcement')).toBe('an');
    expect(normalizeEventType('job posting')).toBe('jp');
    expect(normalizeEventType('invented')).toBe('ot');
    expect(normalizeEventType(undefined)).toBe('ot');
  });

  it('keeps strict validation separate from compatibility normalization', () => {
    expect(getEventTypeLabel('an')).toBe('Announcement');
    expect(getEventTypeLabel('ev')).toBe('Event');
    expect(getEventTypeLabel('not-real')).toBe('Event');
    expect(isEventType('jp')).toBe(true);
    expect(isEventType('ev')).toBe(false);
    expect(isEventType('JP')).toBe(false);
    expect(isRecognizedEventType('ev')).toBe(true);
    expect(isRecognizedEventType('not-real')).toBe(false);
  });
});
