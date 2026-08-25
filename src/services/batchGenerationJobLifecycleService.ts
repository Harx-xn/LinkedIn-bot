import { prisma } from '../prismaClient';

export const BATCH_JOB_HEARTBEAT_INTERVAL_MS = 15_000;
export const BATCH_JOB_STALE_AFTER_MS = 2 * 60_000;
export const BATCH_JOB_INTERRUPTED_ERROR =
  'Batch generation was interrupted because the server or generation worker stopped unexpectedly. Any posts completed before the interruption were kept.';

type BatchJobStore = {
  updateMany(args: any): Promise<{ count: number }>;
};

type RunningBatchJob = {
  status: string;
  createdAt: Date;
  heartbeatAt: Date | null;
};

function defaultStore(): BatchJobStore {
  return prisma.botGenerationJob;
}

export function isRunningBatchJobStale(
  job: RunningBatchJob,
  now = new Date(),
  staleAfterMs = BATCH_JOB_STALE_AFTER_MS,
): boolean {
  if (job.status !== 'RUNNING') return false;
  const lastWorkerContact = job.heartbeatAt ?? job.createdAt;
  return now.getTime() - lastWorkerContact.getTime() >= staleAfterMs;
}

function staleRunningWhere(now: Date, staleAfterMs: number) {
  const cutoff = new Date(now.getTime() - staleAfterMs);
  return {
    status: 'RUNNING',
    OR: [
      { heartbeatAt: { lte: cutoff } },
      { heartbeatAt: null, createdAt: { lte: cutoff } },
    ],
  };
}

export async function reconcileStaleBatchGenerationJobs(options: {
  now?: Date;
  staleAfterMs?: number;
  store?: BatchJobStore;
} = {}): Promise<number> {
  const now = options.now ?? new Date();
  const result = await (options.store ?? defaultStore()).updateMany({
    where: staleRunningWhere(now, options.staleAfterMs ?? BATCH_JOB_STALE_AFTER_MS),
    data: {
      status: 'FAILED',
      completedAt: now,
      error: BATCH_JOB_INTERRUPTED_ERROR,
    },
  });
  return result.count;
}

export async function reconcileStaleBatchGenerationJob(options: {
  jobId: string;
  userId: string;
  now?: Date;
  staleAfterMs?: number;
  store?: BatchJobStore;
}): Promise<boolean> {
  const now = options.now ?? new Date();
  const result = await (options.store ?? defaultStore()).updateMany({
    where: {
      id: options.jobId,
      userId: options.userId,
      ...staleRunningWhere(now, options.staleAfterMs ?? BATCH_JOB_STALE_AFTER_MS),
    },
    data: {
      status: 'FAILED',
      completedAt: now,
      error: BATCH_JOB_INTERRUPTED_ERROR,
    },
  });
  return result.count > 0;
}

export function startBatchGenerationHeartbeat(
  jobId: string,
  options: {
    intervalMs?: number;
    store?: BatchJobStore;
    onError?: (error: unknown) => void;
  } = {},
): () => void {
  const store = options.store ?? defaultStore();
  const onError = options.onError ?? ((error) => {
    console.error('[batch-job] heartbeat update failed', { jobId, error });
  });

  const refresh = () => {
    void store.updateMany({
      where: { id: jobId, status: 'RUNNING' },
      data: { heartbeatAt: new Date() },
    }).catch(onError);
  };

  refresh();
  const timer = setInterval(
    refresh,
    options.intervalMs ?? BATCH_JOB_HEARTBEAT_INTERVAL_MS,
  );
  timer.unref?.();

  return () => clearInterval(timer);
}
