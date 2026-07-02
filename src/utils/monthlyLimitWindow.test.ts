import assert from 'node:assert/strict';
import test from 'node:test';
import { getUtcMonthWindow } from './monthlyLimitWindow';

test('returns UTC calendar-month boundaries regardless of input offset', () => {
  const window = getUtcMonthWindow(new Date('2026-07-31T23:30:00-07:00'));

  assert.equal(window.start.toISOString(), '2026-08-01T00:00:00.000Z');
  assert.equal(window.end.toISOString(), '2026-09-01T00:00:00.000Z');
});

test('rolls December into January of the next year', () => {
  const window = getUtcMonthWindow(new Date('2026-12-15T12:00:00.000Z'));

  assert.equal(window.start.toISOString(), '2026-12-01T00:00:00.000Z');
  assert.equal(window.end.toISOString(), '2027-01-01T00:00:00.000Z');
});

test('starts at the first UTC millisecond and ends at the next month boundary', () => {
  const window = getUtcMonthWindow(new Date('2026-04-19T08:45:12.345Z'));

  assert.equal(window.start.toISOString(), '2026-04-01T00:00:00.000Z');
  assert.equal(window.end.toISOString(), '2026-05-01T00:00:00.000Z');
});

test('handles leap-year February', () => {
  const window = getUtcMonthWindow(new Date('2028-02-29T23:59:59.999Z'));

  assert.equal(window.start.toISOString(), '2028-02-01T00:00:00.000Z');
  assert.equal(window.end.toISOString(), '2028-03-01T00:00:00.000Z');
});
