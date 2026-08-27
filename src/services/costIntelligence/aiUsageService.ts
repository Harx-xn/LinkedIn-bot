import { AiUsageStatus, Prisma } from '@prisma/client';
import { prisma } from '../../prismaClient';
import { calculateTokenCost, normalizeProvider, resolveAiModelPricing } from './aiPricingService';

export type RecordAiUsageInput = {
  userId?: string | null;
  regionId?: string | null;
  feature: string;
  operation: string;
  agent?: string | null;
  provider: string;
  model: string;
  generationId?: string | null;
  postId?: string | null;
  batchJobId?: string | null;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  status?: AiUsageStatus;
  durationMs?: number;
  providerUsage?: Prisma.InputJsonValue;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
};

function safeInt(value?: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value!)) : 0;
}

/**
 * Records one provider call. Accounting is deliberately fail-open: failures are
 * logged for operators but never replace a successful product response.
 */
export async function recordAiUsage(input: RecordAiUsageInput) {
  const occurredAt = input.occurredAt ?? new Date();
  const inputTokens = safeInt(input.inputTokens);
  const cachedInputTokens = safeInt(input.cachedInputTokens);
  const outputTokens = safeInt(input.outputTokens);
  const totalTokens = inputTokens + cachedInputTokens + outputTokens;
  try {
    const pricing = await resolveAiModelPricing(input.provider, input.model, occurredAt);
    const costs = pricing && pricing.pricingUnit === 'TOKENS'
      ? calculateTokenCost({ inputTokens, cachedInputTokens, outputTokens }, pricing)
      : {
          inputCostUsd: new Prisma.Decimal(0),
          cachedInputCostUsd: new Prisma.Decimal(0),
          outputCostUsd: new Prisma.Decimal(0),
          totalCostUsd: new Prisma.Decimal(0),
        };
    const costStatus = !pricing
      ? 'PRICING_MISSING'
      : pricing.pricingUnit !== 'TOKENS'
        ? 'UNSUPPORTED_PRICING_UNIT'
      : cachedInputTokens > 0 && pricing.cachedInputCostPerMillionTokens == null
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
        model: input.model.trim(),
        generationId: input.generationId ?? null,
        postId: input.postId ?? null,
        batchJobId: input.batchJobId ?? null,
        inputTokens,
        cachedInputTokens,
        outputTokens,
        totalTokens,
        ...costs,
        status: input.status ?? AiUsageStatus.SUCCESS,
        durationMs: input.durationMs == null ? null : Math.max(0, Math.trunc(input.durationMs)),
        providerUsage: input.providerUsage,
        metadata: {
          ...(input.metadata ?? {}),
          costStatus,
          pricingId: pricing?.id ?? null,
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
