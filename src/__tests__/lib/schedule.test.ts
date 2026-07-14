import {
  cronMatchesDate,
  describeCronExpression,
  getDueScheduleSlot,
  getNextRunAt,
  parseCronExpression,
  validateCronExpression,
} from '@/lib/schedule';

describe('cron scheduling in America/New_York', () => {
  it.each([
    ['0 8 * * 1', 'Every Monday at 8:00 AM'],
    ['0 6 * * 1-5', 'Weekdays at 6:00 AM'],
    ['30 14 * * *', 'Every day at 2:30 PM'],
    ['0 * * * *', 'Every hour'],
    ['15 */6 * * *', 'Every 6 hours at :15'],
    ['0 9 * * 1,3', 'Every Monday and Wednesday at 9:00 AM'],
    ['0 7 1 * *', 'Monthly on day 1 at 7:00 AM'],
  ])('describes %s without exposing cron syntax', (expression, description) => {
    expect(describeCronExpression(expression)).toBe(description);
  });

  it('labels unusual valid schedules as custom and malformed schedules as invalid', () => {
    expect(describeCronExpression('0,30 6 * * *')).toBe('Custom schedule');
    expect(describeCronExpression('0 */5 * * *')).toBe('Custom schedule');
    expect(describeCronExpression('0 */25 * * *')).toBe('Custom schedule');
    expect(describeCronExpression('not a schedule')).toBe('Invalid schedule');
  });

  it('parses lists, ranges, steps, and Sunday=7 across all five fields', () => {
    const parsed = parseCronExpression('*/15 6-8 1,15 1-12/2 1-5,7');
    expect(parsed).not.toBeNull();
    expect([...parsed!.minute.values]).toEqual([0, 15, 30, 45]);
    expect([...parsed!.hour.values]).toEqual([6, 7, 8]);
    expect(parsed!.dayOfMonth.values.has(15)).toBe(true);
    expect(parsed!.month.values.has(11)).toBe(true);
    expect(parsed!.dayOfWeek.values.has(0)).toBe(true);
  });

  it('evaluates minute and hour in America/New_York rather than UTC', () => {
    // 10:00 UTC is 06:00 EDT on Monday, July 13, 2026.
    expect(cronMatchesDate('0 6 * * 1', new Date('2026-07-13T10:00:00Z'))).toBe(true);
    expect(cronMatchesDate('0 6 * * 1', new Date('2026-07-13T09:00:00Z'))).toBe(false);
  });

  it('uses standard cron OR semantics when both day fields are restricted', () => {
    // July 13, 2026 is Monday but not day 1, so day-of-week makes it due.
    expect(cronMatchesDate('0 6 1 * 1', new Date('2026-07-13T10:00:00Z'))).toBe(true);
  });

  it.each([
    '',
    '0 6 * *',
    '60 6 * * *',
    '0 24 * * *',
    '*/0 6 * * *',
    '0 six * * *',
    '0 6 20-10 * *',
    '0 6 * ? *',
  ])('fails closed for malformed expression %p', expression => {
    expect(validateCronExpression(expression).valid).toBe(false);
    expect(cronMatchesDate(expression, new Date('2026-07-13T10:00:00Z'))).toBe(false);
    expect(getDueScheduleSlot(expression, new Date('2026-07-13T11:00:00Z'))).toBeNull();
  });

  it('finds the latest due slot in the hourly dispatch window', () => {
    const slot = getDueScheduleSlot('30 6 * * *', new Date('2026-07-13T11:00:00Z'));
    expect(slot?.toISOString()).toBe('2026-07-13T10:30:00.000Z');
  });

  it('can recover a slot when the external dispatcher starts more than an hour late', () => {
    const slot = getDueScheduleSlot(
      '0 6 * * *',
      new Date('2026-07-14T11:46:00Z'),
      undefined,
      48 * 60,
    );
    expect(slot?.toISOString()).toBe('2026-07-14T10:00:00.000Z');
  });

  it('exports the next exact run for UI previews', () => {
    const next = getNextRunAt('0 6 * * *', new Date('2026-07-13T09:45:00Z'));
    expect(next?.toISOString()).toBe('2026-07-13T10:00:00.000Z');

    const following = getNextRunAt('0 6 * * *', next!);
    expect(following?.toISOString()).toBe('2026-07-14T10:00:00.000Z');
  });

  it('returns quickly for a syntactically valid but impossible calendar date', () => {
    const startedAt = performance.now();
    const next = getNextRunAt('0 6 31 2 *', new Date('2026-03-01T00:00:00Z'));

    expect(next).toBeNull();
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  it('finds leap-day runs without scanning every intervening minute', () => {
    const next = getNextRunAt('0 6 29 2 *', new Date('2026-03-01T00:00:00Z'));
    expect(next?.toISOString()).toBe('2028-02-29T11:00:00.000Z');
  });

  it('preserves OR semantics while skipping impossible day-of-month values', () => {
    const next = getNextRunAt('0 6 31 2 1', new Date('2026-02-01T00:00:00Z'));
    expect(next?.toISOString()).toBe('2026-02-02T11:00:00.000Z');
  });

  it('skips local wall times that do not exist during spring DST', () => {
    const next = getNextRunAt('30 2 * * *', new Date('2026-03-08T05:00:00Z'));
    expect(next?.toISOString()).toBe('2026-03-09T06:30:00.000Z');
  });

  it('returns the second matching instant during the repeated fall DST hour', () => {
    const next = getNextRunAt('30 1 * * *', new Date('2026-11-01T05:45:00Z'));
    expect(next?.toISOString()).toBe('2026-11-01T06:30:00.000Z');
  });

  it('respects the explicit UTC-minute search bound', () => {
    const next = getNextRunAt(
      '0 6 * * *',
      new Date('2026-07-13T09:45:00Z'),
      undefined,
      14,
    );
    expect(next).toBeNull();
  });
});
