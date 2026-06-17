import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CalendarMonthError,
  getCalendarDayUtcRange,
  getCalendarMonthUtcRange,
  parseCalendarDate,
  parseCalendarMonth,
  validateIanaTimezone,
} from './calendarMonthService';

describe('parseCalendarMonth', () => {
  it('accepts YYYY-MM', () => {
    assert.deepEqual(parseCalendarMonth('2026-06'), {
      year: 2026,
      month: 6,
      monthKey: '2026-06',
    });
  });

  it('rejects invalid month strings', () => {
    assert.throws(
      () => parseCalendarMonth('2026-13'),
      (err: unknown) => err instanceof CalendarMonthError,
    );
    assert.throws(
      () => parseCalendarMonth('06-2026'),
      (err: unknown) => err instanceof CalendarMonthError,
    );
  });
});

describe('validateIanaTimezone', () => {
  it('accepts Asia/Karachi', () => {
    assert.equal(validateIanaTimezone('Asia/Karachi'), 'Asia/Karachi');
  });

  it('rejects invalid timezone names', () => {
    assert.throws(
      () => validateIanaTimezone('Not/A_Timezone'),
      (err: unknown) => err instanceof CalendarMonthError,
    );
  });
});

describe('getCalendarMonthUtcRange', () => {
  it('uses timezone-local month boundaries converted to UTC', () => {
    const range = getCalendarMonthUtcRange({
      month: '2026-06',
      timezone: 'Asia/Karachi',
    });

    assert.equal(range.month, '2026-06');
    assert.equal(range.timezone, 'Asia/Karachi');
    assert.equal(range.startUtc.toISOString(), '2026-05-31T19:00:00.000Z');
    assert.equal(range.endUtcExclusive.toISOString(), '2026-06-30T19:00:00.000Z');
  });
});

describe('parseCalendarDate', () => {
  it('accepts YYYY-MM-DD', () => {
    assert.deepEqual(parseCalendarDate('2026-06-17'), {
      year: 2026,
      month: 6,
      day: 17,
      dateKey: '2026-06-17',
    });
  });

  it('rejects invalid calendar dates', () => {
    assert.throws(
      () => parseCalendarDate('2026-02-31'),
      (err: unknown) => err instanceof CalendarMonthError,
    );
  });
});

describe('getCalendarDayUtcRange', () => {
  it('uses timezone-local day boundaries converted to UTC', () => {
    const range = getCalendarDayUtcRange({
      date: '2026-06-17',
      timezone: 'Asia/Karachi',
    });

    assert.equal(range.date, '2026-06-17');
    assert.equal(range.timezone, 'Asia/Karachi');
    assert.equal(range.startUtc.toISOString(), '2026-06-16T19:00:00.000Z');
    assert.equal(range.endUtcExclusive.toISOString(), '2026-06-17T19:00:00.000Z');
  });
});
