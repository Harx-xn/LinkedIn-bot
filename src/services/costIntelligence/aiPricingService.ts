import { AiPricingType, Prisma } from '@prisma/client';
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

export type AiBillableUsage = TokenCostInput & {
  generatedImages: number;
  requestCount: number;
  billableSeconds: Prisma.Decimal | string | number | null;
  metadata?: Record<string, unknown>;
};

export type AiPricingConfiguration = {
  pricingType: AiPricingType | string;
  inputCostPerMillionTokens?: Prisma.Decimal | string | number | null;
  cachedInputCostPerMillionTokens?: Prisma.Decimal | string | number | null;
  outputCostPerMillionTokens?: Prisma.Decimal | string | number | null;
  imageOutputCost?: Prisma.Decimal | string | number | null;
  imageOutputUnit?: string | null;
  costPerRequest?: Prisma.Decimal | string | number | null;
  costPerSecond?: Prisma.Decimal | string | number | null;
  metadata?: unknown;
};

export type AiCostBreakdown = {
  inputCostUsd: Prisma.Decimal;
  cachedInputCostUsd: Prisma.Decimal;
  outputCostUsd: Prisma.Decimal;
  imageCostUsd: Prisma.Decimal;
  requestCostUsd: Prisma.Decimal;
  timeCostUsd: Prisma.Decimal;
  customCostUsd: Prisma.Decimal;
  totalCostUsd: Prisma.Decimal;
};

const ZERO = new Prisma.Decimal(0);
const money = (value: Prisma.Decimal.Value) => new Prisma.Decimal(value).toDecimalPlaces(8);
const tokenComponent = (tokens: number, price: Prisma.Decimal.Value | null | undefined) => price == null
  ? ZERO
  : new Prisma.Decimal(Math.max(0, Math.trunc(tokens || 0))).div(MILLION).mul(price).toDecimalPlaces(8);

function emptyCostBreakdown(): AiCostBreakdown {
  return {
    inputCostUsd: ZERO, cachedInputCostUsd: ZERO, outputCostUsd: ZERO,
    imageCostUsd: ZERO, requestCostUsd: ZERO, timeCostUsd: ZERO, customCostUsd: ZERO,
    totalCostUsd: ZERO,
  };
}

function pricingMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function normalizeProvider(provider: string): string {
  return provider.trim().toUpperCase();
}

