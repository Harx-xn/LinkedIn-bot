import { Prisma } from '@prisma/client';
import { prisma } from '../../prismaClient';

export type ScenarioInput = {
  name: string;
  projectedUsers: number;
  monthlyUserGrowthRate: number;
  activeUserRate: number;
  trialToPaidRate: number;
  monthlyChurnRate: number;
  averageAiUsageMultiplier?: number;
  horizonMonths?: number;
  assumptions?: Prisma.InputJsonValue;
};

const allowedHorizons = new Set([3, 6, 12, 24]);

export function validateScenarioInput(input: ScenarioInput): ScenarioInput & Required<Pick<ScenarioInput, 'averageAiUsageMultiplier' | 'horizonMonths'>> {
  const name = input.name?.trim();
  if (!name) throw new Error('Scenario name is required');
  const projectedUsers = Math.max(0, Math.trunc(input.projectedUsers));
  const horizonMonths = Math.trunc(input.horizonMonths ?? 12);
  if (!allowedHorizons.has(horizonMonths)) throw new Error('Forecast horizon must be 3, 6, 12, or 24 months');
  for (const [key, value] of Object.entries({
    monthlyUserGrowthRate: input.monthlyUserGrowthRate,
    activeUserRate: input.activeUserRate,
    trialToPaidRate: input.trialToPaidRate,
    monthlyChurnRate: input.monthlyChurnRate,
  })) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${key} must be between 0 and 1`);
  }
  const averageAiUsageMultiplier = input.averageAiUsageMultiplier ?? 1;
  if (!Number.isFinite(averageAiUsageMultiplier) || averageAiUsageMultiplier < 0) throw new Error('AI usage multiplier must be zero or greater');
  return { ...input, name, projectedUsers, horizonMonths, averageAiUsageMultiplier };
}

export async function createScenario(input: ScenarioInput, createdByUserId?: string) {
  const value = validateScenarioInput(input);
  return prisma.costProjectionScenario.create({ data: { ...value, createdByUserId } });
}

export async function updateScenario(id: string, input: ScenarioInput) {
  const value = validateScenarioInput(input);
  return prisma.costProjectionScenario.update({ where: { id }, data: value });
}
