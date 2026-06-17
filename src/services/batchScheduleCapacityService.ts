import { prisma } from '../prismaClient';
import {
  BatchScheduleCapacityError,
  NormalizedPostingScheduleConfig,
  calculateBatchSlotCount,
  resolveAvailableScheduleSlots,
  scheduleWindowEnd,
  validateScheduleForGeneration,
} from './batchScheduleService';

export type ResolvedBatchGenerationSlots = {
  requestedCount: number;
  availableCount: number;
  slots: Date[];
};

/**
 * Resolve open schedule slots for a batch generation request.
 * Throws {@link BatchScheduleCapacityError} when capacity is insufficient.
 */
export async function resolveBatchGenerationSlots(params: {
  userId: string;
  postsPerWeek: number;
  daysWindow: number;
  schedule: NormalizedPostingScheduleConfig;
  now?: Date;
}): Promise<ResolvedBatchGenerationSlots> {
  const now = params.now ?? new Date();
  const { userId, postsPerWeek, daysWindow, schedule } = params;

  validateScheduleForGeneration(schedule);

  const requestedCount = calculateBatchSlotCount(postsPerWeek, daysWindow);
  const windowEnd = scheduleWindowEnd(now, daysWindow);

  const occupiedPosts = await prisma.post.findMany({
    where: {
      userId,
      status: { in: ['REVIEW', 'QUEUED'] },
      scheduledAt: {
        not: null,
        gt: now,
        lte: windowEnd,
      },
    },
    select: { scheduledAt: true },
  });

  const occupiedScheduledAt = occupiedPosts
    .map((post) => post.scheduledAt)
    .filter((scheduledAt): scheduledAt is Date => scheduledAt instanceof Date);

  const availableSlots = resolveAvailableScheduleSlots({
    startDate: now,
    daysWindow,
    schedule,
    occupiedScheduledAt,
  });

  if (availableSlots.length < requestedCount) {
    throw new BatchScheduleCapacityError(
      requestedCount,
      availableSlots.length,
      daysWindow,
    );
  }

  return {
    requestedCount,
    availableCount: availableSlots.length,
    slots: availableSlots.slice(0, requestedCount),
  };
}
