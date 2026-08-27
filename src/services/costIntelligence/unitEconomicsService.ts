import { Prisma } from '@prisma/client';
import { prisma } from '../../prismaClient';
import { aiUsageWhere, getActualRevenue, getAiUsageSummary, type CostFilters } from './actualCostService';
import { getPlatformExpenseSummary } from './platformCostService';

export const LOW_SAMPLE_SIZE_THRESHOLD = 5;
const moneyNumber = (value: number) => Number(value.toFixed(8));

export function percentile(values: number[], percentileValue: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * percentileValue;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return moneyNumber(sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower));
}

function contribution(revenue: number | null, cost: number) {
  const profit = revenue == null ? null : moneyNumber(revenue - cost);
  return {
    contributionProfitUsd: profit,
    contributionMarginPercent: revenue && profit != null ? profit / revenue * 100 : null,
  };
}

async function userPopulation(filters: CostFilters) {
  const subscriptionScope: Prisma.UserWhereInput = filters.planId
    ? { subscriptions: { some: { planId: filters.planId, status: { in: ['ACTIVE', 'TRIALING'] } } } }
    : {};
  const activityWhere = {
    ...(filters.regionId ? { regionId: filters.regionId } : {}),
    ...(filters.userId ? { id: filters.userId } : {}),
    ...subscriptionScope,
    OR: [
      { posts: { some: { createdAt: { gte: filters.from, lt: filters.to } } } },
      { aiUsageEvents: { some: { createdAt: { gte: filters.from, lt: filters.to } } } },
    ],
  } as Prisma.UserWhereInput;
  const [activeUsers, payingUsers, aiActiveUsers] = await Promise.all([
    prisma.user.count({ where: activityWhere }),
    prisma.user.count({ where: {
      ...(filters.regionId ? { regionId: filters.regionId } : {}),
      ...(filters.userId ? { id: filters.userId } : {}),
      subscriptions: { some: { ...(filters.planId ? { planId: filters.planId } : {}), status: 'ACTIVE', startsAt: { lt: filters.to }, OR: [{ endsAt: null }, { endsAt: { gte: filters.from } }] } },
    } }),
    prisma.user.count({ where: {
      ...(filters.regionId ? { regionId: filters.regionId } : {}),
      ...(filters.userId ? { id: filters.userId } : {}),
      ...subscriptionScope,
      aiUsageEvents: { some: { createdAt: { gte: filters.from, lt: filters.to } } },
    } }),
  ]);
  return { activeUsers, payingUsers, aiActiveUsers };
}

