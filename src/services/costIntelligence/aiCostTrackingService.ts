import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { AiUsageStatus, Prisma } from '@prisma/client';
import { recordAiUsage } from './aiUsageService';

export type AiCostContext = {
  userId?: string | null;
  regionId?: string | null;
  feature?: string;
  operation?: string;
  agent?: string | null;
  generationId?: string | null;
  postId?: string | null;
  batchJobId?: string | null;
  metadata?: Record<string, unknown>;
};

export type ProviderTokenUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  raw?: Prisma.InputJsonValue;
};

const contextStorage = new AsyncLocalStorage<AiCostContext>();

export function createGenerationId(): string {
  return `gen_${randomUUID().replace(/-/g, '')}`;
}

export function getAiCostContext(): AiCostContext {
  return contextStorage.getStore() ?? {};
}

export function withAiCostContext<T>(context: AiCostContext, callback: () => T): T {
  const parent = getAiCostContext();
  return contextStorage.run({
    ...parent,
    ...context,
    metadata: { ...(parent.metadata ?? {}), ...(context.metadata ?? {}) },
  }, callback);
}

export function extractOpenAiUsage(response: any): ProviderTokenUsage {
  const usage = response?.usage ?? {};
  const cached = Number(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? 0);
  const reportedInput = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  return {
    inputTokens: Math.max(0, reportedInput - cached),
    cachedInputTokens: Math.max(0, cached),
    outputTokens: Math.max(0, Number(usage.completion_tokens ?? usage.output_tokens ?? 0)),
    raw: usage as Prisma.InputJsonValue,
  };
}

export function extractGeminiUsage(response: any): ProviderTokenUsage {
  const usage = response?.usageMetadata ?? response?.response?.usageMetadata ?? {};
  const cached = Number(usage.cachedContentTokenCount ?? 0);
  const reportedInput = Number(usage.promptTokenCount ?? 0);
  return {
    inputTokens: Math.max(0, reportedInput - cached),
    cachedInputTokens: Math.max(0, cached),
    outputTokens: Math.max(0, Number(usage.candidatesTokenCount ?? 0)),
    raw: usage as Prisma.InputJsonValue,
  };
}

function usageFromProviderError(error: any): ProviderTokenUsage {
  if (error?.usage?.prompt_tokens != null || error?.usage?.input_tokens != null) {
    return extractOpenAiUsage(error);
  }
  if (error?.usageMetadata || error?.response?.usageMetadata) return extractGeminiUsage(error);
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
}

export async function trackAiProviderCall<T>(input: {
  provider: string;
  model: string;
  invoke: () => Promise<T>;
  extractUsage: (result: T) => ProviderTokenUsage;
  identity?: AiCostContext;
  metadata?: Record<string, unknown>;
}): Promise<T> {
  const startedAt = new Date();
  const started = Date.now();
  const context = { ...(input.identity ?? {}), ...getAiCostContext() };
  try {
    const result = await input.invoke();
    const usage = input.extractUsage(result);
    await recordAiUsage({
      userId: context.userId,
      regionId: context.regionId,
      feature: context.feature ?? 'UNATTRIBUTED',
      operation: context.operation ?? 'UNATTRIBUTED',
      agent: context.agent,
      provider: input.provider,
      model: input.model,
      generationId: context.generationId,
      postId: context.postId,
      batchJobId: context.batchJobId,
      ...usage,
      providerUsage: usage.raw,
      status: AiUsageStatus.SUCCESS,
      durationMs: Date.now() - started,
      metadata: { ...(context.metadata ?? {}), ...(input.metadata ?? {}), usageAvailable: Boolean(usage.raw) },
      occurredAt: startedAt,
    });
    return result;
  } catch (error) {
    const usage = usageFromProviderError(error);
    await recordAiUsage({
      userId: context.userId,
      regionId: context.regionId,
      feature: context.feature ?? 'UNATTRIBUTED',
      operation: context.operation ?? 'UNATTRIBUTED',
      agent: context.agent,
      provider: input.provider,
      model: input.model,
      generationId: context.generationId,
      postId: context.postId,
      batchJobId: context.batchJobId,
      ...usage,
      providerUsage: usage.raw,
      status: AiUsageStatus.FAILED,
      durationMs: Date.now() - started,
      metadata: {
        ...(context.metadata ?? {}),
        ...(input.metadata ?? {}),
        usageAvailable: Boolean(usage.raw),
        providerError: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      },
      occurredAt: startedAt,
    });
    throw error;
  }
}
