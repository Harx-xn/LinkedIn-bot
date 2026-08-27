import assert from 'node:assert/strict';
import test from 'node:test';
import { AiUsageStatus, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../prismaClient';
import { calculateTokenCost, resolveAiModelPricing } from './aiPricingService';
import { linkAiUsageGenerationsToPost, recordAiUsage } from './aiUsageService';
import { createGenerationId, extractOpenAiUsage, trackAiProviderCall, withAiCostContext } from './aiCostTrackingService';
import { expenseCostForPeriod, normalizedMonthlyExpense } from './platformCostService';
import { getUserEconomics, percentile, summarizePlanDistribution } from './unitEconomicsService';
import { buildPricingRecommendation, recommendedMinimumPrice } from './pricingIntelligenceService';
import { requireRole } from '../../middleware/requireRole';
import { aggregateAiDimension } from './actualCostService';

test('cost intelligence pricing and accounting', async (t) => {
  await t.test('calculates input, cached input, output, total, and Decimal precision', () => {
    const value = calculateTokenCost(
      { inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 250_000 },
      { inputCostPerMillionTokens: '2.50', cachedInputCostPerMillionTokens: '0.50', outputCostPerMillionTokens: '10.00' },
    );
    assert.equal(value.inputCostUsd.toFixed(8), '2.50000000');
    assert.equal(value.cachedInputCostUsd.toFixed(8), '0.25000000');
    assert.equal(value.outputCostUsd.toFixed(8), '2.50000000');
    assert.equal(value.totalCostUsd.toFixed(8), '5.25000000');
    const precise = calculateTokenCost(
      { inputTokens: 100, cachedInputTokens: 0, outputTokens: 0 },
      { inputCostPerMillionTokens: '0.12345678', outputCostPerMillionTokens: 0 },
    );
    assert.equal(precise.totalCostUsd.toFixed(8), '0.00001235');
  });

  await t.test('selects the model price version valid at the request date', async () => {
    const original = prisma.aiModelPricing.findFirst;
    const versions = [
      { id: 'old', effectiveFrom: new Date('2026-01-01'), effectiveTo: new Date('2026-09-01') },
      { id: 'new', effectiveFrom: new Date('2026-09-01'), effectiveTo: null },
    ];
    (prisma.aiModelPricing as any).findFirst = async ({ where }: any) => versions
      .filter((row) => row.effectiveFrom <= where.effectiveFrom.lte && (!row.effectiveTo || row.effectiveTo > where.effectiveFrom.lte))
      .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0];
    try {
      assert.equal((await resolveAiModelPricing('openai', 'model-x', new Date('2026-08-31T23:00:00Z')) as any).id, 'old');
      assert.equal((await resolveAiModelPricing('openai', 'model-x', new Date('2026-09-01T01:00:00Z')) as any).id, 'new');
    } finally { (prisma.aiModelPricing as any).findFirst = original; }
  });

  await t.test('records exactly one successful provider call with generation tracing and cached usage', async () => {
    const originalPricing = prisma.aiModelPricing.findFirst;
    const originalCreate = prisma.aiUsageEvent.create;
    const writes: any[] = [];
    (prisma.aiModelPricing as any).findFirst = async () => ({
      id: 'price-1', provider: 'OPENAI', model: 'gpt-test', pricingUnit: 'TOKENS', active: true,
      inputCostPerMillionTokens: new Prisma.Decimal(2), cachedInputCostPerMillionTokens: new Prisma.Decimal(0.5), outputCostPerMillionTokens: new Prisma.Decimal(8),
      effectiveFrom: new Date('2026-01-01'), effectiveTo: null, metadata: null, createdAt: new Date(), updatedAt: new Date(),
    });
    (prisma.aiUsageEvent as any).create = async ({ data }: any) => { writes.push(data); return { id: 'event-1', ...data }; };
    try {
      const generationId = createGenerationId();
      const result = await withAiCostContext({ userId: 'user-1', regionId: 'region-1', feature: 'MANUAL_POST', operation: 'MANUAL_GENERATE', agent: 'WRITER', generationId }, () => trackAiProviderCall({
        provider: 'OPENAI', model: 'gpt-test',
        invoke: async () => ({ usage: { prompt_tokens: 125, prompt_tokens_details: { cached_tokens: 25 }, completion_tokens: 50 }, choices: [] }),
        extractUsage: extractOpenAiUsage,
      }));
      assert.ok(result);
      assert.equal(writes.length, 1);
      assert.equal(writes[0].generationId, generationId);
      assert.equal(writes[0].inputTokens, 100);
      assert.equal(writes[0].cachedInputTokens, 25);
      assert.equal(writes[0].outputTokens, 50);
      assert.equal(writes[0].status, AiUsageStatus.SUCCESS);
      assert.equal(writes[0].metadata.costStatus, 'PRICED');
    } finally {
      (prisma.aiModelPricing as any).findFirst = originalPricing;
      (prisma.aiUsageEvent as any).create = originalCreate;
    }
  });

  await t.test('missing pricing and failed calls are recorded safely without invented tokens', async () => {
    const originalPricing = prisma.aiModelPricing.findFirst;
    const originalCreate = prisma.aiUsageEvent.create;
    const writes: any[] = [];
    (prisma.aiModelPricing as any).findFirst = async () => null;
    (prisma.aiUsageEvent as any).create = async ({ data }: any) => { writes.push(data); return { id: 'event', ...data }; };
    try {
      await recordAiUsage({ feature: 'BATCH_POST', operation: 'BATCH_WRITE', agent: 'WRITER', provider: 'GEMINI', model: 'unknown', status: AiUsageStatus.FAILED, generationId: 'gen_failed', metadata: { usageAvailable: false } });
      assert.equal(writes.length, 1);
      assert.equal(writes[0].totalTokens, 0);
      assert.equal(writes[0].totalCostUsd.toFixed(8), '0.00000000');
      assert.equal(writes[0].metadata.costStatus, 'PRICING_MISSING');
      assert.equal(writes[0].status, AiUsageStatus.FAILED);
    } finally {
      (prisma.aiModelPricing as any).findFirst = originalPricing;
      (prisma.aiUsageEvent as any).create = originalCreate;
    }
  });

  await t.test('links pre-persistence generation traces to the resulting post', async () => {
    const originalUpdateMany = prisma.aiUsageEvent.updateMany;
    let update: any;
    (prisma.aiUsageEvent as any).updateMany = async (args: any) => { update = args; return { count: 2 }; };
    try {
      await linkAiUsageGenerationsToPost('user-1', ['gen_a', 'gen_a', 'gen_b'], 'post-1');
      assert.deepEqual(update.where, { userId: 'user-1', generationId: { in: ['gen_a', 'gen_b'] }, postId: null });
      assert.deepEqual(update.data, { postId: 'post-1' });
    } finally {
      (prisma.aiUsageEvent as any).updateMany = originalUpdateMany;
    }
  });

  await t.test('aggregates multiple agents and their success/failure calls independently', async () => {
    const originalGroupBy = prisma.aiUsageEvent.groupBy;
    (prisma.aiUsageEvent as any).groupBy = async ({ by }: any) => by.includes('status')
      ? [
          { agent: 'WRITER', status: 'SUCCESS', _count: { _all: 1 } },
          { agent: 'WRITER', status: 'FAILED', _count: { _all: 1 } },
          { agent: 'PLANNER', status: 'SUCCESS', _count: { _all: 1 } },
        ]
      : [
          { agent: 'WRITER', _count: { _all: 2 }, _sum: { inputTokens: 20, cachedInputTokens: 0, outputTokens: 10, totalTokens: 30, totalCostUsd: new Prisma.Decimal(3) }, _avg: { totalCostUsd: new Prisma.Decimal(1.5), durationMs: 20 } },
          { agent: 'PLANNER', _count: { _all: 1 }, _sum: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, totalTokens: 15, totalCostUsd: new Prisma.Decimal(1) }, _avg: { totalCostUsd: new Prisma.Decimal(1), durationMs: 10 } },
        ];
    try {
      const result = await aggregateAiDimension({ from: new Date('2026-08-01'), to: new Date('2026-09-01') }, 'agent');
      assert.deepEqual(result.map((row: any) => ({ agent: row.agent, calls: row.calls, successes: row.successfulCalls, failures: row.failedCalls, spendPercent: row.spendPercent })), [
        { agent: 'WRITER', calls: 2, successes: 1, failures: 1, spendPercent: 75 },
        { agent: 'PLANNER', calls: 1, successes: 1, failures: 0, spendPercent: 25 },
      ]);
    } finally {
      (prisma.aiUsageEvent as any).groupBy = originalGroupBy;
    }
  });
});

