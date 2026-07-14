export const SCHEDULE_TIME_ZONE = 'America/New_York';

type CronFieldName = 'minute' | 'hour' | 'dayOfMonth' | 'month' | 'dayOfWeek';

type CronField = {
  values: ReadonlySet<number>;
  wildcard: boolean;
};

export type ParsedCronExpression = {
  expression: string;
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
};

export type CronValidationResult =
  | { valid: true; schedule: ParsedCronExpression }
  | { valid: false; error: string };

const FIELD_CONFIG: Record<CronFieldName, { min: number; max: number; allowQuestion: boolean }> = {
  minute:     { min: 0, max: 59, allowQuestion: false },
  hour:       { min: 0, max: 23, allowQuestion: false },
  dayOfMonth: { min: 1, max: 31, allowQuestion: true },
  month:      { min: 1, max: 12, allowQuestion: false },
  dayOfWeek:  { min: 0, max: 7, allowQuestion: true },
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function parseInteger(value: string, fieldName: CronFieldName): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${fieldName} contains a non-numeric value`);
  }
  return Number(value);
}

function normalizeValue(fieldName: CronFieldName, value: number): number {
  return fieldName === 'dayOfWeek' && value === 7 ? 0 : value;
}

function parseField(token: string, fieldName: CronFieldName): CronField {
  const { min, max, allowQuestion } = FIELD_CONFIG[fieldName];
  const wildcard = token === '*' || token === '?';

  if (token === '?' && !allowQuestion) {
    throw new Error(`${fieldName} does not support ?`);
  }
  if (wildcard) {
    const values = new Set<number>();
    for (let value = min; value <= max; value++) {
      values.add(normalizeValue(fieldName, value));
    }
    return { values, wildcard: true };
  }
  if (!token) throw new Error(`${fieldName} is empty`);

  const values = new Set<number>();
  for (const segment of token.split(',')) {
    if (!segment) throw new Error(`${fieldName} contains an empty list item`);

    const stepParts = segment.split('/');
    if (stepParts.length > 2) throw new Error(`${fieldName} contains an invalid step`);
    const [rangeToken, stepToken] = stepParts;
    const step = stepToken === undefined ? 1 : parseInteger(stepToken, fieldName);
    if (step < 1) throw new Error(`${fieldName} step must be at least 1`);

    let start: number;
    let end: number;
    if (rangeToken === '*') {
      start = min;
      end = max;
    } else if (rangeToken.includes('-')) {
      const rangeParts = rangeToken.split('-');
      if (rangeParts.length !== 2) throw new Error(`${fieldName} contains an invalid range`);
      start = parseInteger(rangeParts[0], fieldName);
      end = parseInteger(rangeParts[1], fieldName);
    } else {
      if (stepToken !== undefined) {
        throw new Error(`${fieldName} steps require * or a range`);
      }
      start = parseInteger(rangeToken, fieldName);
      end = start;
    }

    if (start < min || start > max || end < min || end > max) {
      throw new Error(`${fieldName} must be between ${min} and ${max}`);
    }
    if (start > end) throw new Error(`${fieldName} ranges must be ascending`);

    for (let value = start; value <= end; value += step) {
      values.add(normalizeValue(fieldName, value));
    }
  }

  if (values.size === 0) throw new Error(`${fieldName} does not select any values`);
  return { values, wildcard: false };
}

export function validateCronExpression(expression: unknown): CronValidationResult {
  const normalized = typeof expression === 'string'
    ? expression.trim().replace(/\s+/g, ' ')
    : '';
  const parts = normalized ? normalized.split(/\s+/) : [];
  if (parts.length !== 5) {
    return { valid: false, error: 'Cron expression must contain exactly 5 fields' };
  }

  try {
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
    return {
      valid: true,
      schedule: {
        expression: normalized,
        minute: parseField(minute, 'minute'),
        hour: parseField(hour, 'hour'),
        dayOfMonth: parseField(dayOfMonth, 'dayOfMonth'),
        month: parseField(month, 'month'),
        dayOfWeek: parseField(dayOfWeek, 'dayOfWeek'),
      },
    };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Invalid cron expression',
    };
  }
}

export function parseCronExpression(expression: unknown): ParsedCronExpression | null {
  const result = validateCronExpression(expression);
  return result.valid ? result.schedule : null;
}

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

function getZonedParts(date: Date, timeZone: string) {
  const parts = getFormatter(timeZone).formatToParts(date);
  const values = Object.fromEntries(
    parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]),
  ) as Record<string, number>;

  const year = values.year;
  const month = values.month;
  const day = values.day;
  return {
    year,
    minute: values.minute,
    hour: values.hour,
    dayOfMonth: day,
    month,
    dayOfWeek: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

function scheduleMatchesDate(
  schedule: ParsedCronExpression,
  date: Date,
  timeZone: string,
): boolean {
  if (Number.isNaN(date.getTime())) return false;

  let zoned: ReturnType<typeof getZonedParts>;
  try {
    zoned = getZonedParts(date, timeZone);
  } catch {
    return false;
  }

  if (!schedule.minute.values.has(zoned.minute)) return false;
  if (!schedule.hour.values.has(zoned.hour)) return false;
  if (!schedule.month.values.has(zoned.month)) return false;

  const dayOfMonthMatches = schedule.dayOfMonth.values.has(zoned.dayOfMonth);
  const dayOfWeekMatches = schedule.dayOfWeek.values.has(zoned.dayOfWeek);

  // Vixie cron semantics: when both day fields are restricted, either may match.
  if (!schedule.dayOfMonth.wildcard && !schedule.dayOfWeek.wildcard) {
    return dayOfMonthMatches || dayOfWeekMatches;
  }
  return dayOfMonthMatches && dayOfWeekMatches;
}

export function cronMatchesDate(
  expression: unknown,
  date: Date,
  timeZone = SCHEDULE_TIME_ZONE,
): boolean {
  const schedule = parseCronExpression(expression);
  return schedule ? scheduleMatchesDate(schedule, date, timeZone) : false;
}

function floorToMinute(date: Date): Date {
  const result = new Date(date);
  result.setUTCSeconds(0, 0);
  return result;
}

type CalendarDate = {
  year: number;
  month: number;
  dayOfMonth: number;
};

function compareCalendarDates(left: CalendarDate, right: CalendarDate): number {
  if (left.year !== right.year) return left.year - right.year;
  if (left.month !== right.month) return left.month - right.month;
  return left.dayOfMonth - right.dayOfMonth;
}

function nextCalendarDate(date: CalendarDate): CalendarDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.dayOfMonth + 1));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    dayOfMonth: next.getUTCDate(),
  };
}

function scheduleMatchesCalendarDate(
  schedule: ParsedCronExpression,
  date: CalendarDate,
): boolean {
  if (!schedule.month.values.has(date.month)) return false;

  const dayOfWeek = new Date(
    Date.UTC(date.year, date.month - 1, date.dayOfMonth),
  ).getUTCDay();
  const dayOfMonthMatches = schedule.dayOfMonth.values.has(date.dayOfMonth);
  const dayOfWeekMatches = schedule.dayOfWeek.values.has(dayOfWeek);

  if (!schedule.dayOfMonth.wildcard && !schedule.dayOfWeek.wildcard) {
    return dayOfMonthMatches || dayOfWeekMatches;
  }
  return dayOfMonthMatches && dayOfWeekMatches;
}

function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const zoned = getZonedParts(date, timeZone);
  const representedAsUtc = Date.UTC(
    zoned.year,
    zoned.month - 1,
    zoned.dayOfMonth,
    zoned.hour,
    zoned.minute,
  );
  return representedAsUtc - floorToMinute(date).getTime();
}

/**
 * Collect the offsets that can apply to a local calendar date. Sampling the
 * surrounding two days captures both sides of daylight-saving transitions.
 */
function offsetsForCalendarDate(date: CalendarDate, timeZone: string): number[] {
  const noonAsUtc = Date.UTC(date.year, date.month - 1, date.dayOfMonth, 12);
  const offsets = new Set<number>();
  for (const hourDelta of [-48, -24, 0, 24, 48]) {
    offsets.add(timeZoneOffsetMs(new Date(noonAsUtc + hourDelta * 3_600_000), timeZone));
  }
  return [...offsets];
}

function exactInstantsForWallTime(
  date: CalendarDate,
  hour: number,
  minute: number,
  offsets: readonly number[],
  timeZone: string,
): Date[] {
  const wallTimeAsUtc = Date.UTC(
    date.year,
    date.month - 1,
    date.dayOfMonth,
    hour,
    minute,
  );
  const instants: Date[] = [];

  for (const offset of offsets) {
    const candidate = new Date(wallTimeAsUtc - offset);
    const zoned = getZonedParts(candidate, timeZone);
    if (
      zoned.year === date.year
      && zoned.month === date.month
      && zoned.dayOfMonth === date.dayOfMonth
      && zoned.hour === hour
      && zoned.minute === minute
    ) {
      instants.push(candidate);
    }
  }

  return instants;
}

/**
 * Return the latest scheduled slot in the dispatcher's current hourly window.
 * An hourly dispatcher coalesces expressions that select multiple minutes into
 * one source run, using the latest matching minute as the idempotency slot.
 */
export function getDueScheduleSlot(
  expression: unknown,
  now: Date = new Date(),
  timeZone = SCHEDULE_TIME_ZONE,
): Date | null {
  const schedule = parseCronExpression(expression);
  if (!schedule || Number.isNaN(now.getTime())) return null;
  const cursor = floorToMinute(now);
  for (let offset = 0; offset < 60; offset++) {
    const candidate = new Date(cursor.getTime() - offset * 60_000);
    if (scheduleMatchesDate(schedule, candidate, timeZone)) return candidate;
  }
  return null;
}

/** Find the next exact cron occurrence strictly after `from`. */
export function getNextRunAt(
  expression: unknown,
  from: Date = new Date(),
  timeZone = SCHEDULE_TIME_ZONE,
  maxSearchMinutes = 5 * 366 * 24 * 60,
): Date | null {
  const schedule = parseCronExpression(expression);
  const searchMinutes = Math.floor(maxSearchMinutes);
  if (
    !schedule
    || Number.isNaN(from.getTime())
    || !Number.isFinite(searchMinutes)
    || searchMinutes < 1
  ) {
    return null;
  }

  const cursor = floorToMinute(from);
  const end = new Date(cursor.getTime() + searchMinutes * 60_000);
  if (Number.isNaN(end.getTime())) return null;

  let startParts: ReturnType<typeof getZonedParts>;
  let endParts: ReturnType<typeof getZonedParts>;
  try {
    startParts = getZonedParts(new Date(cursor.getTime() + 60_000), timeZone);
    endParts = getZonedParts(end, timeZone);
  } catch {
    return null;
  }

  let calendarDate: CalendarDate = {
    year: startParts.year,
    month: startParts.month,
    dayOfMonth: startParts.dayOfMonth,
  };
  const lastCalendarDate: CalendarDate = {
    year: endParts.year,
    month: endParts.month,
    dayOfMonth: endParts.dayOfMonth,
  };
  const hours = [...schedule.hour.values].sort((left, right) => left - right);
  const minutes = [...schedule.minute.values].sort((left, right) => left - right);

  // Search calendar days rather than every UTC minute. Impossible schedules
  // such as February 31 now cost at most one small pass over the bounded date
  // range, while candidate wall times still resolve through Intl for DST.
  while (compareCalendarDates(calendarDate, lastCalendarDate) <= 0) {
    if (scheduleMatchesCalendarDate(schedule, calendarDate)) {
      let offsets: number[];
      try {
        offsets = offsetsForCalendarDate(calendarDate, timeZone);
      } catch {
        return null;
      }

      let earliest: Date | null = null;
      for (const hour of hours) {
        for (const minute of minutes) {
          let candidates: Date[];
          try {
            candidates = exactInstantsForWallTime(
              calendarDate,
              hour,
              minute,
              offsets,
              timeZone,
            );
          } catch {
            return null;
          }

          for (const candidate of candidates) {
            if (
              candidate.getTime() > cursor.getTime()
              && candidate.getTime() <= end.getTime()
              && (!earliest || candidate.getTime() < earliest.getTime())
            ) {
              earliest = candidate;
            }
          }
        }
      }
      if (earliest) return earliest;
    }
    calendarDate = nextCalendarDate(calendarDate);
  }

  return null;
}

/** Compatibility helper for older callers; now checks all fields and fails closed. */
export function shouldRunToday(expression: unknown, date: Date = new Date()): boolean {
  return cronMatchesDate(expression, date, SCHEDULE_TIME_ZONE);
}
