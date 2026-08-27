import { Prisma } from '@prisma/client';
import { prisma } from '../../prismaClient';

const MILLION = new Prisma.Decimal(1_000_000);

export type TokenCostInput = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

export type TokenPricing = {
  inputCostPerMillionTokens: Prisma.Decimal | string | number;
  cachedInputCostPerMillionTokens?: Prisma.Decimal | string | number | null;
  outputCostPerMillionTokens: Prisma.Decimal | string | number;
  pricingUnit?: string;
};

export function normalizeProvider(provider: string): string {
  return provider.trim().toUpperCase();
}

export function calculateTokenCost(usage: TokenCostInput, pricing: TokenPricing) {
  if ((pricing.pricingUnit ?? 'TOKENS') !== 'TOKENS') {
    throw new Error(`Unsupported AI pricing unit: ${pricing.pricingUnit}`);
  }
  const inputTokens = Math.max(0, Math.trunc(usage.inputTokens || 0));
  const cachedInputTokens = Math.max(0, Math.trunc(usage.cachedInputTokens || 0));
  const outputTokens = Math.max(0, Math.trunc(usage.outputTokens || 0));
  const inputCostUsd = new Prisma.Decimal(inputTokens)
    .div(MILLION)
    .mul(pricing.inputCostPerMillionTokens)
    .toDecimalPlaces(8);
  const cachedInputCostUsd = pricing.cachedInputCostPerMillionTokens == null
    ? new Prisma.Decimal(0)
    : new Prisma.Decimal(cachedInputTokens)
      .div(MILLION)
      .mul(pricing.cachedInputCostPerMillionTokens)
      .toDecimalPlaces(8);
  const outputCostUsd = new Prisma.Decimal(outputTokens)
    .div(MILLION)
    .mul(pricing.outputCostPerMillionTokens)
    .toDecimalPlaces(8);
  return {
    inputCostUsd,
    cachedInputCostUsd,
    outputCostUsd,
    totalCostUsd: inputCostUsd.plus(cachedInputCostUsd).plus(outputCostUsd).toDecimalPlaces(8),
  };
}

export async function resolveAiModelPricing(provider: string, model: string, at = new Date()) {
  return prisma.aiModelPricing.findFirst({
    where: {
      provider: normalizeProvider(provider),
      model: model.trim(),
      active: true,
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
    },
    orderBy: { effectiveFrom: 'desc' },
  });
}

export async function assertPricingWindowAvailable(input: {
  provider: string;
  model: string;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  excludeId?: string;
}) {
  if (input.effectiveTo && input.effectiveTo <= input.effectiveFrom) {
    throw new Error('Effective to must be later than effective from');
  }
  const overlap = await prisma.aiModelPricing.findFirst({
    where: {
      provider: normalizeProvider(input.provider),
      model: input.model.trim(),
      active: true,
      ...(input.excludeId ? { id: { not: input.excludeId } } : {}),
      effectiveFrom: { lt: input.effectiveTo ?? new Date('9999-12-31T23:59:59.999Z') },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: input.effectiveFrom } }],
    },
    select: { id: true },
  });
  if (overlap) throw new Error('An active pricing version already covers part of this effective period');
}

