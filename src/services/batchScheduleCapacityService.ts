import { prisma } from '../prismaClient';
import {
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

  const selectedSlots = selectBatchGenerationSlots(
    availableSlots,
    requestedCount,
    daysWindow,
    params.allowPartialSchedule,
  );

  return {
    requestedCount,
    availableCount: availableSlots.length,
    slots: selectedSlots,
  };
}
