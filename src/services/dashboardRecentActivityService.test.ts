import assert from 'node:assert/strict';
import test from 'node:test';
import { getRecentDashboardActivity } from './dashboardRecentActivityService';

test('combines real user activity sources newest-first and scopes every query', async () => {
  const captured: any[] = [];
  const db = {
    post: {
      findMany: async (args: any) => {
        captured.push(args);
        if (args.where.status === 'PUBLISHED') {
          return [{
            id: 'post-1',
            content: 'Published content',
            publishedAt: new Date('2026-07-08T12:00:00.000Z'),
          }];
        }
        return [{
          id: 'post-2',
          content: 'Scheduled content',
          scheduledAt: new Date('2026-07-10T12:00:00.000Z'),
          updatedAt: new Date('2026-07-07T12:00:00.000Z'),
        }];
      },
    },
    botGenerationJob: {
      findMany: async (args: any) => {
        captured.push(args);
        return [{
          id: 'batch-1',
          status: 'FAILED',
          createdAt: new Date('2026-07-06T12:00:00.000Z'),
          completedSlots: 2,
          totalSlots: 5,
        }];
      },
    },
    imageGenerationUsage: {
      findMany: async (args: any) => {
        captured.push(args);
        return [{ id: 'image-1', createdAt: new Date('2026-07-09T12:00:00.000Z') }];
      },
    },
    manualAiRewriteUsage: {
      findMany: async (args: any) => {
        captured.push(args);
        return [{
          id: 'manual-1',
          kind: 'rewrite_unsaved',
          createdAt: new Date('2026-07-05T12:00:00.000Z'),
        }];
      },
    },
  } as any;

  const activities = await getRecentDashboardActivity('user-1', db);

  assert.equal(activities.length, 5);
  assert.deepEqual(
    activities.map((activity) => activity.type),
    [
      'IMAGE_GENERATED',
      'POST_PUBLISHED',
      'POST_SCHEDULED',
      'BATCH_GENERATION',
      'MANUAL_AI_OPERATION',
    ],
  );
  assert.equal(activities[4].title, 'Manual AI rewrite used');
  assert.ok(captured.every((query) => query.where.userId === 'user-1'));
  assert.ok(captured.every((query) => query.take === 8));
});

test('limits the merged activity feed to eight items', async () => {
  const manualRows = Array.from({ length: 10 }, (_, index) => ({
    id: `manual-${index}`,
    kind: 'generate',
    createdAt: new Date(Date.UTC(2026, 6, 20, 0, 0, index)),
  }));
  const db = {
    post: { findMany: async () => [] },
    botGenerationJob: { findMany: async () => [] },
    imageGenerationUsage: { findMany: async () => [] },
    manualAiRewriteUsage: { findMany: async () => manualRows },
  } as any;

  const activities = await getRecentDashboardActivity('user-1', db);

  assert.equal(activities.length, 8);
  assert.equal(activities[0].id, 'manual-ai-manual-9');
});
