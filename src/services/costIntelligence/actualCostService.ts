import { AiUsageStatus, Prisma } from '@prisma/client';
import { prisma } from '../../prismaClient';
import { getPlatformExpenseSummary, type CostPeriod } from './platformCostService';

export type CostFilters = CostPeriod & {
  regionId?: string;
  planId?: string;
  provider?: string;
  model?: string;
  feature?: string;
  operation?: string;
  agent?: string;
  userId?: string;
};

export function aiUsageWhere(filters: CostFilters): Prisma.AiUsageEventWhereInput {
  return {
    createdAt: { gte: filters.from, lt: filters.to },
    ...(filters.regionId ? { regionId: filters.regionId } : {}),
    ...(filters.provider ? { provider: filters.provider.toUpperCase() } : {}),
    ...(filters.model ? { model: filters.model } : {}),
    ...(filters.feature ? { feature: filters.feature } : {}),
    ...(filters.operation ? { operation: filters.operation } : {}),
    ...(filters.agent ? { agent: filters.agent } : {}),
    ...(filters.userId ? { userId: filters.userId } : {}),
    ...(filters.planId ? {
      user: { subscriptions: { some: { planId: filters.planId, status: { in: ['ACTIVE', 'TRIALING'] } } } },
    } : {}),
  };
}

function totalFromAggregate(value: Prisma.Decimal | null | undefined): number {
  return Number(value ?? 0);
}

export async function getAiUsageSummary(filters: CostFilters) {
  const where = aiUsageWhere(filters);
  const [aggregate, successful, failed, users, generations] = await Promise.all([
    prisma.aiUsageEvent.aggregate({
      where,
      _count: { _all: true },
      _sum: { inputTokens: true, cachedInputTokens: true, outputTokens: true, totalTokens: true, totalCostUsd: true },
      _avg: { totalCostUsd: true, durationMs: true },
    }),
    prisma.aiUsageEvent.aggregate({ where: { ...where, status: AiUsageStatus.SUCCESS }, _sum: { totalCostUsd: true } }),
    prisma.aiUsageEvent.aggregate({ where: { ...where, status: { in: [AiUsageStatus.FAILED, AiUsageStatus.PARTIAL] } }, _sum: { totalCostUsd: true } }),
    prisma.aiUsageEvent.findMany({ where: { ...where, userId: { not: null } }, distinct: ['userId'], select: { userId: true } }),
    prisma.aiUsageEvent.findMany({ where: { ...where, generationId: { not: null } }, distinct: ['generationId'], select: { generationId: true } }),
  ]);
  const totalCostUsd = totalFromAggregate(aggregate._sum.totalCostUsd);
  const failedSpendUsd = totalFromAggregate(failed._sum.totalCostUsd);
  return {
    mode: 'ACTUAL' as const,
    spendUsd: totalCostUsd,
    requests: aggregate._count._all,
    inputTokens: aggregate._sum.inputTokens ?? 0,
    cachedInputTokens: aggregate._sum.cachedInputTokens ?? 0,
    outputTokens: aggregate._sum.outputTokens ?? 0,
    totalTokens: aggregate._sum.totalTokens ?? 0,
    averageCostPerRequestUsd: totalFromAggregate(aggregate._avg.totalCostUsd),
    averageCostPerAiUserUsd: users.length ? totalCostUsd / users.length : null,
    averageDurationMs: Number(aggregate._avg.durationMs ?? 0),
    aiActiveUsers: users.length,
    generations: generations.length,
    successfulSpendUsd: totalFromAggregate(successful._sum.totalCostUsd),
    failedSpendUsd,
    wastedSpendPercent: totalCostUsd > 0 ? failedSpendUsd / totalCostUsd * 100 : 0,
  };
}

