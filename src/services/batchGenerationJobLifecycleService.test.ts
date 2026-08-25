import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BATCH_JOB_INTERRUPTED_ERROR,
  isRunningBatchJobStale,
  reconcileStaleBatchGenerationJob,
  reconcileStaleBatchGenerationJobs,
  startBatchGenerationHeartbeat,
} from './batchGenerationJobLifecycleService';

const now = new Date('2026-08-25T12:00:00.000Z');

test('a running job is stale when its heartbeat lease has expired', () => {
  assert.equal(isRunningBatchJobStale({
    status: 'RUNNING',
    createdAt: new Date('2026-08-25T11:00:00.000Z'),
    heartbeatAt: new Date('2026-08-25T11:57:59.000Z'),
  }, now), true);

  assert.equal(isRunningBatchJobStale({
    status: 'RUNNING',
    createdAt: new Date('2026-08-25T11:00:00.000Z'),
    heartbeatAt: new Date('2026-08-25T11:59:00.000Z'),
  }, now), false);
});

test('legacy running jobs without a heartbeat fall back to their creation time', () => {
  assert.equal(isRunningBatchJobStale({
    status: 'RUNNING',
    createdAt: new Date('2026-08-25T11:57:00.000Z'),
    heartbeatAt: null,
  }, now), true);
});

test('terminal jobs are never treated as stale', () => {
  assert.equal(isRunningBatchJobStale({
    status: 'DONE',
    createdAt: new Date('2026-08-25T10:00:00.000Z'),
    heartbeatAt: null,
  }, now), false);
});

test('global reconciliation atomically fails only expired running jobs', async () => {
  let updateArgs: any;
  const count = await reconcileStaleBatchGenerationJobs({
    now,
    store: {
      updateMany: async (args) => {
        updateArgs = args;
        return { count: 2 };
      },
    },
  });

  assert.equal(count, 2);
  assert.equal(updateArgs.where.status, 'RUNNING');
  assert.equal(updateArgs.where.OR[0].heartbeatAt.lte.toISOString(), '2026-08-25T11:58:00.000Z');
  assert.equal(updateArgs.data.status, 'FAILED');
  assert.equal(updateArgs.data.error, BATCH_JOB_INTERRUPTED_ERROR);
  assert.equal(updateArgs.data.completedAt, now);
});

test('status reconciliation is scoped to both job and authenticated user', async () => {
  let updateArgs: any;
  const changed = await reconcileStaleBatchGenerationJob({
    jobId: 'job-1',
    userId: 'user-1',
    now,
    store: {
      updateMany: async (args) => {
        updateArgs = args;
        return { count: 1 };
      },
    },
  });

  assert.equal(changed, true);
  assert.equal(updateArgs.where.id, 'job-1');
  assert.equal(updateArgs.where.userId, 'user-1');
  assert.equal(updateArgs.where.status, 'RUNNING');
});

test('heartbeat refreshes only a running job and stops cleanly', async () => {
  const updates: any[] = [];
  const stop = startBatchGenerationHeartbeat('job-1', {
    intervalMs: 5,
    store: {
      updateMany: async (args) => {
        updates.push(args);
        return { count: 1 };
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 18));
  stop();
  const updatesAtStop = updates.length;
  await new Promise((resolve) => setTimeout(resolve, 12));

  assert.ok(updatesAtStop >= 2);
  assert.equal(updates.length, updatesAtStop);
  assert.deepEqual(updates[0].where, { id: 'job-1', status: 'RUNNING' });
  assert.ok(updates[0].data.heartbeatAt instanceof Date);
});
