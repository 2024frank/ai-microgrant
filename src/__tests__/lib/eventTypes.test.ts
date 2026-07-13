import { EVENT_TYPES, getEventTypeLabel, isEventType, normalizeEventType } from '@/lib/eventTypes';

describe('event type contract', () => {
  it('keeps every database ENUM code in the shared list', () => {
    expect(EVENT_TYPES.map(type => type.value)).toEqual([
      'ot', 'an', 'jp', 'ev', 'cl', 'ex', 'vt', 'sp', 'pe', 'wk', 'ms', 'ws',
    ]);
  });

  it('normalizes valid agent output and safely defaults unknown values', () => {
    expect(normalizeEventType(' EV ')).toBe('ev');
    expect(normalizeEventType('invented')).toBe('ot');
    expect(normalizeEventType(undefined)).toBe('ot');
  });

  it('provides human-readable labels without exposing unknown codes', () => {
    expect(getEventTypeLabel('an')).toBe('Announcement');
    expect(getEventTypeLabel('not-real')).toBe('Other');
    expect(isEventType('jp')).toBe(true);
    expect(isEventType('JP')).toBe(false);
  });
});
