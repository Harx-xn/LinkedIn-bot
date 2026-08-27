import { PlatformExpense, PlatformExpenseCycle } from '@prisma/client';
import { prisma } from '../../prismaClient';

const DAY_MS = 86_400_000;
const AVG_MONTH_DAYS = 365.2425 / 12;

export type CostPeriod = { from: Date; to: Date };

export function normalizedMonthlyExpense(expense: Pick<PlatformExpense, 'amountUsd' | 'billingCycle'>): number | null {
  const amount = Number(expense.amountUsd);
  if (expense.billingCycle === PlatformExpenseCycle.MONTHLY) return amount;
  if (expense.billingCycle === PlatformExpenseCycle.YEARLY) return amount / 12;
  return null;
}

function overlapDays(expense: Pick<PlatformExpense, 'effectiveFrom' | 'effectiveTo'>, period: CostPeriod): number {
  const start = Math.max(expense.effectiveFrom.getTime(), period.from.getTime());
  const end = Math.min(expense.effectiveTo?.getTime() ?? period.to.getTime(), period.to.getTime());
  return Math.max(0, end - start) / DAY_MS;
}

export function expenseCostForPeriod(expense: PlatformExpense, period: CostPeriod): number {
  if (expense.billingCycle === PlatformExpenseCycle.ONE_TIME) {
    return expense.effectiveFrom >= period.from && expense.effectiveFrom < period.to
      ? Number(expense.amountUsd)
      : 0;
  }
  const days = overlapDays(expense, period);
  if (!days) return 0;
  if (expense.billingCycle === PlatformExpenseCycle.MONTHLY) {
    return Number(expense.amountUsd) * days / AVG_MONTH_DAYS;
  }
  if (expense.billingCycle === PlatformExpenseCycle.YEARLY) {
    return Number(expense.amountUsd) * days / 365.2425;
  }
  // USAGE rows are actual variable expenses for their effective window.
  return Number(expense.amountUsd);
}

export async function getPlatformExpenseSummary(period: CostPeriod) {
  const expenses = await prisma.platformExpense.findMany({
    where: {
      active: true,
      effectiveFrom: { lt: period.to },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: period.from } }],
    },
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
  });
  const rules = await prisma.costAllocationRule.findMany({ where: { active: true } });
  const ruleByCategory = new Map(rules.map((rule) => [rule.expenseCategory, rule.allocationMethod]));
  const items = expenses.map((expense) => ({
    ...expense,
    amountUsd: Number(expense.amountUsd),
    normalizedMonthlyUsd: normalizedMonthlyExpense(expense),
    periodCostUsd: expenseCostForPeriod(expense, period),
    allocationMethod: ruleByCategory.get(expense.category) ?? 'ACTIVE_USERS',
    allocationBasis: 'CURRENT_RULE_RECOMPUTATION' as const,
  }));
  return {
    items,
    totalUsd: items.reduce((sum, item) => sum + item.periodCostUsd, 0),
    allocationBasis: 'CURRENT_RULE_RECOMPUTATION' as const,
  };
}

