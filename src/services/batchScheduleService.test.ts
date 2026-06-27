import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BatchScheduleCapacityError,
  BatchScheduleError,
  buildBatchScheduleSlots,
  buildScheduleSlotsWithinWindow,
  calculateBatchSlotCount,
  excludeOccupiedScheduleSlots,
  parsePostingSchedule,
  resolveAvailableScheduleSlots,
  resolveBatchStartDate,
  scheduleSlotsMatch,
  scheduleWindowEnd,
  serializePostingSchedule,
} from './batchScheduleService';

describe('resolveBatchStartDate', () => {
  const now = new Date('2026-06-27T08:00:00.000Z');

  it('uses midnight in the posting timezone for a future date', () => {
    assert.equal(
      resolveBatchStartDate('2026-07-01', 'Asia/Karachi', now).toISOString(),
      '2026-06-30T19:00:00.000Z',
    );
  });

  it('uses the current instant when today is selected', () => {
    assert.equal(
      resolveBatchStartDate('2026-06-27', 'Asia/Karachi', now).toISOString(),
      now.toISOString(),
    );
  });

  it('rejects past and invalid dates', () => {
    assert.throws(
      () => resolveBatchStartDate('2026-06-26', 'Asia/Karachi', now),
      BatchScheduleError,
    );
    assert.throws(
      () => resolveBatchStartDate('2026-02-30', 'Asia/Karachi', now),
      BatchScheduleError,
    );
  });
});

describe('parsePostingSchedule', () => {
  it('normalizes legacy time to timeSlots', () => {
    const schedule = parsePostingSchedule({
      time: '9:30',
      days: [1, 3, 5],
      timezone: 'UTC',
    });

    assert.deepEqual(schedule.timeSlots, ['09:30']);
    assert.deepEqual(schedule.days, [1, 3, 5]);
    assert.equal(schedule.timezone, 'UTC');
  });

  it('accepts and sorts multiple timeSlots', () => {
    const schedule = parsePostingSchedule({
      timeSlots: ['17:00', '09:00', '13:00'],
      days: [1, 2, 3, 4, 5],
      timezone: 'America/New_York',
    });

    assert.deepEqual(schedule.timeSlots, ['09:00', '13:00', '17:00']);
  });

  it('rejects empty timeSlots', () => {
    assert.throws(
      () => parsePostingSchedule({ timeSlots: [], days: [1] }),
      (err: unknown) => err instanceof BatchScheduleError,
    );
  });

  it('serializes to the new shape', () => {
    const serialized = serializePostingSchedule({
      time: '08:15',
      days: [2, 4],
      timezone: 'UTC',
    });

    assert.deepEqual(JSON.parse(serialized), {
      timeSlots: ['08:15'],
      days: [2, 4],
      timezone: 'UTC',
    });
  });
});

describe('buildBatchScheduleSlots', () => {
  it('emits multiple slots per eligible day in chronological order', () => {
    const startDate = new Date('2026-06-10T00:00:00.000Z');
    const slots = buildBatchScheduleSlots({
      startDate,
      count: 4,
      daysWindow: 14,
      schedule: {
        timeSlots: ['09:00', '17:00'],
        days: [3],
        timezone: 'UTC',
      },
    });

    assert.equal(slots.length, 4);
    assert.ok(slots[0] < slots[1]);
    assert.ok(slots[1] < slots[2]);
    assert.ok(slots[2] < slots[3]);
    assert.equal(slots[0].toISOString(), '2026-06-10T09:00:00.000Z');
    assert.equal(slots[1].toISOString(), '2026-06-10T17:00:00.000Z');
    assert.equal(slots[2].toISOString(), '2026-06-17T09:00:00.000Z');
    assert.equal(slots[3].toISOString(), '2026-06-17T17:00:00.000Z');
  });

  it('skips slots at or before startDate', () => {
    const startDate = new Date('2026-06-10T10:00:00.000Z');
    const slots = buildBatchScheduleSlots({
      startDate,
      count: 2,
      daysWindow: 14,
      schedule: {
        timeSlots: ['09:00', '17:00'],
        days: [3],
        timezone: 'UTC',
      },
    });

    assert.equal(slots[0].toISOString(), '2026-06-10T17:00:00.000Z');
    assert.equal(slots[1].toISOString(), '2026-06-17T09:00:00.000Z');
  });
});