test('unit economics, expenses, percentiles, and pricing recommendations', async (t) => {
  await t.test('normalizes expenses without losing original billing cycle', () => {
    const yearly = { amountUsd: new Prisma.Decimal(120), billingCycle: 'YEARLY' as const };
    assert.equal(normalizedMonthlyExpense(yearly), 10);
    const usage = { ...yearly, id: 'e', name: 'Database', provider: null, category: 'Database', type: 'VARIABLE' as const, billingCycle: 'USAGE' as const, active: true, effectiveFrom: new Date('2026-08-01'), effectiveTo: null, notes: null, metadata: null, createdAt: new Date(), updatedAt: new Date() };
    assert.equal(expenseCostForPeriod(usage, { from: new Date('2026-08-01'), to: new Date('2026-09-01') }), 120);
  });

  await t.test('calculates real percentiles and deterministic minimum pricing', () => {
    const costs = [1, 2, 3, 4, 10];
    assert.equal(percentile(costs, 0.5), 3);
    assert.equal(percentile(costs, 0.75), 4);
    assert.equal(percentile(costs, 0.9), 7.6);
    assert.equal(recommendedMinimumPrice(6, 0.75), 24);
    const plan = { planId: 'p', planName: 'Pro', currency: 'USD', price: 20, subscriberCount: 5, paidSubscribers: 5, aiActiveSubscribers: 5, costs };
    const summary = summarizePlanDistribution(plan);
    assert.equal(summary.sampleStatus, 'SUFFICIENT');
    const recommendation = buildPricingRecommendation(plan, { targetGrossMargin: 0.75, minimumAcceptableMargin: 0.5, pricingPercentileBasis: 'P75' });
    assert.equal(recommendation.recommendedMinimumUsd, 16);
    assert.equal(recommendation.status, 'HEALTHY');
    assert.equal(summarizePlanDistribution({ ...plan, costs: [1, 2] }).sampleStatus, 'LOW_SAMPLE_SIZE');
  });

  await t.test('keeps direct cost, allocated cost, actual revenue, total cost, and margin separate', async () => {
    const originals = {
      userCount: prisma.user.count, userFindMany: prisma.user.findMany, aiCount: prisma.aiUsageEvent.count,
      aiGroupBy: prisma.aiUsageEvent.groupBy, postGroupBy: prisma.post.groupBy, billingGroupBy: prisma.billingTransaction.groupBy,
      expenseFindMany: prisma.platformExpense.findMany, ruleFindMany: prisma.costAllocationRule.findMany,
    };
    (prisma.user as any).count = async () => 1;
    (prisma.user as any).findMany = async () => [{ id: 'u1', email: 'user@example.com', username: 'user', subscriptions: [{ plan: { id: 'p1', name: 'Pro' } }] }];
    (prisma.aiUsageEvent as any).count = async () => 2;
    (prisma.aiUsageEvent as any).groupBy = async () => [{ userId: 'u1', _count: { _all: 2 }, _sum: { totalCostUsd: new Prisma.Decimal('4.20') } }];
    (prisma.post as any).groupBy = async () => [{ userId: 'u1', _count: { _all: 1 } }];
    (prisma.billingTransaction as any).groupBy = async () => [{ userId: 'u1', currency: 'USD', _sum: { amountPaid: 1000 } }];
    (prisma.platformExpense as any).findMany = async () => [{ id: 'e', name: 'Infra', provider: null, category: 'Infrastructure', type: 'VARIABLE', billingCycle: 'USAGE', amountUsd: new Prisma.Decimal('1.10'), active: true, effectiveFrom: new Date('2026-08-01'), effectiveTo: null, notes: null, metadata: null, createdAt: new Date(), updatedAt: new Date() }];
    (prisma.costAllocationRule as any).findMany = async () => [{ expenseCategory: 'Infrastructure', allocationMethod: 'ACTIVE_USERS' }];
    try {
      const result = await getUserEconomics({ from: new Date('2026-08-01'), to: new Date('2026-09-01') }, 1, 25);
      assert.equal(result.items[0].directAiCostUsd, 4.2);
      assert.equal(result.items[0].allocatedCostUsd, 1.1);
      assert.equal(result.items[0].totalCostUsd, 5.3);
      assert.equal(result.items[0].revenue.totalUsd, 10);
      assert.equal(result.items[0].contributionProfitUsd, 4.7);
      assert.ok(Math.abs((result.items[0].contributionMarginPercent ?? 0) - 47) < 0.0001);
    } finally {
      (prisma.user as any).count = originals.userCount; (prisma.user as any).findMany = originals.userFindMany;
      (prisma.aiUsageEvent as any).count = originals.aiCount; (prisma.aiUsageEvent as any).groupBy = originals.aiGroupBy;
      (prisma.post as any).groupBy = originals.postGroupBy; (prisma.billingTransaction as any).groupBy = originals.billingGroupBy;
      (prisma.platformExpense as any).findMany = originals.expenseFindMany; (prisma.costAllocationRule as any).findMany = originals.ruleFindMany;
    }
  });
});

test('cost intelligence authorization permits only SUPER_ADMIN', () => {
  const middleware = requireRole(UserRole.SUPER_ADMIN);
  const invoke = (role: UserRole) => {
    let status = 200; let nextCalled = false;
    const response = { status(value: number) { status = value; return this; }, json() { return this; } } as any;
    middleware({ user: { id: 'u', role } } as any, response, () => { nextCalled = true; });
    return { status, nextCalled };
  };
  assert.deepEqual(invoke(UserRole.SUPER_ADMIN), { status: 200, nextCalled: true });
  assert.deepEqual(invoke(UserRole.REGIONAL_ADMIN), { status: 403, nextCalled: false });
  assert.deepEqual(invoke(UserRole.USER), { status: 403, nextCalled: false });
});
