import { prisma } from '../../prismaClient';
import type { CostProjectionScenario } from '@prisma/client';
import { getAiUsageSummary } from './actualCostService';
import { getPlatformExpenseSummary, normalizedMonthlyExpense } from './platformCostService';

type ProjectionAssumptions = Pick<CostProjectionScenario,
  'name' | 'projectedUsers' | 'monthlyUserGrowthRate' | 'activeUserRate' | 'trialToPaidRate' |
  'monthlyChurnRate' | 'averageAiUsageMultiplier' | 'horizonMonths'>;

function nextMonthStart(date: Date, offset: number) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1));
}

export async function buildForecast(scenario: ProjectionAssumptions, regionId?: string) {
  const baselineTo = new Date();
  const baselineFrom = new Date(baselineTo.getTime() - 90 * 86_400_000);
  const [currentUsers, currentPaidUsers, ai, expenseSummary, planMix] = await Promise.all([
    prisma.user.count({ where: { role: 'USER', ...(regionId ? { regionId } : {}) } }),
    prisma.user.count({ where: { role: 'USER', ...(regionId ? { regionId } : {}), subscriptions: { some: { status: 'ACTIVE' } } } }),
    getAiUsageSummary({ from: baselineFrom, to: baselineTo, regionId }),
    getPlatformExpenseSummary({ from: baselineFrom, to: baselineTo }),
    prisma.subscription.findMany({
      where: { status: 'ACTIVE', ...(regionId ? { regionId } : {}) },
      select: { plan: { select: { price: true, currency: true } } },
    }),
  ]);
  const baselineMonths = 3;
  const aiActiveMonthly = Math.max(1, ai.aiActiveUsers / baselineMonths);
  const aiRequestsPerAiUser = ai.requests / aiActiveMonthly / baselineMonths;
  const aiCostPerActiveUser = ai.spendUsd / aiActiveMonthly / baselineMonths;
  const allUsdPlans = planMix.every((subscription) => subscription.plan.currency.toUpperCase() === 'USD');
  const averagePlanPriceUsd = allUsdPlans && planMix.length
    ? planMix.reduce((sum, subscription) => sum + subscription.plan.price, 0) / planMix.length
    : null;
  const normalizedExpenses = expenseSummary.items
    .map((expense) => normalizedMonthlyExpense(expense as any))
    .filter((value): value is number => value != null);
  const monthlyPlatformCost = normalizedExpenses.reduce((sum, amount) => sum + amount, 0);
  const variableShare = expenseSummary.items
    .filter((expense) => expense.type === 'VARIABLE')
    .reduce((sum, expense) => sum + (normalizedMonthlyExpense(expense as any) ?? 0), 0);
  const fixedMonthlyCost = Math.max(0, monthlyPlatformCost - variableShare);
  const variableCostPerActiveUser = variableShare / Math.max(1, currentUsers * scenario.activeUserRate);

  let registeredUsers = scenario.projectedUsers || currentUsers;
  let paidUsers = Math.min(registeredUsers, currentPaidUsers);
  const points = [];
  for (let month = 1; month <= scenario.horizonMonths; month++) {
    registeredUsers *= 1 + scenario.monthlyUserGrowthRate;
    const activeUsers = registeredUsers * scenario.activeUserRate;
    const converted = Math.max(0, registeredUsers - paidUsers) * scenario.trialToPaidRate;
    paidUsers = Math.min(registeredUsers, paidUsers * (1 - scenario.monthlyChurnRate) + converted);
    const trialUsers = Math.max(0, registeredUsers - paidUsers);
    const aiRequests = activeUsers * aiRequestsPerAiUser * scenario.averageAiUsageMultiplier;
    const aiCost = activeUsers * aiCostPerActiveUser * scenario.averageAiUsageMultiplier;
    const allocatedPlatformCost = fixedMonthlyCost + activeUsers * variableCostPerActiveUser;
    const totalPlatformCost = aiCost + allocatedPlatformCost;
    const projectedRevenue = averagePlanPriceUsd == null ? null : paidUsers * averagePlanPriceUsd;
    const projectedContributionProfit = projectedRevenue == null ? null : projectedRevenue - totalPlatformCost;
    points.push({
      month: nextMonthStart(baselineTo, month).toISOString(),
      registeredUsers: Math.round(registeredUsers), activeUsers: Math.round(activeUsers),
      paidUsers: Math.round(paidUsers), trialUsers: Math.round(trialUsers), aiRequests: Math.round(aiRequests),
      aiCostUsd: aiCost, allocatedPlatformCostUsd: allocatedPlatformCost, totalPlatformCostUsd: totalPlatformCost,
      projectedRevenueUsd: projectedRevenue, projectedContributionProfitUsd: projectedContributionProfit,
      projectedMarginPercent: projectedRevenue && projectedContributionProfit != null ? projectedContributionProfit / projectedRevenue * 100 : null,
    });
  }
  return {
    mode: 'FORECAST' as const,
    scenario: { ...scenario },
    baseline: { from: baselineFrom.toISOString(), to: baselineTo.toISOString(), currentUsers, currentPaidUsers, aiRequestsPerAiUser, aiCostPerActiveUser },
    revenueCurrencySupported: averagePlanPriceUsd != null,
    points,
  };
}

