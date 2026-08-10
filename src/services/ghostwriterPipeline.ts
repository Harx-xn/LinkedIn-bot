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
import { BatchScheduleError } from './batchScheduleService';
import { combineFreshAndInventoryTopics, inventoryFingerprint, reserveValidInventoryTopics, storeQualifiedTopics, unselectedQualifiedTopics } from './topicInventoryService';

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
    tone: config.strategy?.writingStyle.tone[0] || config.tone || 'Conversational',
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
  allowPartial?: boolean;
  generationJobId?: string;
}) {
  const requireCompleteTrendPool = <T extends { ranked: RankedTrendCandidate[]; eligible: TrendCandidate[] }>(pool: T): T => {
    if (!params.allowPartial && (pool.ranked.length < params.slotCount || pool.eligible.length < params.slotCount)) {
      console.warn('[ghostwriter] insufficient qualified trends for requested batch', {
        userId: params.userId,
        requested: params.slotCount,
        qualified: Math.min(pool.ranked.length, pool.eligible.length),
      });
      throw new BatchScheduleError(
        'No quality topics found. Retry or preview trends.',
      );
    }
    return pool;
  };
  const author: AuthorContext = {
    description: params.config.strategy?.profilePositioning.positioningStatement || params.config.description || '',
    tone: params.config.strategy?.writingStyle.tone[0] || params.config.tone || 'Conversational',
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

  // Preview pools remain cached for preview UX, but generation always performs
  // a new provider search before history and novelty filtering.
  void params.previewId;
  void params.configHash;

  const pool = await orchestrator.buildTrendPoolForBatch({
    userId: params.userId,
    niches: params.niches,
    author,
    strategy: params.config.strategy,
    sources: params.sources,
    slotCount: params.slotCount,
    mode: 'generation',
  });

  const freshSelected = pool.ranked;
  const inventorySelected = freshSelected.length < params.slotCount
    ? await reserveValidInventoryTopics({
        userId: params.userId,
        generationJobId: params.generationJobId ?? `batch-${params.userId}-${Date.now()}`,
        count: params.slotCount - freshSelected.length,
        activeNiches: params.niches,
        selectedFreshTopics: freshSelected,
        activeProfileFingerprints: new Map(pool.expansionPlans.map((plan) => [plan.niche, plan.inputFingerprint ?? ''])),
      })
    : [];
  const combinedSelection = combineFreshAndInventoryTopics(freshSelected, inventorySelected, params.slotCount);
  const selected = combinedSelection.selected;
  const freshQualified = pool.qualifiedRanked ?? [];
  const selectedFreshFingerprints = new Set(freshSelected.map((item) => inventoryFingerprint(item.fingerprint)));
  const excessFresh = unselectedQualifiedTopics(freshQualified, freshSelected);
  if (freshSelected.length > freshQualified.length) throw new Error('final_selection_invariant:fresh_selected_exceeds_qualified');
  if (selected.length > params.slotCount) throw new Error('final_selection_invariant:total_exceeds_requested');
  if (selected.length !== freshSelected.length + inventorySelected.length) throw new Error('final_selection_invariant:selection_sum_mismatch');
  if (excessFresh.some((item) => selectedFreshFingerprints.has(inventoryFingerprint(item.fingerprint)))) throw new Error('final_selection_invariant:selected_stored_as_excess');
  const excessStored = await storeQualifiedTopics(params.userId, excessFresh);
  const attemptedByNiche = excessFresh.reduce<Record<string, number>>((counts, item) => {
    const niche = item.trend.originNiche ?? item.trend.niche ?? 'unknown'; counts[niche] = (counts[niche] ?? 0) + 1; return counts;
  }, {});
  console.info('[topic-inventory] batch selection completed', {
    userId: params.userId, requestedPosts: params.slotCount,
    freshQualified: freshQualified.length,
    freshSelected: freshSelected.length, inventorySelected: inventorySelected.length,
    totalSelected: selected.length, excessFreshAttempted: excessFresh.length, excessFreshCommitted: excessStored,
    attemptedByNiche,
    selectedByNiche: selected.reduce<Record<string, number>>((counts, item) => {
      const niche = item.trend.originNiche ?? item.trend.niche ?? 'unknown'; counts[niche] = (counts[niche] ?? 0) + 1; return counts;
    }, {}),
  });

  return requireCompleteTrendPool({
    author,
    eligible: selected.map((item) => item.trend),
    ranked: selected,
    stats: pool.stats,
  });
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
    recentPosts?: string[];
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
    recentPosts?: string[];
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
    const basePlan = buildTopicDiverseBatchPlan(ranked.slice(0, count), count, author.strategy?.writingStyle);
    const plan = await contentService.narrowBatchClaims(basePlan, ranked.slice(0, count).map((item) => item.trend), author, provider);
    const diversityIssues = validatePlanTopicDiversity(plan);
    if (diversityIssues.length) {
      console.warn('[ghostwriter] batch plan diversity warnings', { issues: diversityIssues });
    }
    console.log('[ghostwriter] batch plan', summarizeBatchPlan(plan, author));
    return plan;
  }

  const basePlan = await contentService.planBatch(eligible, author, count, provider);
  const plan = await contentService.narrowBatchClaims(basePlan, eligible, author, provider);
  console.log('[ghostwriter] batch plan', summarizeBatchPlan(plan, author));
  return plan;
}