export async function aggregateAiDimension(filters: CostFilters, dimension: 'agent' | 'providerModel' | 'feature') {
  const where = aiUsageWhere(filters);
  if (dimension === 'providerModel') {
    const rows = await prisma.aiUsageEvent.groupBy({
      by: ['provider', 'model'], where,
      _count: { _all: true },
      _sum: { inputTokens: true, cachedInputTokens: true, outputTokens: true, totalTokens: true, totalCostUsd: true },
      _avg: { totalCostUsd: true, durationMs: true },
    });
    const total = rows.reduce((sum, row) => sum + Number(row._sum.totalCostUsd ?? 0), 0);
    const failed = await prisma.aiUsageEvent.groupBy({
      by: ['provider', 'model'], where: { ...where, status: { in: [AiUsageStatus.FAILED, AiUsageStatus.PARTIAL] } }, _sum: { totalCostUsd: true },
    });
    const failedMap = new Map(failed.map((row) => [`${row.provider}\u0000${row.model}`, Number(row._sum.totalCostUsd ?? 0)]));
    return rows.map((row) => ({
      provider: row.provider, model: row.model, calls: row._count._all,
      inputTokens: row._sum.inputTokens ?? 0, cachedInputTokens: row._sum.cachedInputTokens ?? 0,
      outputTokens: row._sum.outputTokens ?? 0, totalTokens: row._sum.totalTokens ?? 0,
      averageCostUsd: Number(row._avg.totalCostUsd ?? 0), totalCostUsd: Number(row._sum.totalCostUsd ?? 0),
      spendPercent: total ? Number(row._sum.totalCostUsd ?? 0) / total * 100 : 0,
      failureSpendUsd: failedMap.get(`${row.provider}\u0000${row.model}`) ?? 0,
    })).sort((a, b) => b.totalCostUsd - a.totalCostUsd);
  }
  const by = dimension === 'agent' ? ['agent'] as const : ['feature'] as const;
  const rows = await prisma.aiUsageEvent.groupBy({
    by: [...by], where,
    _count: { _all: true },
    _sum: { inputTokens: true, cachedInputTokens: true, outputTokens: true, totalTokens: true, totalCostUsd: true },
    _avg: { totalCostUsd: true, durationMs: true },
  } as any);
  const total = rows.reduce((sum: number, row: any) => sum + Number(row._sum.totalCostUsd ?? 0), 0);
  const statusRows = await prisma.aiUsageEvent.groupBy({ by: [...by, 'status'] as any, where, _count: { _all: true } } as any);
  const statusMap = new Map<string, Record<string, number>>();
  for (const row of statusRows as any[]) {
    const key = String(row[dimension] ?? 'UNATTRIBUTED');
    statusMap.set(key, { ...(statusMap.get(key) ?? {}), [row.status]: row._count._all });
  }
  return (rows as any[]).map((row) => {
    const key = String(row[dimension] ?? 'UNATTRIBUTED');
    const statuses = statusMap.get(key) ?? {};
    const totalCostUsd = Number(row._sum.totalCostUsd ?? 0);
    return {
      [dimension]: key, calls: row._count._all,
      successfulCalls: statuses.SUCCESS ?? 0,
      failedCalls: (statuses.FAILED ?? 0) + (statuses.PARTIAL ?? 0),
      inputTokens: row._sum.inputTokens ?? 0, cachedInputTokens: row._sum.cachedInputTokens ?? 0,
      outputTokens: row._sum.outputTokens ?? 0, totalTokens: row._sum.totalTokens ?? 0,
      averageCostUsd: Number(row._avg.totalCostUsd ?? 0), totalCostUsd,
      spendPercent: total ? totalCostUsd / total * 100 : 0,
      averageDurationMs: Number(row._avg.durationMs ?? 0),
    };
  }).sort((a, b) => b.totalCostUsd - a.totalCostUsd);
}