export async function getUnitEconomics(filters: CostFilters) {
  const where = aiUsageWhere(filters);
  const [ai, expenses, population, revenue, successfulPosts, images, carousels, generationSpend, batchPosts] = await Promise.all([
    getAiUsageSummary(filters),
    getPlatformExpenseSummary(filters),
    userPopulation(filters),
    getActualRevenue(filters),
    prisma.aiUsageEvent.findMany({
      where: { ...where, status: 'SUCCESS', postId: { not: null }, generationId: { not: null } },
      distinct: ['generationId'], select: { generationId: true, postId: true },
    }),
    prisma.aiUsageEvent.groupBy({ by: ['generationId'], where: { ...where, feature: 'AI_IMAGE', status: 'SUCCESS', generationId: { not: null } }, _sum: { totalCostUsd: true } }),
    prisma.aiUsageEvent.groupBy({ by: ['generationId'], where: { ...where, feature: 'CAROUSEL', status: 'SUCCESS', generationId: { not: null } }, _sum: { totalCostUsd: true } }),
    prisma.aiUsageEvent.aggregate({ where: { ...where, generationId: { not: null } }, _sum: { totalCostUsd: true } }),
    prisma.generatedTopicHistory.groupBy({
      by: ['batchId'],
      where: {
        batchId: { not: null }, postId: { not: null }, generatedAt: { gte: filters.from, lt: filters.to },
        ...((filters.regionId || filters.userId || filters.planId) ? {
          user: {
            ...(filters.regionId ? { regionId: filters.regionId } : {}),
            ...(filters.userId ? { id: filters.userId } : {}),
            ...(filters.planId ? { subscriptions: { some: { planId: filters.planId, status: { in: ['ACTIVE', 'TRIALING'] } } } } : {}),
          },
        } : {}),
      },
      _count: { postId: true },
    }),
  ]);
  const successfulPostCount = successfulPosts.length + batchPosts.reduce((sum, row) => sum + row._count.postId, 0);
  const successfulGenerationIds = successfulPosts.map((item) => item.generationId).filter((id): id is string => Boolean(id));
  const successfulBatchIds = batchPosts.map((item) => item.batchId).filter((id): id is string => Boolean(id));
  const successfulPostSpend = successfulGenerationIds.length || successfulBatchIds.length
    ? await prisma.aiUsageEvent.aggregate({
        where: {
          ...where,
          OR: [
            ...(successfulGenerationIds.length ? [{ generationId: { in: successfulGenerationIds } }] : []),
            ...(successfulBatchIds.length ? [{ batchJobId: { in: successfulBatchIds } }] : []),
          ],
        },
        _sum: { totalCostUsd: true },
      })
    : null;
  const totalCost = ai.spendUsd + expenses.totalUsd;
  const usdRevenue = revenue.currency === 'USD' ? revenue.total : null;
  return {
    mode: 'ACTUAL' as const,
    ...population,
    aiRequests: ai.requests,
    generations: ai.generations,
    costPerActiveUserUsd: population.activeUsers ? totalCost / population.activeUsers : null,
    costPerPayingUserUsd: population.payingUsers ? totalCost / population.payingUsers : null,
    aiCostPerAiActiveUserUsd: population.aiActiveUsers ? ai.spendUsd / population.aiActiveUsers : null,
    aiCostPerRequestUsd: ai.requests ? ai.spendUsd / ai.requests : null,
    aiCostPerSuccessfulPostUsd: successfulPostCount ? Number(successfulPostSpend?._sum.totalCostUsd ?? 0) / successfulPostCount : null,
    aiCostPerGenerationUsd: ai.generations ? Number(generationSpend._sum.totalCostUsd ?? 0) / ai.generations : null,
    aiCostPerImageUsd: images.length ? images.reduce((sum, row) => sum + Number(row._sum.totalCostUsd ?? 0), 0) / images.length : null,
    aiCostPerCarouselUsd: carousels.length ? carousels.reduce((sum, row) => sum + Number(row._sum.totalCostUsd ?? 0), 0) / carousels.length : null,
    revenuePerPayingUserUsd: usdRevenue != null && population.payingUsers ? usdRevenue / population.payingUsers : null,
    totalCostUsd: totalCost,
    aiCostUsd: ai.spendUsd,
    allocatedPlatformCostUsd: expenses.totalUsd,
    revenue,
    ...contribution(usdRevenue, totalCost),
    allocationBasis: expenses.allocationBasis,
  };
}