export function normalizeModelName(provider: string, model: string): string {
  const value = model.trim();
  return normalizeProvider(provider) === 'GEMINI' ? value.replace(/^models\//, '') : value;
}

export function normalizeImageOutputUnit(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().toUpperCase().replace(/[\s-]+/g, '_');
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

/** Central multi-unit calculator. No component is inferred from another unit. */
export function calculateAiCost(usage: AiBillableUsage, pricing: AiPricingConfiguration): AiCostBreakdown {
  const result = emptyCostBreakdown();
  const type = pricing.pricingType as AiPricingType;
  if (type === AiPricingType.TEXT_TOKENS) {
    if (pricing.inputCostPerMillionTokens == null || pricing.outputCostPerMillionTokens == null) {
      throw new Error('TEXT_TOKENS pricing requires input and output token prices');
    }
    const tokenCosts = calculateTokenCost(usage, {
      inputCostPerMillionTokens: pricing.inputCostPerMillionTokens,
      cachedInputCostPerMillionTokens: pricing.cachedInputCostPerMillionTokens,
      outputCostPerMillionTokens: pricing.outputCostPerMillionTokens,
    });
    Object.assign(result, tokenCosts);
  } else if (type === AiPricingType.IMAGE) {
    if (pricing.imageOutputCost == null || !pricing.imageOutputUnit) throw new Error('IMAGE pricing requires image output cost and unit');
    const imageOutputUnit = normalizeImageOutputUnit(pricing.imageOutputUnit);
    if (imageOutputUnit !== 'PER_IMAGE') throw new Error(`Unsupported image output unit: ${pricing.imageOutputUnit}`);
    result.inputCostUsd = tokenComponent(usage.inputTokens, pricing.inputCostPerMillionTokens);
    result.cachedInputCostUsd = tokenComponent(usage.cachedInputTokens, pricing.cachedInputCostPerMillionTokens);
    result.imageCostUsd = money(new Prisma.Decimal(Math.max(0, Math.trunc(usage.generatedImages || 0))).mul(pricing.imageOutputCost));
  } else if (type === AiPricingType.PER_REQUEST) {
    if (pricing.costPerRequest == null) throw new Error('PER_REQUEST pricing requires cost per request');
    result.requestCostUsd = money(new Prisma.Decimal(Math.max(0, Math.trunc(usage.requestCount || 0))).mul(pricing.costPerRequest));
  } else if (type === AiPricingType.PER_SECOND) {
    if (pricing.costPerSecond == null) throw new Error('PER_SECOND pricing requires cost per second');
    result.timeCostUsd = money(new Prisma.Decimal(usage.billableSeconds ?? 0).mul(pricing.costPerSecond));
  } else if (type === AiPricingType.CUSTOM) {
    const config = pricingMetadata(pricing.metadata);
    if (config.customHandler === 'FIXED_PER_EVENT') {
      if (typeof config.costUsd !== 'number' || !Number.isFinite(config.costUsd) || config.costUsd < 0) throw new Error('CUSTOM FIXED_PER_EVENT requires non-negative metadata.costUsd');
      result.customCostUsd = money(config.costUsd);
    } else if (config.customHandler === 'METADATA_UNITS') {
      const key = typeof config.usageMetadataKey === 'string' ? config.usageMetadataKey : '';
      const costPerUnit = Number(config.costPerUnit);
      const units = Number(usage.metadata?.[key]);
      if (!key || !Number.isFinite(costPerUnit) || costPerUnit < 0) throw new Error('CUSTOM METADATA_UNITS requires usageMetadataKey and non-negative costPerUnit');
      if (!Number.isFinite(units) || units < 0) throw new Error(`CUSTOM usage metadata is missing a non-negative ${key}`);
      result.customCostUsd = money(new Prisma.Decimal(units).mul(costPerUnit));
    } else {
      throw new Error('Unsupported CUSTOM pricing handler');
    }
  } else {
    throw new Error(`Unsupported AI pricing type: ${String(type)}`);
  }
  result.totalCostUsd = money(
    result.inputCostUsd.plus(result.cachedInputCostUsd).plus(result.outputCostUsd)
      .plus(result.imageCostUsd).plus(result.requestCostUsd).plus(result.timeCostUsd).plus(result.customCostUsd),
  );
  return result;
}

export function validatePricingConfiguration(pricing: AiPricingConfiguration): string[] {
  const errors: string[] = [];
  const has = (value: unknown) => value !== null && value !== undefined && value !== '';
  const reject = (fields: Array<[string, unknown]>) => fields.forEach(([name, value]) => { if (has(value)) errors.push(`${name} is not valid for ${pricing.pricingType} pricing`); });
  if (pricing.pricingType === AiPricingType.TEXT_TOKENS) {
    if (!has(pricing.inputCostPerMillionTokens)) errors.push('Input cost per 1M tokens is required');
    if (!has(pricing.outputCostPerMillionTokens)) errors.push('Output cost per 1M tokens is required');
    reject([['Image output cost', pricing.imageOutputCost], ['Image output unit', pricing.imageOutputUnit], ['Cost per request', pricing.costPerRequest], ['Cost per second', pricing.costPerSecond]]);
  } else if (pricing.pricingType === AiPricingType.IMAGE) {
    if (!has(pricing.imageOutputCost)) errors.push('Image output cost is required');
    const imageOutputUnit = normalizeImageOutputUnit(pricing.imageOutputUnit);
    if (!imageOutputUnit) errors.push('Image output unit is required');
    else if (imageOutputUnit !== 'PER_IMAGE') errors.push('Image output unit must be PER_IMAGE');
    reject([['Output token cost', pricing.outputCostPerMillionTokens], ['Cost per request', pricing.costPerRequest], ['Cost per second', pricing.costPerSecond]]);
  } else if (pricing.pricingType === AiPricingType.PER_REQUEST) {
    if (!has(pricing.costPerRequest)) errors.push('Cost per request is required');
    reject([['Input token cost', pricing.inputCostPerMillionTokens], ['Cached input cost', pricing.cachedInputCostPerMillionTokens], ['Output token cost', pricing.outputCostPerMillionTokens], ['Image output cost', pricing.imageOutputCost], ['Image output unit', pricing.imageOutputUnit], ['Cost per second', pricing.costPerSecond]]);
  } else if (pricing.pricingType === AiPricingType.PER_SECOND) {
    if (!has(pricing.costPerSecond)) errors.push('Cost per second is required');
    reject([['Input token cost', pricing.inputCostPerMillionTokens], ['Cached input cost', pricing.cachedInputCostPerMillionTokens], ['Output token cost', pricing.outputCostPerMillionTokens], ['Image output cost', pricing.imageOutputCost], ['Image output unit', pricing.imageOutputUnit], ['Cost per request', pricing.costPerRequest]]);
  } else if (pricing.pricingType === AiPricingType.CUSTOM) {
    reject([['Input token cost', pricing.inputCostPerMillionTokens], ['Cached input cost', pricing.cachedInputCostPerMillionTokens], ['Output token cost', pricing.outputCostPerMillionTokens], ['Image output cost', pricing.imageOutputCost], ['Image output unit', pricing.imageOutputUnit], ['Cost per request', pricing.costPerRequest], ['Cost per second', pricing.costPerSecond]]);
    const config = pricingMetadata(pricing.metadata);
    if (config.customHandler === 'FIXED_PER_EVENT') {
      if (typeof config.costUsd !== 'number' || !Number.isFinite(config.costUsd) || config.costUsd < 0) errors.push('CUSTOM FIXED_PER_EVENT requires non-negative metadata.costUsd');
    } else if (config.customHandler === 'METADATA_UNITS') {
      if (typeof config.usageMetadataKey !== 'string' || !config.usageMetadataKey.trim()) errors.push('CUSTOM METADATA_UNITS requires metadata.usageMetadataKey');
      if (!Number.isFinite(Number(config.costPerUnit)) || Number(config.costPerUnit) < 0) errors.push('CUSTOM METADATA_UNITS requires non-negative metadata.costPerUnit');
    } else errors.push('CUSTOM requires metadata.customHandler of FIXED_PER_EVENT or METADATA_UNITS');
  } else errors.push('Unsupported pricing type');
  return errors;
}

export async function resolveAiModelPricing(provider: string, model: string, at = new Date()) {
  return prisma.aiModelPricing.findFirst({
    where: {
      provider: normalizeProvider(provider),
      model: normalizeModelName(provider, model),
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
      model: normalizeModelName(input.provider, input.model),
      active: true,
      ...(input.excludeId ? { id: { not: input.excludeId } } : {}),
      effectiveFrom: { lt: input.effectiveTo ?? new Date('9999-12-31T23:59:59.999Z') },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: input.effectiveFrom } }],
    },
    select: { id: true },
  });
  if (overlap) throw new Error('An active pricing version already covers part of this effective period');
}
