const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DATE_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export class CalendarMonthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalendarMonthError';
  }
}

export type CalendarMonthUtcRange = {
  month: string;
  timezone: string;
  /** Inclusive lower bound in UTC for scheduledAt queries. */
  startUtc: Date;
  /** Exclusive upper bound in UTC for scheduledAt queries. */
  endUtcExclusive: Date;
};

export type CalendarDayUtcRange = {
  date: string;
  timezone: string;
  /** Inclusive lower bound in UTC for scheduledAt queries. */
  startUtc: Date;
  /** Exclusive upper bound in UTC for scheduledAt queries. */
  endUtcExclusive: Date;
};

function getZonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0';
  const hour = Number(get('hour'));
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: hour === 24 ? 0 : hour,
    minute: Number(get('minute')),
    second: Number(get('second')),
  };
}

/** Convert a wall-clock time in `timeZone` to a UTC Date. */
function wallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  let candidate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  for (let i = 0; i < 4; i++) {
    const zoned = getZonedParts(candidate, timeZone);
    const desired = Date.UTC(year, month - 1, day, hour, minute, second);
    const actual = Date.UTC(
      zoned.year,
      zoned.month - 1,
      zoned.day,
      zoned.hour,
      zoned.minute,
      zoned.second,
    );
    const diff = desired - actual;
    if (diff === 0) break;
    candidate = new Date(candidate.getTime() + diff);
  }

  return candidate;
}

export function validateIanaTimezone(timezone: string): string {
  const tz = timezone.trim();
  if (!tz) {
    throw new CalendarMonthError('Invalid timezone. Provide an IANA timezone string.');
  }

  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return tz;
  } catch {
    throw new CalendarMonthError(`Invalid timezone: ${tz}`);
  }
}

export function parseCalendarMonth(value: unknown): { year: number; month: number; monthKey: string } {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CalendarMonthError('Invalid month format. Use YYYY-MM.');
  }

  const match = value.trim().match(MONTH_PATTERN);
  if (!match) {
    throw new CalendarMonthError('Invalid month format. Use YYYY-MM.');
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  return { year, month, monthKey: `${match[1]}-${match[2]}` };
}

export function parseCalendarDate(
  value: unknown,
): { year: number; month: number; day: number; dateKey: string } {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CalendarMonthError('Invalid date format. Use YYYY-MM-DD.');
  }

  const match = value.trim().match(DATE_PATTERN);
  if (!match) {
    throw new CalendarMonthError('Invalid date format. Use YYYY-MM-DD.');
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year
    || probe.getUTCMonth() + 1 !== month
    || probe.getUTCDate() !== day
  ) {
    throw new CalendarMonthError('Invalid date.');
  }

  return { year, month, day, dateKey: `${match[1]}-${match[2]}-${match[3]}` };
}

/**
 * Calendar month bounds in UTC for posts scheduled in a timezone-local month.
 * Query with: scheduledAt >= startUtc AND scheduledAt < endUtcExclusive
 */
export function getCalendarMonthUtcRange(params: {
  month: string;
  timezone: string;
}): CalendarMonthUtcRange {
  const { year, month, monthKey } = parseCalendarMonth(params.month);
  const timezone = validateIanaTimezone(params.timezone);

  const startUtc = wallClockToUtc(year, month, 1, 0, 0, 0, timezone);

  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const endUtcExclusive = wallClockToUtc(nextYear, nextMonth, 1, 0, 0, 0, timezone);

  return {
    month: monthKey,
    timezone,
    startUtc,
    endUtcExclusive,
  };
}

/**
 * Calendar day bounds in UTC for posts scheduled on a timezone-local date.
 * Query with: scheduledAt >= startUtc AND scheduledAt < endUtcExclusive
 */
export function getCalendarDayUtcRange(params: {
  date: string;
  timezone: string;
}): CalendarDayUtcRange {
  const { year, month, day, dateKey } = parseCalendarDate(params.date);
  const timezone = validateIanaTimezone(params.timezone);

  const startUtc = wallClockToUtc(year, month, day, 0, 0, 0, timezone);

  const nextNoon = wallClockToUtc(year, month, day + 1, 12, 0, 0, timezone);
  const nextParts = getZonedParts(nextNoon, timezone);
  const endUtcExclusive = wallClockToUtc(
    nextParts.year,
    nextParts.month,
    nextParts.day,
    0,
    0,
    0,
    timezone,
  );

  return {
    date: dateKey,
    timezone,
    startUtc,
    endUtcExclusive,
  };
}
