import { prisma } from '../prismaClient';
import {
  BatchScheduleError,
  NormalizedPostingScheduleConfig,
  calculateBatchSlotCount,
  resolveAvailableScheduleSlots,
  scheduleWindowEnd,
  validateScheduleForGeneration,
  resolveBatchStartDate,
  selectBatchGenerationSlots,
} from './batchScheduleService';

export type ResolvedBatchGenerationSlots = {
  requestedCount: number;
  availableCount: number;
  slots: Date[];
};

/**
 * Resolve open schedule slots for a batch generation request.
 * Throws {@link BatchScheduleCapacityError} when capacity is insufficient,
 * unless a confirmed request explicitly allows a partial batch.
 */
export async function resolveBatchGenerationSlots(params: {
  userId: string;
  postsPerWeek: number;
  daysWindow: number;
  startDate: unknown;
  schedule: NormalizedPostingScheduleConfig;
  allowPartialSchedule?: boolean;
  selectedSlotKeys?: string[];
  now?: Date;
}): Promise<ResolvedBatchGenerationSlots> {
  const now = params.now ?? new Date();
  const { userId, postsPerWeek, daysWindow, schedule } = params;

  const startDate = resolveBatchStartDate(params.startDate, schedule.timezone, now);

  validateScheduleForGeneration(schedule);

  const requestedCount = calculateBatchSlotCount(postsPerWeek, daysWindow);
  const windowEnd = scheduleWindowEnd(startDate, daysWindow);

  const occupiedPosts = await prisma.post.findMany({
    where: {
      userId,
      status: { in: ['REVIEW', 'QUEUED'] },
      scheduledAt: {
        not: null,
        gt: startDate,
        lte: windowEnd,
      },
    },
    select: { scheduledAt: true },
  });

  const occupiedScheduledAt = occupiedPosts
    .map((post) => post.scheduledAt)
    .filter((scheduledAt): scheduledAt is Date => scheduledAt instanceof Date);

  const availableSlots = resolveAvailableScheduleSlots({
    startDate,
    daysWindow,
    schedule,
    occupiedScheduledAt,
  });

  let selectedSlots: Date[];
  if (params.selectedSlotKeys?.length) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: schedule.timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    const keyFor = (date: Date) => {
      const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
      return `${parts.year}-${parts.month}-${parts.day}|${parts.hour}:${parts.minute}`;
    };
    const availableByKey = new Map(availableSlots.map((slot) => [keyFor(slot), slot]));
    const requestedKeys = params.selectedSlotKeys;
    if (requestedKeys.length !== requestedCount && !params.allowPartialSchedule) {
      throw new BatchScheduleError(`Select a time slot for all ${requestedCount} posts.`);
    }
    selectedSlots = requestedKeys.map((key) => {
      const slot = availableByKey.get(key);
      if (!slot) throw new BatchScheduleError(`Selected time slot ${key} is no longer available.`);
      return slot;
    });
  } else {
    selectedSlots = selectBatchGenerationSlots(
      availableSlots,
      requestedCount,
      daysWindow,
      params.allowPartialSchedule,
    );
  }

  return {
    requestedCount,
    availableCount: availableSlots.length,
    slots: selectedSlots,
  };
}
