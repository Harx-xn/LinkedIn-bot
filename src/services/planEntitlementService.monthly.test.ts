import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { getUtcMonthWindow } from '../utils/monthlyLimitWindow';
import { getMonthlyEntitlementUsage, getMonthlyLimits } from './planEntitlementService';

type TimestampRow = { createdAt?: Date; publishedAt?: Date };

function fakeCounter(
  rows: TimestampRow[],
  field: 'createdAt' | 'publishedAt',
  captured: Record<string, any>,
  key: string,
) {
  return async (args: any) => {
    captured[key] = args.where;
    const range = args.where[field] as { gte: Date; lt: Date };
    return rows.filter((row) => {
      const value = row[field];
      return value && value >= range.gte && value < range.lt;
    }).length;
  };
}

test('all monthly usage stores use inclusive-start exclusive-end UTC boundaries', async () => {
  const now = new Date('2026-08-18T09:30:00.000Z');
  const { start, end } = getUtcMonthWindow(now);
  const beforeStart = new Date(start.getTime() - 1);
  const inside = new Date(start.getTime() + 123_456);
  const captured: Record<string, any> = {};

  const db = {
    post: {
      count: fakeCounter([
        { createdAt: inside, publishedAt: beforeStart },
        { createdAt: beforeStart, publishedAt: start },
        { createdAt: beforeStart, publishedAt: inside },
        { createdAt: inside, publishedAt: end },
      ], 'publishedAt', captured, 'posts'),
    },
    botGenerationJob: {
      count: fakeCounter(
        [{ createdAt: beforeStart }, { createdAt: start }, { createdAt: inside }, { createdAt: end }],
        'createdAt', captured, 'batch',
      ),
    },
    imageGenerationUsage: {
      count: fakeCounter(
        [{ createdAt: beforeStart }, { createdAt: start }, { createdAt: inside }, { createdAt: end }],
        'createdAt', captured, 'images',
      ),
    },
    manualAiRewriteUsage: {
      count: fakeCounter(
        [{ createdAt: beforeStart }, { createdAt: start }, { createdAt: inside }, { createdAt: end }],
        'createdAt', captured, 'manual',
      ),
    },
  } as any;

  const usage = await getMonthlyEntitlementUsage('user-1', now, db);

  assert.equal(usage.postsThisMonth, 2);
  assert.equal(usage.batchGenerationsThisMonth, 2);
  assert.equal(usage.imagesGeneratedThisMonth, 2);
  assert.equal(usage.manualAiOperationsThisMonth, 2);
  assert.deepEqual(captured.posts.publishedAt, { gte: start, lt: end });
  assert.equal(captured.posts.createdAt, undefined);
  assert.deepEqual(captured.batch.createdAt, { gte: start, lt: end });
  assert.deepEqual(captured.images.createdAt, { gte: start, lt: end });
  assert.deepEqual(captured.manual.createdAt, { gte: start, lt: end });
});

test('monthly plan fields win and legacy daily fields remain fallbacks', () => {
  const base = {
    monthlyPostLimit: 10,
    monthlyBatchGenerationLimit: 8,
    monthlyImageGenerationLimit: 7,
    monthlyManualAiOperationLimit: 9,
    dailyPostLimit: 1,
    dailyBatchGenerationLimit: 2,
    dailyImageGenerationLimit: 3,
    maxRewritesPerPost: 4,
    carouselSaveLimit: 12,
    carouselAiGenerationLimit: 6,
  } as any;

  assert.deepEqual(getMonthlyLimits(base), {
    posts: 10,
    batchGenerations: 8,
    images: 7,
    manualAiOperations: 9,
    carouselSaves: 12,
    carouselAiGenerations: 6,
  });
  assert.deepEqual(getMonthlyLimits({
    ...base,
    monthlyPostLimit: null,
    monthlyBatchGenerationLimit: null,
    monthlyImageGenerationLimit: null,
    monthlyManualAiOperationLimit: null,
  }), {
    posts: 30,
    batchGenerations: 60,
    images: 90,
    manualAiOperations: 600,
    carouselSaves: 12,
    carouselAiGenerations: 6,
  });
});

test('/entitlements/me summary remains monthly and privileged roles remain unlimited', () => {
  const service = readFileSync(path.join(__dirname, 'planEntitlementService.ts'), 'utf8');
  const route = readFileSync(path.join(__dirname, '../routes/entitlements.ts'), 'utf8');

  for (const field of [
    "usagePeriod: 'MONTHLY'",
    'periodStart',
    'periodEnd',
    'monthlyPostLimit',
    'monthlyBatchGenerationLimit',
    'monthlyImageGenerationLimit',
    'monthlyManualAiOperationLimit',
    'manualAiOperationsThisMonth',
    'carouselSaveLimit',
    'carouselAiGenerationLimit',
    'carouselAiGenerationsThisPeriod',
  ]) {
    assert.ok(service.includes(field), `missing ${field}`);
  }
  assert.ok(service.includes('effectiveAccess.unlimited'));
  assert.ok(service.includes('const UNLIMITED = 999_999'));
  assert.ok(route.includes('getUserPlanEntitlements(userId)'));
  assert.ok(route.includes('res.json(entitlements)'));
});