export async function getUserEconomics(filters: CostFilters, page: number, pageSize: number) {
  const safePage = Math.max(1, Math.trunc(page));
  const take = Math.min(100, Math.max(1, Math.trunc(pageSize)));
  const userWhere: Prisma.UserWhereInput = {
    ...(filters.regionId ? { regionId: filters.regionId } : {}),
    ...(filters.userId ? { id: filters.userId } : {}),
    ...(filters.planId ? { subscriptions: { some: { planId: filters.planId, status: { in: ['ACTIVE', 'TRIALING'] } } } } : {}),
  };
  const [total, users, population, expenseSummary, totalAi] = await Promise.all([
    prisma.user.count({ where: userWhere }),
    prisma.user.findMany({
      where: userWhere, skip: (safePage - 1) * take, take,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, email: true, username: true,
        subscriptions: { where: { status: { in: ['ACTIVE', 'TRIALING'] } }, orderBy: { createdAt: 'desc' }, take: 1, select: { status: true, plan: { select: { id: true, name: true } } } },
      },
    }),
    userPopulation(filters),
    getPlatformExpenseSummary(filters),
    prisma.aiUsageEvent.count({ where: aiUsageWhere(filters) }),
  ]);
  const ids = users.map((user) => user.id);
  if (!ids.length) return { items: [], page: safePage, pageSize: take, total, totalPages: Math.ceil(total / take), allocationBasis: expenseSummary.allocationBasis };
  const [aiRows, postRows, revenueRows] = await Promise.all([
    prisma.aiUsageEvent.groupBy({
      by: ['userId'], where: { ...aiUsageWhere(filters), userId: { in: ids } },
      _count: { _all: true }, _sum: { totalCostUsd: true },
    }),
    prisma.post.groupBy({
      by: ['userId'], where: { userId: { in: ids }, aiGenerated: true, createdAt: { gte: filters.from, lt: filters.to } }, _count: { _all: true },
    }),
    prisma.billingTransaction.groupBy({
      by: ['userId', 'currency'], where: { userId: { in: ids }, status: { in: ['PAID', 'SUCCEEDED', 'SUCCESS', 'COMPLETED'] }, amountPaid: { gt: 0 }, paidAt: { gte: filters.from, lt: filters.to } },
      _sum: { amountPaid: true },
    }),
  ]);
  const aiMap = new Map(aiRows.map((row) => [row.userId, { requests: row._count._all, cost: Number(row._sum.totalCostUsd ?? 0) }]));
  const postMap = new Map(postRows.map((row) => [row.userId, row._count._all]));
  const revenueMap = new Map<string, Array<{ currency: string; amount: number }>>();
  for (const row of revenueRows) revenueMap.set(row.userId, [...(revenueMap.get(row.userId) ?? []), { currency: row.currency, amount: (row._sum.amountPaid ?? 0) / 100 }]);
  const items = users.map((user) => {
    const direct = aiMap.get(user.id) ?? { requests: 0, cost: 0 };
    const revenueByCurrency = revenueMap.get(user.id) ?? [];
    const revenueUsd = revenueByCurrency.length === 1 && revenueByCurrency[0].currency.toUpperCase() === 'USD' ? revenueByCurrency[0].amount : null;
    const isActive = direct.requests > 0 || (postMap.get(user.id) ?? 0) > 0;
    const isPaying = user.subscriptions[0]?.status === 'ACTIVE';
    let directOtherVariableCostUsd = 0;
    let allocatedCostUsd = 0;
    for (const expense of expenseSummary.items) {
      const metadata = expense.metadata && typeof expense.metadata === 'object' && !Array.isArray(expense.metadata) ? expense.metadata as Record<string, unknown> : {};
      if (expense.allocationMethod === 'DIRECT') {
        if (metadata.userId === user.id) directOtherVariableCostUsd += expense.periodCostUsd;
      } else if (expense.allocationMethod === 'ACTIVE_USERS' && isActive && population.activeUsers) {
        allocatedCostUsd += expense.periodCostUsd / population.activeUsers;
      } else if (expense.allocationMethod === 'PAID_USERS' && isPaying && population.payingUsers) {
        allocatedCostUsd += expense.periodCostUsd / population.payingUsers;
      } else if (expense.allocationMethod === 'AI_ACTIVE_USERS' && direct.requests > 0 && population.aiActiveUsers) {
        allocatedCostUsd += expense.periodCostUsd / population.aiActiveUsers;
      } else if (expense.allocationMethod === 'REQUEST_WEIGHTED' && totalAi) {
        allocatedCostUsd += expense.periodCostUsd * direct.requests / totalAi;
      } else if (expense.allocationMethod === 'MANUAL') {
        const allocations = metadata.userAllocations && typeof metadata.userAllocations === 'object' ? metadata.userAllocations as Record<string, unknown> : {};
        allocatedCostUsd += Number(allocations[user.id] ?? 0);
      }
    }
    directOtherVariableCostUsd = moneyNumber(directOtherVariableCostUsd);
    allocatedCostUsd = moneyNumber(allocatedCostUsd);
    const totalCostUsd = moneyNumber(direct.cost + directOtherVariableCostUsd + allocatedCostUsd);
    return {
      id: user.id, user: user.email || user.username,
      plan: user.subscriptions[0]?.plan ?? null,
      aiRequests: direct.requests, generatedPosts: postMap.get(user.id) ?? 0,
      directAiCostUsd: direct.cost, directOtherVariableCostUsd,
      allocatedCostUsd, totalCostUsd, revenue: { totalUsd: revenueUsd, breakdown: revenueByCurrency },
      ...contribution(revenueUsd, totalCostUsd),
    };
  });
  return { items, page: safePage, pageSize: take, total, totalPages: Math.ceil(total / take), allocationBasis: expenseSummary.allocationBasis, totalAiRequests: totalAi };
}

