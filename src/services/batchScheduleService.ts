/**
 * Batch posting schedule helpers for Trending Bot generation.
 *
 * Schedule is provided per request on POST /bot/generate as:
 *   { timeSlots: ["HH:mm", ...], days: [0-6], timezone?: "IANA/Zone" }
 *
 * Legacy shape `{ time: "HH:mm", ... }` is accepted and normalized to `timeSlots`.
 *
 * Day indices: 0 = Sunday, 1 = Monday, ... 6 = Saturday.
 *
 * Timezone conversion uses Intl (no extra dependencies). `scheduledAt` is
 * stored as a UTC Date for Prisma; the cron publisher compares against `now`.
 */

export type PostingScheduleConfig = {
  timeSlots?: string[];
  /** @deprecated Use timeSlots. Accepted for backwards compatibility. */
  time?: string;
  days: number[];
  timezone?: string;
};

export type NormalizedPostingScheduleConfig = {
  timeSlots: string[];
  days: number[];
  timezone: string;
};

export class BatchScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BatchScheduleError';
  }
}

export const BATCH_GENERATION_SLOTS_REQUIRED_MESSAGE =
  'Batch schedule is required from POST /bot/generate (precomputed slots were not provided).';

export class BatchScheduleCapacityError extends Error {
  readonly code = 'BATCH_SCHEDULE_CAPACITY_EXCEEDED';

  constructor(
    public readonly requestedCount: number,
    public readonly availableCount: number,
    public readonly daysWindow: number,
  ) {
    super(formatBatchScheduleCapacityMessage(requestedCount, availableCount, daysWindow));
    this.name = 'BatchScheduleCapacityError';
  }
}

function formatBatchScheduleCapacityMessage(
  requestedCount: number,
  availableCount: number,
  daysWindow: number,
): string {
  return (
    `Not enough open schedule slots for this batch. You requested ${requestedCount} posts ` +
    `but only ${availableCount} slot${availableCount === 1 ? '' : 's'} are available in the next ` +
    `${daysWindow} days. Try adding more times, selecting more days, increasing duration, or ` +
    `lowering frequency.`
  );
}

const HH_MM_PATTERN = /^(\d{1,2}):(\d{2})$/;

const DEFAULT_SCHEDULE: NormalizedPostingScheduleConfig = {
  timeSlots: ['09:00'],
  days: [1, 2, 3, 4, 5],
  timezone: 'UTC',
};

const DEFAULT_WEEKDAYS = [1, 2, 3, 4, 5];

function isMissing(value: unknown): boolean {
  return value == null || value === '';
}

