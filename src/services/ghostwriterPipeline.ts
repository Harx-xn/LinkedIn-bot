import { ContentService } from './contentService';
import type { AuthorContext, BatchPostPlan, RankedTrendCandidate, TrendCandidate } from './generationTypes';
import { summarizeBatchPlan, buildTopicDiverseBatchPlan } from './ghostwriterBatchPlanner';
import type { Trend } from './trendsService';
import {
  generateSlotPost as generateSlotPostImpl,
  generateSlotPostUntilSuccess as generateSlotPostUntilSuccessImpl,
  type GeneratedSlotResult,
} from './ghostwriterGenerationService';
import { TrendOrchestrationService } from './trendOrchestrationService';
import { validatePlanTopicDiversity } from './trendDiversityService';

export type { GeneratedSlotResult };

import type { BotImageMode } from './botImageModeService';
import type { EffectiveBotStrategy } from './botStrategyService';

export type GhostwriterBotConfig = {
  tone?: string | null;
  description?: string | null;
  niches: string[];
  imageMode?: BotImageMode | null;
  backgroundImageUrl?: string | null;
  imageInstructions?: string | null;
  imageStyle?: string | null;
  imageAspectRatio?: string | null;
  brandLogoUrl?: string | null;
  brandLogoEnabled?: boolean;
  brandLogoPosition?: string | null;
  contactInfo?: string | null;
  websiteUrl?: string | null;
  includeContactInfo?: boolean;
  includeWebsiteLink?: boolean;
  strategy?: EffectiveBotStrategy;
};

function toTrendCandidates(trends: Trend[], niche?: string): TrendCandidate[] {
  return trends.map((t) => ({
    topic: t.title,
    link: t.link,
    source: t.source,
    publishedAt: t.pubDate,
    niche: t.niche ?? niche,
    searchQuery: t.searchQuery,
    summary: t.summary,
    keyPoints: t.keyPoints,
    fingerprint: undefined,
  }));
}

/** @deprecated Use prepareBatchContextV2 for topic-diverse selection */
export async function prepareBatchContext(
  nicheTrendsMap: Record<string, Trend[]>,
  niches: string[],
  config: GhostwriterBotConfig,
  slotCount: number,
) {
  const author: AuthorContext = {
    description: config.strategy?.profilePositioning.positioningStatement || config.description || '',
    tone: config.strategy?.writingStyle.tone[0] || config.tone || 'Professional',
    niches,
    targetAudience: config.strategy
      ? [
          config.strategy.targetAudience.primaryAudience,
          ...(config.strategy.targetAudience.secondaryAudiences ?? []),
        ].filter(Boolean)
      : undefined,
    strategy: config.strategy,
  };

  const allCandidates: TrendCandidate[] = [];
  for (const niche of niches) {
    allCandidates.push(...toTrendCandidates(nicheTrendsMap[niche] ?? [], niche));
  }

  return { author, eligible: allCandidates.slice(0, slotCount), ranked: [] as RankedTrendCandidate[] };
}