export type PlanCostDistribution = {
  planId: string;
  planName: string;
  currency: string;
  price: number;
  subscriberCount: number;
  paidSubscribers: number;
  aiActiveSubscribers: number;
  costs: number[];
};

export async function getPlanCostDistributions(filters: CostFilters): Promise<PlanCostDistribution[]> {
  const plans = await prisma.plan.findMany({
    where: { isActive: true, ...(filters.regionId ? { regionId: filters.regionId } : {}) },
    select: {
      id: true, name: true, currency: true, price: true,
      subscriptions: {
        where: { status: { in: ['ACTIVE', 'TRIALING'] } },
        select: { userId: true, status: true },
      },
    }, orderBy: { price: 'asc' },
  });
  const userIds = [...new Set(plans.flatMap((plan) => plan.subscriptions.map((subscription) => subscription.userId)))];
  const costRows = userIds.length ? await prisma.aiUsageEvent.groupBy({
    by: ['userId'], where: { ...aiUsageWhere(filters), userId: { in: userIds } }, _sum: { totalCostUsd: true },
  }) : [];
  const costMap = new Map(costRows.map((row) => [row.userId, Number(row._sum.totalCostUsd ?? 0)]));
  return plans.map((plan) => ({
    planId: plan.id, planName: plan.name, currency: plan.currency, price: plan.price,
    subscriberCount: plan.subscriptions.length,
    paidSubscribers: plan.subscriptions.filter((subscription) => subscription.status === 'ACTIVE').length,
    aiActiveSubscribers: plan.subscriptions.filter((subscription) => costMap.has(subscription.userId)).length,
    costs: plan.subscriptions.map((subscription) => costMap.get(subscription.userId) ?? 0),
  }));
}

export function summarizePlanDistribution(plan: PlanCostDistribution) {
  const sampleSize = plan.costs.length;
  const averageCostUsd = sampleSize ? plan.costs.reduce((sum, cost) => sum + cost, 0) / sampleSize : null;
  return {
    planId: plan.planId, planName: plan.planName, currency: plan.currency, price: plan.price,
    subscriberCount: plan.subscriberCount, paidSubscribers: plan.paidSubscribers,
    aiActiveSubscribers: plan.aiActiveSubscribers, sampleSize,
    sampleStatus: sampleSize < LOW_SAMPLE_SIZE_THRESHOLD ? 'LOW_SAMPLE_SIZE' as const : 'SUFFICIENT' as const,
    averageCostUsd,
    p50CostUsd: percentile(plan.costs, 0.5), p75CostUsd: percentile(plan.costs, 0.75),
    p90CostUsd: percentile(plan.costs, 0.9), p95CostUsd: percentile(plan.costs, 0.95),
    maximumCostUsd: plan.costs.length ? Math.max(...plan.costs) : null,
    averageRevenuePerUser: plan.price,
    contributionMarginPercent: plan.currency.toUpperCase() === 'USD' && plan.price && averageCostUsd != null ? (plan.price - averageCostUsd) / plan.price * 100 : null,
  };
}

export type PlanEconomicsSummary = ReturnType<typeof summarizePlanDistribution>;