export async function getActualRevenue(period: CostPeriod & { regionId?: string; planId?: string; userId?: string; userIds?: string[] }) {
  const rows = await prisma.billingTransaction.groupBy({
    by: ['currency'],
    where: {
      status: { in: ['PAID', 'SUCCEEDED', 'SUCCESS', 'COMPLETED'] },
      amountPaid: { gt: 0 },
      paidAt: { gte: period.from, lt: period.to },
      ...(period.regionId ? { regionId: period.regionId } : {}),
      ...(period.userId ? { userId: period.userId } : {}),
      ...(period.userIds ? { userId: { in: period.userIds } } : {}),
      ...(period.planId ? { subscription: { planId: period.planId } } : {}),
    },
    _sum: { amountPaid: true },
    _count: { _all: true },
  });
  const breakdown = rows.map((row) => ({ currency: row.currency.toUpperCase(), amount: (row._sum.amountPaid ?? 0) / 100, transactions: row._count._all }));
  return {
    currencyAggregationSupported: breakdown.length <= 1,
    currency: breakdown.length === 1 ? breakdown[0].currency : null,
    total: breakdown.length === 1 ? breakdown[0].amount : null,
    breakdown,
  };
}

export async function getOverview(filters: CostFilters) {
  const [ai, expenses, revenue] = await Promise.all([
    getAiUsageSummary(filters),
    getPlatformExpenseSummary(filters),
    getActualRevenue(filters),
  ]);
  const revenueUsd = revenue.currency === 'USD' ? revenue.total : null;
  const totalPlatformCostUsd = ai.spendUsd + expenses.totalUsd;
  const contributionProfitUsd = revenueUsd == null ? null : revenueUsd - totalPlatformCostUsd;
  return {
    mode: 'ACTUAL' as const,
    actualRevenue: revenue,
    ai,
    allocatedPlatformCostUsd: expenses.totalUsd,
    totalPlatformCostUsd,
    contributionProfitUsd,
    contributionMarginPercent: revenueUsd && contributionProfitUsd != null ? contributionProfitUsd / revenueUsd * 100 : null,
    allocationBasis: expenses.allocationBasis,
  };
}

export async function getAiSpendTimeline(filters: CostFilters) {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`"createdAt" >= ${filters.from}`,
    Prisma.sql`"createdAt" < ${filters.to}`,
  ];
  if (filters.regionId) conditions.push(Prisma.sql`"regionId" = ${filters.regionId}`);
  if (filters.provider) conditions.push(Prisma.sql`"provider" = ${filters.provider.toUpperCase()}`);
  if (filters.model) conditions.push(Prisma.sql`"model" = ${filters.model}`);
  if (filters.feature) conditions.push(Prisma.sql`"feature" = ${filters.feature}`);
  if (filters.operation) conditions.push(Prisma.sql`"operation" = ${filters.operation}`);
  if (filters.agent) conditions.push(Prisma.sql`"agent" = ${filters.agent}`);
  if (filters.userId) conditions.push(Prisma.sql`"userId" = ${filters.userId}`);
  if (filters.planId) conditions.push(Prisma.sql`EXISTS (
    SELECT 1 FROM "Subscription" subscription
    WHERE subscription."userId" = "AiUsageEvent"."userId"
      AND subscription."planId" = ${filters.planId}
      AND subscription."status" IN ('ACTIVE', 'TRIALING')
  )`);
  const rows = await prisma.$queryRaw<Array<{ day: Date; aiCostUsd: Prisma.Decimal; failedSpendUsd: Prisma.Decimal; requests: bigint; tokens: bigint }>>(Prisma.sql`
    SELECT date_trunc('day', "createdAt") AS day,
           SUM("totalCostUsd") AS "aiCostUsd",
           SUM(CASE WHEN "status" IN ('FAILED', 'PARTIAL') THEN "totalCostUsd" ELSE 0 END) AS "failedSpendUsd",
           COUNT(*) AS requests,
           SUM("totalTokens") AS tokens
    FROM "AiUsageEvent"
    WHERE ${Prisma.join(conditions, ' AND ')}
    GROUP BY date_trunc('day', "createdAt")
    ORDER BY day ASC
  `);
  return rows.map((row) => ({ day: row.day.toISOString(), aiCostUsd: Number(row.aiCostUsd), failedSpendUsd: Number(row.failedSpendUsd), requests: Number(row.requests), tokens: Number(row.tokens) }));
}