describe('buildScheduleSlotsWithinWindow', () => {
  it('does not return slots beyond the selected duration', () => {
    const startDate = new Date('2026-06-10T00:00:00.000Z');
    const daysWindow = 7;
    const windowEnd = scheduleWindowEnd(startDate, daysWindow);
    const slots = buildScheduleSlotsWithinWindow({
      startDate,
      daysWindow,
      schedule: {
        timeSlots: ['09:00', '17:00'],
        days: [1, 2, 3, 4, 5],
        timezone: 'UTC',
      },
    });

    assert.ok(slots.length > 0);
    for (const slot of slots) {
      assert.ok(slot.getTime() > startDate.getTime());
      assert.ok(slot.getTime() <= windowEnd.getTime());
    }
    assert.equal(windowEnd.toISOString(), '2026-06-17T00:00:00.000Z');
  });

  it('emits three slots per weekday in Asia/Karachi wall-clock time', () => {
    const startDate = new Date('2026-06-09T03:30:00.000Z'); // 08:30 PKT on Tuesday
    const schedule = {
      timeSlots: ['09:00', '13:00', '17:00'],
      days: [1, 2, 3, 4, 5],
      timezone: 'Asia/Karachi',
    };

    const slots = buildScheduleSlotsWithinWindow({
      startDate,
      daysWindow: 1,
      schedule,
    });

    assert.deepEqual(
      slots.map((slot) => slot.toISOString()),
      [
        '2026-06-09T04:00:00.000Z', // 09:00 PKT
        '2026-06-09T08:00:00.000Z', // 13:00 PKT
        '2026-06-09T12:00:00.000Z', // 17:00 PKT
      ],
    );
  });
});

describe('resolveAvailableScheduleSlots', () => {
  it('removes occupied review/queued slots from candidates', () => {
    const startDate = new Date('2026-06-10T00:00:00.000Z');
    const schedule = {
      timeSlots: ['09:00', '13:00', '17:00'],
      days: [2, 3, 4, 5, 6],
      timezone: 'UTC',
    };

    const available = resolveAvailableScheduleSlots({
      startDate,
      daysWindow: 2,
      schedule,
      occupiedScheduledAt: [new Date('2026-06-10T09:00:00.000Z')],
    });

    assert.ok(
      available.every((slot) => !scheduleSlotsMatch(slot, new Date('2026-06-10T09:00:00.000Z'))),
    );
    assert.equal(available[0].toISOString(), '2026-06-10T13:00:00.000Z');
  });

  it('fails capacity check when occupied slots reduce availability below requested count', () => {
    const startDate = new Date('2026-06-10T00:00:00.000Z');
    const schedule = {
      timeSlots: ['09:00', '17:00'],
      days: [3],
      timezone: 'UTC',
    };
    const daysWindow = 7;
    const requestedCount = calculateBatchSlotCount(7, daysWindow);

    const available = resolveAvailableScheduleSlots({
      startDate,
      daysWindow,
      schedule,
      occupiedScheduledAt: [
        new Date('2026-06-10T09:00:00.000Z'),
        new Date('2026-06-10T17:00:00.000Z'),
        new Date('2026-06-17T09:00:00.000Z'),
      ],
    });

    assert.ok(available.length < requestedCount);
  });
});

describe('excludeOccupiedScheduleSlots', () => {
  it('removes candidate slots that match occupied scheduledAt values', () => {
    const candidates = [
      new Date('2026-06-10T09:00:00.000Z'),
      new Date('2026-06-10T17:00:00.000Z'),
      new Date('2026-06-11T09:00:00.000Z'),
    ];

    const available = excludeOccupiedScheduleSlots(candidates, [
      new Date('2026-06-10T09:00:00.000Z'),
    ]);

    assert.deepEqual(
      available.map((slot) => slot.toISOString()),
      ['2026-06-10T17:00:00.000Z', '2026-06-11T09:00:00.000Z'],
    );
  });
});

describe('BatchScheduleCapacityError', () => {
  it('includes requested and available counts in the message', () => {
    const err = new BatchScheduleCapacityError(10, 4, 7);
    assert.equal(err.code, 'BATCH_SCHEDULE_CAPACITY_EXCEEDED');
    assert.match(err.message, /requested 10 posts/i);
    assert.match(err.message, /only 4 slots/i);
    assert.match(err.message, /next 7 days/i);
    assert.match(err.message, /adding more times/i);
    assert.match(err.message, /lowering frequency/i);
  });
});