function parseAndNormalizeTime(value: unknown): string {
  if (typeof value !== 'string') {
    throw new BatchScheduleError('Invalid time format. Use HH:mm (24-hour).');
  }

  const trimmed = value.trim();
  const match = trimmed.match(HH_MM_PATTERN);
  if (!match) {
    throw new BatchScheduleError('Invalid time format. Use HH:mm (24-hour).');
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (hours > 23 || minutes > 59) {
    throw new BatchScheduleError('Invalid time. Hours must be 0-23 and minutes 0-59.');
  }

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function normalizeTime(value: unknown, hasExplicitTime: boolean): string {
  if (!hasExplicitTime || value == null || value === '') {
    return DEFAULT_SCHEDULE.timeSlots[0];
  }
  return parseAndNormalizeTime(value);
}

function normalizeTimeSlots(raw: Record<string, unknown>): string[] {
  const hasTimeSlots = Object.prototype.hasOwnProperty.call(raw, 'timeSlots');
  const hasTime = Object.prototype.hasOwnProperty.call(raw, 'time');

  if (hasTimeSlots) {
    const value = raw.timeSlots;
    if (!Array.isArray(value) || value.length === 0) {
      throw new BatchScheduleError('timeSlots must be a non-empty array of HH:mm times.');
    }
    const normalized = value.map((slot) => parseAndNormalizeTime(slot));
    return [...new Set(normalized)].sort();
  }

  if (hasTime) {
    return [normalizeTime(raw.time, true)];
  }

  return [...DEFAULT_SCHEDULE.timeSlots];
}

function normalizeDays(value: unknown, hasExplicitDays: boolean): number[] {
  if (!hasExplicitDays || value == null) return [...DEFAULT_WEEKDAYS];

  if (!Array.isArray(value)) {
    throw new BatchScheduleError('Days must be an array of weekday numbers (0-6).');
  }

  if (value.length === 0) return [];

  const days = [...new Set(
    value.map((d) => {
      const n = Number(d);
      if (!Number.isInteger(n) || n < 0 || n > 6) {
        throw new BatchScheduleError('Invalid day index. Use 0 (Sunday) through 6 (Saturday).');
      }
      return n;
    }),
  )].sort((a, b) => a - b);

  return days;
}

function normalizeTimezone(value: unknown): string {
  if (value == null || value === '') return DEFAULT_SCHEDULE.timezone;
  if (typeof value !== 'string' || !value.trim()) return DEFAULT_SCHEDULE.timezone;

  const tz = value.trim();
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return tz;
  } catch {
    throw new BatchScheduleError(`Invalid timezone: ${tz}`);
  }
}

function unwrapScheduleInput(value: unknown): Record<string, unknown> | null {
  if (isMissing(value)) return null;

  if (typeof value === 'string') {
    const trimmed = value.trim();

    // Legacy cron strings — fall back to defaults.
    if (trimmed.includes('*')) {
      console.warn('[batch-schedule] Invalid stored postingSchedule, using default');
      return null;
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
      console.warn('[batch-schedule] Invalid stored postingSchedule, using default');
      return null;
    } catch {
      console.warn('[batch-schedule] Invalid stored postingSchedule, using default');
      return null;
    }
  }

  if (typeof value === 'object') return value as Record<string, unknown>;

  console.warn('[batch-schedule] Invalid stored postingSchedule, using default');
  return null;
}

/** For read paths (GET config): never throw; fall back to defaults. */
export function parsePostingScheduleSafe(value: unknown): NormalizedPostingScheduleConfig {
  try {
    return parsePostingSchedule(value);
  } catch {
    console.warn('[batch-schedule] Invalid stored postingSchedule, using default');
    return { ...DEFAULT_SCHEDULE };
  }
}

export function parsePostingSchedule(value: unknown): NormalizedPostingScheduleConfig {
  const raw = unwrapScheduleInput(value);
  if (!raw) return { ...DEFAULT_SCHEDULE };

  const hasExplicitDays = Object.prototype.hasOwnProperty.call(raw, 'days');
  const timeSlots = normalizeTimeSlots(raw);
  const days = normalizeDays(raw.days, hasExplicitDays);

  if (hasExplicitDays && days.length === 0) {
    // Config save: empty selection -> default weekdays.
    return {
      timeSlots,
      days: [...DEFAULT_WEEKDAYS],
      timezone: normalizeTimezone(raw.timezone),
    };
  }

  return {
    timeSlots,
    days: days.length ? days : [...DEFAULT_WEEKDAYS],
    timezone: normalizeTimezone(raw.timezone),
  };
}

export function serializePostingSchedule(input: unknown): string {
  const schedule = parsePostingSchedule(input);
  return JSON.stringify({
    timeSlots: schedule.timeSlots,
    days: schedule.days,
    timezone: schedule.timezone,
  });
}

export function validateScheduleForGeneration(schedule: NormalizedPostingScheduleConfig): void {
  if (!schedule.days.length) {
    throw new BatchScheduleError('Select at least one posting day.');
  }
  if (!schedule.timeSlots.length) {
    throw new BatchScheduleError('Select at least one posting time.');
  }
}

/**
 * Validate a batch generation schedule from the request body.
 * Legacy `{ time: "HH:mm" }` in the payload is still accepted and normalized to `timeSlots`.
 */
export function parseBatchPostingScheduleRequest(value: unknown): NormalizedPostingScheduleConfig {
  if (!value || typeof value !== 'object') {
    throw new BatchScheduleError('batchPostingSchedule must be an object.');
  }

  const raw = value as Record<string, unknown>;

  if (!Array.isArray(raw.days) || raw.days.length === 0) {
    throw new BatchScheduleError('Select at least one posting day.');
  }

  const hasTimeSlots = Array.isArray(raw.timeSlots) && raw.timeSlots.length > 0;
  const hasLegacyTime = typeof raw.time === 'string' && raw.time.trim() !== '';
  if (!hasTimeSlots && !hasLegacyTime) {
    throw new BatchScheduleError('timeSlots must be a non-empty array of HH:mm times.');
  }

  const schedule = parsePostingSchedule(value);
  validateScheduleForGeneration(schedule);
  return schedule;
}

// ---------------------------------------------------------------------------
// Timezone-aware slot building
// ---------------------------------------------------------------------------

function parseTimeParts(time: string): { hour: number; minute: number } {
  const [h, m] = time.split(':').map(Number);
  return { hour: h, minute: m };
}

/** Wall-clock components for a UTC instant in an IANA timezone. */
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
    weekday: get('weekday'),
  };
}

function weekdayIndexFromShort(label: string): number {
  const map: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return map[label] ?? 0;
}

/** Convert a wall-clock time in `timeZone` to a UTC Date. */
function wallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  let candidate = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));

  for (let i = 0; i < 4; i++) {
    const zoned = getZonedParts(candidate, timeZone);
    const desired = Date.UTC(year, month - 1, day, hour, minute, 0);
    const actual = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, 0);
    const diff = desired - actual;
    if (diff === 0) break;
    candidate = new Date(candidate.getTime() + diff);
  }

  return candidate;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Inclusive window end for batch generation (`now` + `daysWindow` days). */
