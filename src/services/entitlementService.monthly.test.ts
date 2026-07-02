import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { getUtcMonthWindow } from '../utils/monthlyLimitWindow';
import {
  getTrialMonthlyPublishLimit,
  publishedThisMonth,
  TRIAL_MONTHLY_PUBLISH_LIMIT,
  TRIAL_MONTHLY_PUBLISH_SETTING_KEY,
} from './entitlementService';

test('trial entitlement reads trial.monthlyPublishLimit', async () => {
  const calls: unknown[][] = [];
  const limit = await getTrialMonthlyPublishLimit('region-1', async (...args: any[]) => {
    calls.push(args);
    return 47;
  });

  assert.equal(limit, 47);
  assert.deepEqual(calls, [[TRIAL_MONTHLY_PUBLISH_SETTING_KEY, 'region-1', 30]]);
});

test('trial entitlement falls back to 30 when the monthly setting is missing', async () => {
  const limit = await getTrialMonthlyPublishLimit(
    'region-1',
    async (_key, _regionId, fallback) => fallback ?? 30,
  );
  assert.equal(TRIAL_MONTHLY_PUBLISH_LIMIT, 30);
  assert.equal(limit, 30);
});

test('trial published usage uses the same inclusive-start exclusive-end UTC month window', async () => {
  const now = new Date('2026-08-18T09:30:00.000Z');
  const expected = getUtcMonthWindow(now);
  let capturedWhere: any;
  const db = { post: { count: async (args: any) => {
    capturedWhere = args.where;
    return 2;
  } } } as any;

  assert.equal(await publishedThisMonth('trial-user', now, db), 2);
  assert.equal(capturedWhere.status, 'PUBLISHED');
  assert.deepEqual(capturedWhere.publishedAt, {
    gte: expected.start,
    lt: expected.end,
  });
});

test('trial entitlement source has no server-local midnight reset logic', () => {
  const source = readFileSync(path.join(__dirname, 'entitlementService.ts'), 'utf8');

  assert.equal(source.includes('setHours(0, 0, 0, 0)'), false);
  assert.equal(source.includes('getUtcMonthWindow(now)'), true);
  assert.equal(source.includes('trial.dailyPublishLimit'), false);
});