export async function prepareBatchContextV2(params: {
  userId: string;
  niches: string[];
  config: GhostwriterBotConfig;
  slotCount: number;
  sources: string[];
  openaiApiKey?: string | null;
  previewId?: string;
  configHash?: string;
}) {
  const author: AuthorContext = {
    description: params.config.strategy?.profilePositioning.positioningStatement || params.config.description || '',
    tone: params.config.strategy?.writingStyle.tone[0] || params.config.tone || 'Professional',
    niches: params.niches,
    targetAudience: params.config.strategy
      ? [
          params.config.strategy.targetAudience.primaryAudience,
          ...(params.config.strategy.targetAudience.secondaryAudiences ?? []),
        ].filter(Boolean)
      : undefined,
    strategy: params.config.strategy,
  };

  const orchestrator = new TrendOrchestrationService(params.openaiApiKey);

  if (params.previewId && params.configHash) {
    const { getTrendPreviewPool } = await import('./trendPreviewPoolStore');
    const stored = getTrendPreviewPool(params.previewId, params.userId, params.configHash);
    if (stored.ok && stored.pool.candidates.length >= params.slotCount) {
      const upgraded = await orchestrator.upgradeStoredPreviewPool({
        userId: params.userId,
        previewCandidates: stored.pool.candidates,
        author,
        strategy: params.config.strategy,
        plans: [],
        slotCount: params.slotCount,
      });
      console.info({
        event: 'trend_generation_reused_preview_pool',
        userId: params.userId,
        previewId: params.previewId,
        candidateCount: stored.pool.candidates.length,
        openAiCalls: upgraded.openAiCalls,
      });
      return {
        author,
        eligible: upgraded.eligible,
        ranked: upgraded.ranked,
        stats: {
          rawCount: stored.pool.candidates.length,
          rejectedLowValue: 0,
          rejectedByExclusions: 0,
          exactDuplicatesRemoved: 0,
          nearDuplicatesRemoved: 0,
          historyMatchesRemoved: 0,
          fingerprinted: upgraded.openAiCalls,
          selected: upgraded.ranked.length,
          evergreenFilled: 0,
          openAiCalls: upgraded.openAiCalls,
        },
      };
    }
    console.warn('[prepareBatchContextV2] preview pool unavailable; using full generation fetch', {
      userId: params.userId,
      previewId: params.previewId,
      reason: stored.ok ? 'insufficient_candidates' : stored.reason,
    });
  }

  const pool = await orchestrator.buildTrendPoolForBatch({
    userId: params.userId,
    niches: params.niches,
    author,
    strategy: params.config.strategy,
    sources: params.sources,
    slotCount: params.slotCount,
    mode: 'generation',
  });

  return { author, eligible: pool.eligible, ranked: pool.ranked, stats: pool.stats };
}

export async function generateSlotPost(
  contentService: ContentService,
  plan: BatchPostPlan,
  trend: TrendCandidate | null,
  author: AuthorContext,
  config: GhostwriterBotConfig,
  acceptedBodies: string[],
  provider: 'OPENAI' | 'GEMINI' = 'OPENAI',
  options?: {
    batchFingerprints?: import('./generationTypes').TopicFingerprint[];
    recentTopicHistory?: import('./topicHistoryService').TopicHistoryRow[];
  },
): Promise<GeneratedSlotResult> {
  return generateSlotPostImpl(
    contentService,
    plan,
    trend,
    author,
    config,
    acceptedBodies,
    provider,
    options,
  );
}

export async function generateSlotPostUntilSuccess(
  contentService: ContentService,
  plan: BatchPostPlan,
  trend: TrendCandidate | null,
  author: AuthorContext,
  config: GhostwriterBotConfig,
  acceptedBodies: string[],
  provider: 'OPENAI' | 'GEMINI' = 'OPENAI',
  options?: {
    batchFingerprints?: import('./generationTypes').TopicFingerprint[];
    recentTopicHistory?: import('./topicHistoryService').TopicHistoryRow[];
  },
) {
  return generateSlotPostUntilSuccessImpl(
    contentService,
    plan,
    trend,
    author,
    config,
    acceptedBodies,
    provider,
    options,
  );
}

export async function planBatchForGeneration(
  contentService: ContentService,
  eligible: TrendCandidate[],
  author: AuthorContext,
  count: number,
  provider: 'OPENAI' | 'GEMINI' = 'OPENAI',
  ranked?: RankedTrendCandidate[],
) {
  if (ranked?.length) {
    const plan = buildTopicDiverseBatchPlan(ranked.slice(0, count), count);
    const diversityIssues = validatePlanTopicDiversity(plan);
    if (diversityIssues.length) {
      console.warn('[ghostwriter] batch plan diversity warnings', { issues: diversityIssues });
    }
    console.log('[ghostwriter] batch plan', summarizeBatchPlan(plan, author));
    return plan;
  }

  const plan = await contentService.planBatch(eligible, author, count, provider);
  console.log('[ghostwriter] batch plan', summarizeBatchPlan(plan, author));
  return plan;
}
