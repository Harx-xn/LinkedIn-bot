/**
 * Batch posting schedule helpers for Trending Bot generation.
 *
 * `BotConfig.postingSchedule` stores JSON:
 *   { time: "HH:mm", days: [0-6], timezone?: "IANA/Zone" }
 *
 * Day indices: 0 = Sunday, 1 = Monday, ... 6 = Saturday.
 *
 * Timezone conversion uses Intl (no extra dependencies). `scheduledAt` is
 * stored as a UTC Date for Prisma; the cron publisher compares against `now`.
 */

export type PostingScheduleConfig = {
  time: string;
  days: number[];
  timezone?: string;
};

export type NormalizedPostingScheduleConfig = {
  time: string;
  days: number[];
  timezone: string;
};

export class BatchScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BatchScheduleError';
  }
}

const DEFAULT_SCHEDULE: NormalizedPostingScheduleConfig = {
  time: '09:00',
  days: [1, 2, 3, 4, 5],
  timezone: 'UTC',
};

const DEFAULT_WEEKDAYS = [1, 2, 3, 4, 5];

function isMissing(value: unknown): boolean {
  return value == null || value === '';
}

function normalizeTime(value: unknown, hasExplicitTime: boolean): string {
  if (!hasExplicitTime || value == null || value === '') return DEFAULT_SCHEDULE.time;

  if (typeof value !== 'string') {
    throw new BatchScheduleError('Invalid time format. Use HH:mm (24-hour).');
  }

  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{1,2}):(\d{2})$/);
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

  const hasExplicitTime = Object.prototype.hasOwnProperty.call(raw, 'time');
  const hasExplicitDays = Object.prototype.hasOwnProperty.call(raw, 'days');

  const days = normalizeDays(raw.days, hasExplicitDays);
  if (hasExplicitDays && days.length === 0) {
    // Config save: empty selection -> default weekdays.
    return {
      time: normalizeTime(raw.time, hasExplicitTime),
      days: [...DEFAULT_WEEKDAYS],
      timezone: normalizeTimezone(raw.timezone),
    };
  }

  return {
    time: normalizeTime(raw.time, hasExplicitTime),
    days: days.length ? days : [...DEFAULT_WEEKDAYS],
    timezone: normalizeTimezone(raw.timezone),
  };
}

export function serializePostingSchedule(input: unknown): string {
  return JSON.stringify(parsePostingSchedule(input));
}

export function validateScheduleForGeneration(schedule: NormalizedPostingScheduleConfig): void {
  if (!schedule.days.length) {
    throw new BatchScheduleError('Select at least one posting day.');
  }
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

/**
 * Build exactly `count` future posting slots on allowed weekdays at `schedule.time`.
 */
export function buildBatchScheduleSlots(params: {
  startDate?: Date;
  count: number;
  schedule: NormalizedPostingScheduleConfig;
}): Date[] {
  const { count, schedule } = params;
  if (count <= 0) return [];

  validateScheduleForGeneration(schedule);

  const startDate = params.startDate ?? new Date();
  const { hour, minute } = parseTimeParts(schedule.time);
  const allowed = new Set(schedule.days);
  const slots: Date[] = [];

  const anchor = getZonedParts(startDate, schedule.timezone);
  let cursorYear = anchor.year;
  let cursorMonth = anchor.month;
  let cursorDay = anchor.day;

  const maxDays = Math.max(count * 14, 90);

  for (let i = 0; i < maxDays && slots.length < count; i++) {
    const probe = wallClockToUtc(cursorYear, cursorMonth, cursorDay, 12, 0, schedule.timezone);
    const parts = getZonedParts(probe, schedule.timezone);
    const dow = weekdayIndexFromShort(parts.weekday);

    if (allowed.has(dow)) {
      const slot = wallClockToUtc(cursorYear, cursorMonth, cursorDay, hour, minute, schedule.timezone);
      if (slot.getTime() > startDate.getTime()) {
        slots.push(slot);
      }
    }

    // Advance one calendar day in the schedule timezone.
    const nextNoon = wallClockToUtc(cursorYear, cursorMonth, cursorDay + 1, 12, 0, schedule.timezone);
    const nextParts = getZonedParts(nextNoon, schedule.timezone);
    cursorYear = nextParts.year;
    cursorMonth = nextParts.month;
    cursorDay = nextParts.day;
  }

  return slots;
}

/** Same slot count formula used by the previous calculateTimeSlots helper. */
export function calculateBatchSlotCount(postsPerWeek: number, daysWindow: number): number {
  return Math.max(1, Math.ceil((postsPerWeek / 7) * daysWindow));
}
