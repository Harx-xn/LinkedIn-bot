import { ContentService } from './contentService';
import type { AuthorContext, BatchPostPlan, RankedTrendCandidate, TrendCandidate, TrendPoolStats } from './generationTypes';
import { summarizeBatchPlan, buildDeterministicBatchPlan, buildTopicDiverseBatchPlan } from './ghostwriterBatchPlanner';
import type { Trend } from './trendsService';
import {
  generateSlotPost as generateSlotPostImpl,
  generateSlotPostUntilSuccess as generateSlotPostUntilSuccessImpl,
  type GeneratedSlotResult,
  type SlotGenerationOptions,
} from './ghostwriterGenerationService';
import { TrendOrchestrationService } from './trendOrchestrationService';
import { validatePlanTopicDiversity } from './trendDiversityService';
import { BatchScheduleError } from './batchScheduleService';
import { inventoryFingerprint, reserveValidInventoryTopics, storeQualifiedTopics, unselectedQualifiedTopics } from './topicInventoryService';
import { getOrBuildContentIntelligence } from './contentIntelligenceService';
import { ideaToRankedCandidate } from './contentIdeaService';
import { buildStrategyIdeaCandidatePool } from './semanticIdeaGenerationService';
import { loadRecentTopicHistory } from './topicHistoryService';
import {
  createRecentContentMemory,
  loadRecentContentMemory,
} from './recentContentMemoryService';
import { buildUnifiedCandidateSelection, selectUnifiedBatchCandidates } from './unifiedBatchCandidateService';
import { loadAccountPerformanceProfileSafe, type AccountPerformanceProfile } from './accountPerformanceLearningService';
import {
  applyKnowledgeAuthorityToContentIntelligence,
  buildGenerationAuthorityContext,
  buildUserKnowledgeAuthorityContext,
  loadUserKnowledgeAuthorityContext,
} from './userKnowledgeAuthorityService';
import {
  FALLBACK_PROVENANCE,
  logFallbackProvenance,
} from './fallbackProvenanceService';

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

  let knowledgeContext = buildUserKnowledgeAuthorityContext({
    profileDescription: author.description,
    niches: params.niches,
  });
  try {
    knowledgeContext = await loadUserKnowledgeAuthorityContext(params.userId, { niches: params.niches });
  } catch (error) {
    console.warn('[user-authority] evidence load failed; using conservative profile-only boundaries', {
      userId: params.userId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  author.authorityContext = buildGenerationAuthorityContext(knowledgeContext, 'BATCH', params.niches);

  const orchestrator = new TrendOrchestrationService(params.openaiApiKey);
  let recentContentMemory = createRecentContentMemory();
  try {
    recentContentMemory = await loadRecentContentMemory(params.userId);
  } catch (error) {
    console.warn('[content-memory] recent fingerprint load failed; continuing without rich memory', {
      userId: params.userId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  // Candidate selection mutates its memory as it builds the batch. Editorial planning
  // needs the historical snapshot so it can add form decisions slot-by-slot itself.
  const editorialMemory = createRecentContentMemory(recentContentMemory.fingerprints);
  const performanceProfile = await loadAccountPerformanceProfileSafe(params.userId);

  let strategyRanked: RankedTrendCandidate[] = [];
  let strategyCandidateCount = 0;
  let intelligenceOpenAiCalls = 0;
  if (params.config.strategy) {
    try {
      const [intelligence, recentHistory] = await Promise.all([
        getOrBuildContentIntelligence(params.userId, params.config.strategy, params.openaiApiKey),
        loadRecentTopicHistory(params.userId),
      ]);
      const evidenceGroundedProfile = applyKnowledgeAuthorityToContentIntelligence(intelligence.profile, knowledgeContext);
      const ideaPool = await buildStrategyIdeaCandidatePool({
        profile: evidenceGroundedProfile,
        strategy: params.config.strategy,
        history: recentHistory,
        recentMemory: recentContentMemory,
        count: params.slotCount,
        apiKey: params.openaiApiKey,
      });
      const candidates = ideaPool.candidates;
      strategyCandidateCount = candidates.length;
      strategyRanked = candidates.map(ideaToRankedCandidate);
      intelligenceOpenAiCalls = (intelligence.semanticEnrichmentSucceeded ? 1 : 0) + ideaPool.modelCalls;
      author.contentIntelligence = evidenceGroundedProfile;
      author.authorityContext = buildGenerationAuthorityContext(
        knowledgeContext,
        'BATCH',
        evidenceGroundedProfile.territoryMap.map((entry) => entry.territory),
      );
      console.info('[content-ideas] candidates prepared for unified selection', {
        userId: params.userId,
        intelligenceSource: intelligence.source,
        intelligenceInputFingerprintCurrent: intelligence.inputFingerprint === intelligence.profileInputFingerprint,
        semanticEnrichmentSucceeded: intelligence.semanticEnrichmentSucceeded,
        intelligenceError: intelligence.error,
        ideaGenerationSource: ideaPool.source,
        semanticIdeaError: ideaPool.error,
        semanticIdeaCalls: ideaPool.modelCalls,
        candidateCount: candidates.length,
        candidates: candidates.map((idea) => ({
          pillar: idea.pillar, territory: idea.territory, origin: idea.origin,
          qualityScore: idea.score.composite, rejectedReasons: idea.rejectedReasons,
          authorityMode: idea.authorityMode, searchUsed: idea.searchRequired,
          generationMode: idea.generationMode,
          personalEvidencePotential: idea.personalEvidencePotential,
          saturationPenalty: idea.saturationPenalty, similarityPenalty: idea.score.recentSimilarityRisk,
          contentMemoryPenalty: idea.memoryPenalty ?? 0, contentMemoryReasons: idea.memoryReasons ?? [],
          coreClaim: idea.coreClaim, fallbackLevel: 1,
        })),
      });
    } catch (error) {
      console.warn('[content-ideas] strategy candidate preparation failed; unified selection will retain other origins', { userId: params.userId, message: error instanceof Error ? error.message : String(error), fallbackLevel: 4 });
    }
  }

  void params.previewId;
  void params.configHash;
  let discoveryPool: Awaited<ReturnType<TrendOrchestrationService['buildTrendPoolForBatch']>> | undefined;
  const mixed = await buildUnifiedCandidateSelection({
    strategyCandidates: strategyRanked,
    count: params.slotCount,
    memory: recentContentMemory,
    search: async (candidateCount) => {
      discoveryPool = await orchestrator.buildTrendPoolForBatch({
        userId: params.userId,
        niches: params.niches,
        author,
        strategy: params.config.strategy,
        sources: params.sources,
        slotCount: candidateCount,
        mode: 'generation',
      });
      return discoveryPool.qualifiedRanked ?? discoveryPool.ranked;
    },
    performanceProfile,
  });
  const freshSelected = mixed.selected.map((candidate) => candidate.ranked);
  const searchQualified = discoveryPool?.qualifiedRanked ?? discoveryPool?.ranked ?? [];
  const inventorySelected = freshSelected.length < params.slotCount
    ? await reserveValidInventoryTopics({
        userId: params.userId,
        generationJobId: params.generationJobId ?? `batch-${params.userId}-${Date.now()}`,
        count: params.slotCount - freshSelected.length,
        activeNiches: params.niches,
        selectedFreshTopics: freshSelected,
        activeProfileFingerprints: new Map((discoveryPool?.expansionPlans ?? []).map((plan) => [plan.niche, plan.inputFingerprint ?? ''])),
      })
    : [];
  const selected = inventorySelected.length
    ? selectUnifiedBatchCandidates(
        [...mixed.observed.map((candidate) => candidate.ranked), ...inventorySelected],
        params.slotCount,
        createRecentContentMemory(recentContentMemory.fingerprints),
        performanceProfile,
      ).map((candidate) => candidate.ranked)
    : freshSelected;
  const selectedSearchFingerprints = new Set(selected
    .filter((item) => item.trend.sourceType !== 'strategy_derived')
    .map((item) => inventoryFingerprint(item.fingerprint)));
  const excessFresh = unselectedQualifiedTopics(searchQualified, selected.filter((item) => selectedSearchFingerprints.has(inventoryFingerprint(item.fingerprint))));
  if (selected.length > params.slotCount) throw new Error('final_selection_invariant:total_exceeds_requested');
  if (excessFresh.some((item) => selectedSearchFingerprints.has(inventoryFingerprint(item.fingerprint)))) throw new Error('final_selection_invariant:selected_stored_as_excess');
  const excessStored = await storeQualifiedTopics(params.userId, excessFresh);
  const attemptedByNiche = excessFresh.reduce<Record<string, number>>((counts, item) => {
    const niche = item.trend.originNiche ?? item.trend.niche ?? 'unknown'; counts[niche] = (counts[niche] ?? 0) + 1; return counts;
  }, {});
  console.info('[topic-inventory] batch selection completed', {
    userId: params.userId, requestedPosts: params.slotCount,
    strategyCandidates: strategyCandidateCount,
    searchRequested: mixed.searchRequested,
    searchQualified: searchQualified.length,
    searchFailed: mixed.searchFailed,
    evidenceEnriched: mixed.evidenceEnriched,
    freshSelected: freshSelected.length, inventorySelected: inventorySelected.length,
    totalSelected: selected.length, excessFreshAttempted: excessFresh.length, excessFreshCommitted: excessStored,
    attemptedByNiche,
    selectedByNiche: selected.reduce<Record<string, number>>((counts, item) => {
      const niche = item.trend.originNiche ?? item.trend.niche ?? 'unknown'; counts[niche] = (counts[niche] ?? 0) + 1; return counts;
    }, {}),
  });

  console.info('[content-ideas] unified batch selection', {
    userId: params.userId,
    requested: params.slotCount,
    observed: mixed.observed.length,
    searchRequested: mixed.searchRequested,
    evidenceEnriched: mixed.evidenceEnriched,
    selected: selected.map((candidate) => ({
      origin: candidate.trend.ideaOrigin ?? (candidate.trend.sourceType === 'strategy_derived' ? 'STRATEGY_DERIVED' : 'SEARCH_DISCOVERED'),
      pillar: candidate.matchedPillar ?? candidate.trend.matchedPillar ?? candidate.trend.originNiche,
      territory: candidate.trend.territory ?? candidate.fingerprint.topicCluster,
      sourceQuality: candidate.sourceQualityScore,
      freshness: candidate.recencyScore,
      ideaQuality: candidate.trend.ideaQualityScore ?? candidate.totalScore,
      saturationPenalty: candidate.trend.saturationPenalty ?? 0,
      performanceReasons: (candidate.trend.strategyReasons ?? []).filter((reason) => reason.startsWith('account_performance:')),
    })),
  });

  const stats: TrendPoolStats = discoveryPool?.stats ?? {
    rawCount: strategyCandidateCount,
    rejectedLowValue: strategyRanked.filter((candidate) => !candidate.novelty.allowed).length,
    rejectedByExclusions: 0,
    exactDuplicatesRemoved: 0,
    nearDuplicatesRemoved: Math.max(0, strategyCandidateCount - selected.length),
    historyMatchesRemoved: 0,
    fingerprinted: strategyCandidateCount,
    selected: selected.length,
    evergreenFilled: selected.filter((candidate) => candidate.trend.sourceType === 'strategy_derived').length,
    openAiCalls: 0,
  };
  stats.selected = selected.length;
  stats.evergreenFilled = selected.filter((candidate) => candidate.trend.sourceType === 'strategy_derived').length;
  stats.openAiCalls = (stats.openAiCalls ?? 0) + intelligenceOpenAiCalls;

  return requireCompleteTrendPool({
    author,
    eligible: selected.map((item) => item.trend),
    ranked: selected,
    stats,
    editorialMemory,
    performanceProfile,
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
  options?: SlotGenerationOptions,
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
  options?: SlotGenerationOptions,
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
  editorialMemory?: import('./recentContentMemoryService').RecentContentMemory,
  performanceProfile?: AccountPerformanceProfile,
) {
  if (ranked?.length) {
    const basePlan = buildTopicDiverseBatchPlan(
      ranked.slice(0, count),
      count,
      author.strategy?.writingStyle,
      {
        recentMemory: editorialMemory,
        audience: author.targetAudience,
        primaryGoal: author.strategy?.contentGoals.primaryGoal,
        // Saved Experience Bank details are deliberately withheld from batch generation.
        personalEvidenceAvailable: false,
        performanceProfile,
      },
    );
    const plan = await contentService.narrowBatchClaims(basePlan, ranked.slice(0, count).map((item) => item.trend), author, provider);
    const diversityIssues = validatePlanTopicDiversity(plan);
    if (diversityIssues.length) {
      console.warn('[ghostwriter] batch plan diversity warnings', { issues: diversityIssues });
    }
    console.log('[ghostwriter] batch plan', summarizeBatchPlan(plan, author));
    return plan;
  }

  const legacyPlan = await contentService.planBatch(eligible, author, count, provider);
  logFallbackProvenance({
    provenance: FALLBACK_PROVENANCE.LEGACY_DISCOVERY,
    stage: 'batch_planning',
    count: Math.min(count, eligible.length),
    reason: 'unified_ranked_candidates_unavailable',
  });
  const editorialPlan = buildDeterministicBatchPlan(
    eligible,
    count,
    author.strategy?.writingStyle,
    {
      recentMemory: editorialMemory,
      audience: author.targetAudience,
      primaryGoal: author.strategy?.contentGoals.primaryGoal,
      personalEvidenceAvailable: false,
      performanceProfile,
    },
  );
  // Retain any useful AI-produced claim/depth reasoning while making the editorial
  // form deterministic, evidence-aware, and consistent with the shared selector.
  const basePlan = legacyPlan.map((plan, index) => ({
    ...plan,
    angle: editorialPlan[index]?.angle ?? plan.angle,
    hookStyle: editorialPlan[index]?.hookStyle ?? plan.hookStyle,
    endingStyle: editorialPlan[index]?.endingStyle ?? plan.endingStyle,
    layout: editorialPlan[index]?.layout ?? plan.layout,
    expressionMode: editorialPlan[index]?.expressionMode ?? plan.expressionMode,
    editorialDecision: editorialPlan[index]?.editorialDecision,
  }));
  const plan = await contentService.narrowBatchClaims(basePlan, eligible, author, provider);
  console.log('[ghostwriter] batch plan', summarizeBatchPlan(plan, author));
  return plan;
}
