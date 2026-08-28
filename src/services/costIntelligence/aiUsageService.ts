import { AiUsageStatus, Prisma } from '@prisma/client';
import { prisma } from '../../prismaClient';
import { calculateAiCost, normalizeModelName, normalizeProvider, resolveAiModelPricing } from './aiPricingService';

export type RecordAiUsageInput = {
  userId?: string | null;
  regionId?: string | null;
  feature: string;
  operation: string;
  agent?: string | null;
  provider: string;
  model: string;
  requestedModel?: string | null;
  resolvedModel?: string | null;
  generationId?: string | null;
  postId?: string | null;
  batchJobId?: string | null;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  generatedImages?: number;
  requestCount?: number;
  billableSeconds?: number | string | Prisma.Decimal | null;
  status?: AiUsageStatus;
  durationMs?: number;
  providerUsage?: Prisma.InputJsonValue;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
};

function safeInt(value?: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value!)) : 0;
}

function safeDecimal(value: number | string | Prisma.Decimal | null | undefined): Prisma.Decimal | null {
  if (value == null || value === '') return null;
  try {
    const parsed = new Prisma.Decimal(value);
    return parsed.isNegative() ? null : parsed.toDecimalPlaces(4);
  } catch {
    return null;
  }
}

const zeroCosts = () => ({
  inputCostUsd: new Prisma.Decimal(0), cachedInputCostUsd: new Prisma.Decimal(0), outputCostUsd: new Prisma.Decimal(0),
  imageCostUsd: new Prisma.Decimal(0), requestCostUsd: new Prisma.Decimal(0), timeCostUsd: new Prisma.Decimal(0),
  customCostUsd: new Prisma.Decimal(0), totalCostUsd: new Prisma.Decimal(0),
});

/**
 * Records one provider call. Accounting is deliberately fail-open: failures are
 * logged for operators but never replace a successful product response.
 */
export async function recordAiUsage(input: RecordAiUsageInput) {
  const occurredAt = input.occurredAt ?? new Date();
  const inputTokens = safeInt(input.inputTokens);
  const cachedInputTokens = safeInt(input.cachedInputTokens);
  const outputTokens = safeInt(input.outputTokens);
  const generatedImages = safeInt(input.generatedImages);
  const requestCount = input.requestCount == null ? 1 : safeInt(input.requestCount);
  const billableSeconds = safeDecimal(input.billableSeconds);
  const totalTokens = inputTokens + cachedInputTokens + outputTokens;
  try {
    const requestedModel = normalizeModelName(input.provider, input.requestedModel || input.model);
    const resolvedModel = input.resolvedModel ? normalizeModelName(input.provider, input.resolvedModel) : null;
    const storedModel = resolvedModel || normalizeModelName(input.provider, input.model);
    const pricingCandidates = [...new Set([resolvedModel, storedModel, requestedModel].filter((value): value is string => Boolean(value)))];
    let pricing: Awaited<ReturnType<typeof resolveAiModelPricing>> = null;
    let pricingMatchedModel: string | null = null;
    for (const candidate of pricingCandidates) {
      pricing = await resolveAiModelPricing(input.provider, candidate, occurredAt);
      if (pricing) { pricingMatchedModel = candidate; break; }
    }
    let costs = zeroCosts();
    let pricingError: string | null = null;
    if (pricing) {
      try {
        costs = calculateAiCost({
          inputTokens, cachedInputTokens, outputTokens, generatedImages, requestCount, billableSeconds,
          metadata: input.metadata,
        }, pricing);
      } catch (error) {
        pricingError = error instanceof Error ? error.message : String(error);
      }
    }
    const supportsCachedInput = pricing?.pricingType === 'TEXT_TOKENS' || pricing?.pricingType === 'IMAGE';
    const costStatus = !pricing
      ? 'PRICING_MISSING'
      : pricingError
        ? 'PRICING_CONFIGURATION_INVALID'
        : supportsCachedInput && cachedInputTokens > 0 && pricing.cachedInputCostPerMillionTokens == null
          ? 'CACHED_PRICING_MISSING'
          : 'PRICED';
    return await prisma.aiUsageEvent.create({
      data: {
        userId: input.userId ?? null,
        regionId: input.regionId ?? null,
        feature: input.feature,
        operation: input.operation,
        agent: input.agent ?? null,
        provider: normalizeProvider(input.provider),
        model: storedModel,
        requestedModel,
        resolvedModel,
        pricingType: pricing?.pricingType ?? null,
        generationId: input.generationId ?? null,
        postId: input.postId ?? null,
        batchJobId: input.batchJobId ?? null,
        inputTokens,
        cachedInputTokens,
        outputTokens,
        totalTokens,
        generatedImages,
        requestCount,
        billableSeconds,
        ...costs,
        status: input.status ?? AiUsageStatus.SUCCESS,
        durationMs: input.durationMs == null ? null : Math.max(0, Math.trunc(input.durationMs)),
        providerUsage: input.providerUsage,
        metadata: {
          ...(input.metadata ?? {}),
          costStatus,
          pricingError,
          pricingId: pricing?.id ?? null,
          pricingMatchedModel,
          pricingMatchedRequestedAlias: Boolean(pricing && resolvedModel && pricingMatchedModel === requestedModel && resolvedModel !== requestedModel),
          pricingEffectiveFrom: pricing?.effectiveFrom.toISOString() ?? null,
          allocationMode: 'DIRECT',
        } as Prisma.InputJsonValue,
        createdAt: occurredAt,
      },
    });
  } catch (error) {
    console.error('[cost-intelligence] AI usage accounting failed', {
      provider: input.provider,
      model: input.model,
      generationId: input.generationId,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Links one or more pre-persistence generation traces to the post they produced.
 * This is deliberately fail-open for the same reason as usage insertion: cost
 * accounting must never turn a successful product action into an end-user error.
 */
export async function linkAiUsageGenerationsToPost(
  userId: string,
  generationIds: string[],
  postId: string,
): Promise<void> {
  const ids = [...new Set(generationIds.map((id) => id.trim()).filter(Boolean))];
  if (!ids.length) return;

  try {
    await prisma.aiUsageEvent.updateMany({
      where: { userId, generationId: { in: ids }, postId: null },
      data: { postId },
    });
  } catch (error) {
    console.error('[cost-intelligence] generation-to-post linking failed', {
      userId,
      postId,
      generationIds: ids,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