export function scheduleWindowEnd(startDate: Date, daysWindow: number): Date {
  return new Date(startDate.getTime() + daysWindow * MS_PER_DAY);
}

/** Minute-resolution key for comparing generated slots with stored `scheduledAt`. */
export function scheduleSlotTimestampKey(date: Date): number {
  return Math.floor(date.getTime() / 60_000);
}

/** True when two schedule instants refer to the same posting minute. */
export function scheduleSlotsMatch(a: Date, b: Date): boolean {
  return scheduleSlotTimestampKey(a) === scheduleSlotTimestampKey(b);
}

/**
 * All posting slots after `startDate` and on or before `startDate + daysWindow`.
 * For each selected weekday, emits one UTC slot per configured `timeSlots` entry
 * (wall-clock in `schedule.timezone`, sorted chronologically).
 */
export function buildScheduleSlotsWithinWindow(params: {
  startDate?: Date;
  daysWindow: number;
  schedule: NormalizedPostingScheduleConfig;
}): Date[] {
  const { daysWindow, schedule } = params;
  if (daysWindow <= 0) return [];

  validateScheduleForGeneration(schedule);

  const startDate = params.startDate ?? new Date();
  const windowEnd = scheduleWindowEnd(startDate, daysWindow);
  const allowed = new Set(schedule.days);
  const sortedTimeSlots = [...schedule.timeSlots].sort();
  const timeParts = sortedTimeSlots.map((time) => parseTimeParts(time));
  const slots: Date[] = [];

  const anchor = getZonedParts(startDate, schedule.timezone);
  let cursorYear = anchor.year;
  let cursorMonth = anchor.month;
  let cursorDay = anchor.day;

  for (let i = 0; i <= daysWindow; i++) {
    const probe = wallClockToUtc(cursorYear, cursorMonth, cursorDay, 12, 0, schedule.timezone);
    const parts = getZonedParts(probe, schedule.timezone);
    const dow = weekdayIndexFromShort(parts.weekday);

    if (allowed.has(dow)) {
      for (const { hour, minute } of timeParts) {
        const slot = wallClockToUtc(
          cursorYear,
          cursorMonth,
          cursorDay,
          hour,
          minute,
          schedule.timezone,
        );
        if (slot.getTime() > startDate.getTime() && slot.getTime() <= windowEnd.getTime()) {
          slots.push(slot);
        }
      }
    }

    const nextNoon = wallClockToUtc(
      cursorYear,
      cursorMonth,
      cursorDay + 1,
      12,
      0,
      schedule.timezone,
    );
    const nextParts = getZonedParts(nextNoon, schedule.timezone);
    cursorYear = nextParts.year;
    cursorMonth = nextParts.month;
    cursorDay = nextParts.day;
  }

  return slots;
}

/** Candidate slots within the window with occupied REVIEW/QUEUED times removed. */
export function resolveAvailableScheduleSlots(params: {
  startDate?: Date;
  daysWindow: number;
  schedule: NormalizedPostingScheduleConfig;
  occupiedScheduledAt: Date[];
}): Date[] {
  const candidateSlots = buildScheduleSlotsWithinWindow({
    startDate: params.startDate,
    daysWindow: params.daysWindow,
    schedule: params.schedule,
  });

  return excludeOccupiedScheduleSlots(candidateSlots, params.occupiedScheduledAt);
}

/** Remove candidate slots already reserved by REVIEW/QUEUED posts. */
export function excludeOccupiedScheduleSlots(
  candidateSlots: Date[],
  occupiedScheduledAt: Date[],
): Date[] {
  if (!occupiedScheduledAt.length) return [...candidateSlots];

  const occupiedKeys = new Set(
    occupiedScheduledAt.map((scheduledAt) => scheduleSlotTimestampKey(scheduledAt)),
  );

  return candidateSlots.filter((slot) => !occupiedKeys.has(scheduleSlotTimestampKey(slot)));
}

/**
 * Build up to `count` future posting slots within `daysWindow` on allowed weekdays
 * at each configured time (chronological order).
 */
export function buildBatchScheduleSlots(params: {
  startDate?: Date;
  count: number;
  daysWindow: number;
  schedule: NormalizedPostingScheduleConfig;
}): Date[] {
  const { count, daysWindow } = params;
  if (count <= 0) return [];

  return buildScheduleSlotsWithinWindow({
    startDate: params.startDate,
    daysWindow,
    schedule: params.schedule,
  }).slice(0, count);
}

/** Same slot count formula used by the previous calculateTimeSlots helper. */
export function calculateBatchSlotCount(postsPerWeek: number, daysWindow: number): number {
  return Math.max(1, Math.ceil((postsPerWeek / 7) * daysWindow));
}