/** PostgreSQL computes plan percentiles; user cost rows never leave the database. */
export async function getPlanEconomicsSummaries(filters: CostFilters): Promise<PlanEconomicsSummary[]> {
  const [expenses, population, totalAiRequests] = await Promise.all([
    getPlatformExpenseSummary(filters),
    userPopulation(filters),
    prisma.aiUsageEvent.count({ where: aiUsageWhere(filters) }),
  ]);
  let activeUsersExpense = 0;
  let paidUsersExpense = 0;
  let aiActiveUsersExpense = 0;
  let requestWeightedExpense = 0;
  const directAllocations: Record<string, number> = {};
  for (const expense of expenses.items) {
    const metadata = expense.metadata && typeof expense.metadata === 'object' && !Array.isArray(expense.metadata)
      ? expense.metadata as Record<string, unknown>
      : {};
    if (expense.allocationMethod === 'ACTIVE_USERS') activeUsersExpense += expense.periodCostUsd;
    else if (expense.allocationMethod === 'PAID_USERS') paidUsersExpense += expense.periodCostUsd;
    else if (expense.allocationMethod === 'AI_ACTIVE_USERS') aiActiveUsersExpense += expense.periodCostUsd;
    else if (expense.allocationMethod === 'REQUEST_WEIGHTED') requestWeightedExpense += expense.periodCostUsd;
    else if (expense.allocationMethod === 'DIRECT' && typeof metadata.userId === 'string') {
      directAllocations[metadata.userId] = (directAllocations[metadata.userId] ?? 0) + expense.periodCostUsd;
    } else if (expense.allocationMethod === 'MANUAL' && metadata.userAllocations && typeof metadata.userAllocations === 'object' && !Array.isArray(metadata.userAllocations)) {
      for (const [userId, amount] of Object.entries(metadata.userAllocations as Record<string, unknown>)) {
        const numericAmount = Number(amount);
        if (Number.isFinite(numericAmount)) directAllocations[userId] = (directAllocations[userId] ?? 0) + numericAmount;
      }
    }
  }
  const allocatedPerActiveUser = population.activeUsers ? activeUsersExpense / population.activeUsers : 0;
  const allocatedPerPaidUser = population.payingUsers ? paidUsersExpense / population.payingUsers : 0;
  const allocatedPerAiActiveUser = population.aiActiveUsers ? aiActiveUsersExpense / population.aiActiveUsers : 0;
  const planCondition = filters.planId ? Prisma.sql`AND p."id" = ${filters.planId}` : Prisma.empty;
  const regionCondition = filters.regionId ? Prisma.sql`AND p."regionId" = ${filters.regionId}` : Prisma.empty;
  const providerCondition = filters.provider ? Prisma.sql`AND e."provider" = ${filters.provider.toUpperCase()}` : Prisma.empty;
  const modelCondition = filters.model ? Prisma.sql`AND e."model" = ${filters.model}` : Prisma.empty;
  const featureCondition = filters.feature ? Prisma.sql`AND e."feature" = ${filters.feature}` : Prisma.empty;
  const operationCondition = filters.operation ? Prisma.sql`AND e."operation" = ${filters.operation}` : Prisma.empty;
  const agentCondition = filters.agent ? Prisma.sql`AND e."agent" = ${filters.agent}` : Prisma.empty;
  const rows = await prisma.$queryRaw<Array<{
    planId: string; planName: string; currency: string; price: number; subscriberCount: bigint; paidSubscribers: bigint;
    aiActiveSubscribers: bigint; averageCost: Prisma.Decimal | null; p50: Prisma.Decimal | null; p75: Prisma.Decimal | null;
    p90: Prisma.Decimal | null; p95: Prisma.Decimal | null; maximumCost: Prisma.Decimal | null;
  }>>(Prisma.sql`
    WITH active_subscriptions AS (
      SELECT DISTINCT ON (s."userId") s."userId", s."planId", s."status"
      FROM "Subscription" s
      WHERE s."status" IN ('ACTIVE', 'TRIALING')
      ORDER BY s."userId", s."createdAt" DESC
    ), direct_allocations AS (
      SELECT key AS user_id, value::numeric AS amount
      FROM jsonb_each_text(${JSON.stringify(directAllocations)}::jsonb)
    ), base_user_costs AS (
      SELECT s."userId", s."planId", s."status",
             COALESCE(SUM(e."totalCostUsd"), 0) AS direct_ai_cost,
             COUNT(e."id") AS ai_calls,
             (COUNT(e."id") > 0 OR EXISTS (
               SELECT 1 FROM "Post" post
               WHERE post."userId" = s."userId"
                 AND post."createdAt" >= ${filters.from} AND post."createdAt" < ${filters.to}
             )) AS is_active
      FROM active_subscriptions s
      LEFT JOIN "AiUsageEvent" e ON e."userId" = s."userId"
        AND e."createdAt" >= ${filters.from} AND e."createdAt" < ${filters.to}
        ${providerCondition} ${modelCondition} ${featureCondition} ${operationCondition} ${agentCondition}
      GROUP BY s."userId", s."planId", s."status"
    ), user_costs AS (
      SELECT base."userId", base."planId", base."status", base.ai_calls,
             base.direct_ai_cost
             + CASE WHEN base.is_active THEN ${allocatedPerActiveUser}::numeric ELSE 0 END
             + CASE WHEN base."status" = 'ACTIVE' THEN ${allocatedPerPaidUser}::numeric ELSE 0 END
             + CASE WHEN base.ai_calls > 0 THEN ${allocatedPerAiActiveUser}::numeric ELSE 0 END
             + CASE WHEN ${totalAiRequests} > 0 THEN ${requestWeightedExpense}::numeric * base.ai_calls / ${Math.max(1, totalAiRequests)}::numeric ELSE 0 END
             + COALESCE(direct.amount, 0) AS total_cost
      FROM base_user_costs base
      LEFT JOIN direct_allocations direct ON direct.user_id = base."userId"
    )
    SELECT p."id" AS "planId", p."name" AS "planName", p."currency", p."price",
           COUNT(u."userId") AS "subscriberCount",
           COUNT(u."userId") FILTER (WHERE u."status" = 'ACTIVE') AS "paidSubscribers",
           COUNT(u."userId") FILTER (WHERE u.ai_calls > 0) AS "aiActiveSubscribers",
           AVG(u.total_cost) AS "averageCost",
           percentile_cont(0.50) WITHIN GROUP (ORDER BY u.total_cost) AS p50,
           percentile_cont(0.75) WITHIN GROUP (ORDER BY u.total_cost) AS p75,
           percentile_cont(0.90) WITHIN GROUP (ORDER BY u.total_cost) AS p90,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY u.total_cost) AS p95,
           MAX(u.total_cost) AS "maximumCost"
    FROM "Plan" p
    LEFT JOIN user_costs u ON u."planId" = p."id"
    WHERE p."isActive" = true ${regionCondition} ${planCondition}
    GROUP BY p."id", p."name", p."currency", p."price"
    ORDER BY p."price" ASC
  `);
  return rows.map((row) => {
    const sampleSize = Number(row.subscriberCount);
    const averageCostUsd = row.averageCost == null ? null : Number(row.averageCost);
    return {
      planId: row.planId, planName: row.planName, currency: row.currency, price: Number(row.price),
      subscriberCount: sampleSize, paidSubscribers: Number(row.paidSubscribers), aiActiveSubscribers: Number(row.aiActiveSubscribers),
      sampleSize, sampleStatus: sampleSize < LOW_SAMPLE_SIZE_THRESHOLD ? 'LOW_SAMPLE_SIZE' as const : 'SUFFICIENT' as const,
      averageCostUsd, p50CostUsd: row.p50 == null ? null : Number(row.p50), p75CostUsd: row.p75 == null ? null : Number(row.p75),
      p90CostUsd: row.p90 == null ? null : Number(row.p90), p95CostUsd: row.p95 == null ? null : Number(row.p95),
      maximumCostUsd: row.maximumCost == null ? null : Number(row.maximumCost), averageRevenuePerUser: Number(row.price),
      contributionMarginPercent: row.currency.toUpperCase() === 'USD' && Number(row.price) && averageCostUsd != null ? (Number(row.price) - averageCostUsd) / Number(row.price) * 100 : null,
    };
  });
}
