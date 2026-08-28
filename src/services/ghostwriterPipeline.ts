import { ContentService } from './contentService';
import type { AuthorContext, BatchPostPlan, RankedTrendCandidate, TrendCandidate, TrendPoolStats } from './generationTypes';
import { summarizeBatchPlan, buildDeterministicBatchPlan, buildTopicDiverseBatchPlan } from './ghostwriterBatchPlanner';
import type { Trend } from './trendsService';
import {
  generateSlotPost as generateSlotPostImpl,
  generateSlotPostWithIdeaRecovery as generateSlotPostWithIdeaRecoveryImpl,
  generateSlotPostUntilSuccess as generateSlotPostUntilSuccessImpl,
  type GeneratedSlotResult,
  type SlotIdeaAttempt,
  type SlotIdeaRecoveryResult,
  type SlotGenerationOptions,
} from './ghostwriterGenerationService';
import { TrendOrchestrationService } from './trendOrchestrationService';
import { validatePlanTopicDiversity } from './trendDiversityService';
import { BatchScheduleError } from './batchScheduleService';
import { inventoryFingerprint, reserveValidInventoryTopics, storeQualifiedTopics, unselectedQualifiedTopics } from './topicInventoryService';
import { buildFallbackContentIntelligence, getOrBuildContentIntelligence } from './contentIntelligenceService';
import { ideaToRankedCandidate } from './contentIdeaService';
import { buildStrategyIdeaCandidatePool } from './semanticIdeaGenerationService';
import { loadRecentTopicHistory } from './topicHistoryService';
import {
  createRecentContentMemory,
  loadRecentContentMemory,
} from './recentContentMemoryService';
import {
  buildUnifiedCandidateSelection,
  normalizeBatchCandidate,
  selectUnifiedBatchCandidates,
  type UnifiedSelectionEvaluation,
} from './unifiedBatchCandidateService';
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
import { buildSlotIdeaPools, candidateTraceId, type IdeaFailureState, type SlotIdeaPool } from './ideaRecoveryService';
import type { RecentContentFingerprint } from './recentContentMemoryService';
import {
  diagnosticCandidateOrigin,
  diagnosticFingerprint,
  diagnosticTraceId,
  type BatchGenerationTraceRecorder,
} from './batchGenerationTraceService';

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
  traceRecorder?: BatchGenerationTraceRecorder;
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
  params.traceRecorder?.updateStrategyContext({
    authorityProfileFingerprint: diagnosticFingerprint({
      territories: author.authorityContext.territories,
      knowledgeableTopics: author.authorityContext.knowledgeableTopics,
      exploringTopics: author.authorityContext.exploringTopics,
      boundaries: author.authorityContext.boundaries,
    }),
  });

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
  params.traceRecorder?.updateStrategyContext({
    recentMemoryWindowSize: recentContentMemory.fingerprints.length,
    performanceLearningAvailable: performanceProfile.postCount > 0 && performanceProfile.preferences.length > 0,
    performanceLearningConfidence: performanceProfile.preferences.length
      ? Math.max(...performanceProfile.preferences.map((preference) => preference.confidence))
      : null,
  });

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
      const materialCandidateIds = new Set(candidates.map((candidate) => candidate.id));
      for (const observation of ideaPool.observations.filter((item) => !materialCandidateIds.has(item.id))) {
        params.traceRecorder?.recordCandidate({
          candidateTraceId: diagnosticTraceId('candidate', observation.id),
          origin: 'SEMANTIC_STRATEGY', generationMode: 'SEMANTIC', pillar: observation.pillar,
          territory: observation.territory, topicNormalized: observation.topicNormalized,
          ideaFamily: observation.ideaFamily, authorityMode: observation.authorityMode,
          ideaQuality: observation.ideaQuality, strategyFit: observation.strategyFit,
          audienceValue: observation.audienceValue, authorityFit: observation.authorityFit,
          practicalValue: null, discussionPotential: null, specificity: null,
          nonObviousness: null, fallbackFamily: null,
          subjectRelevance: null, sourceClaimTransformability: null,
          searchDisposition: null, searchRejectionReason: null, evidenceOnly: false,
          searchRelevanceBreakdown: null,
          conceptualMotif: null, reasoningArchetype: null, motifSimilarity: null,
          motifPenalty: null, motifCollisionCandidateId: null,
          audienceIdeaNaturalness: observation.audienceIdeaNaturalness,
          creatorContentFit: observation.creatorContentFit,
          candidateCoherence: null, coherencePenalty: null,
          coherenceRejectionReason: observation.rejectedReasons[0] ?? 'SEMANTIC_OUTPUT_INVALID',
          resolvedAudience: [],
          sourceQuality: null, freshness: null, novelty: observation.novelty,
          saturationPenalty: null, memoryPenalty: null, performanceAdjustment: null,
          unifiedQuality: null, adjustedScore: null, tier: 'REJECTED',
          rejectionReason: observation.rejectedReasons[0] ?? 'SEMANTIC_OUTPUT_INVALID',
          selected: false, selectionOrder: null, disposition: 'HARD_REJECTED', collisionCandidateTraceId: null,
        });
      }
      strategyCandidateCount = candidates.length;
      strategyRanked = candidates.map(ideaToRankedCandidate);
      intelligenceOpenAiCalls = (intelligence.semanticEnrichmentSucceeded ? 1 : 0) + ideaPool.modelCalls;
      author.contentIntelligence = evidenceGroundedProfile;
      params.traceRecorder?.updateStrategyContext({
        contentIntelligenceFingerprint: diagnosticFingerprint(evidenceGroundedProfile),
        contentIntelligenceVersion: evidenceGroundedProfile.version,
      });
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
  const coherenceContext = params.config.strategy ? {
    strategy: params.config.strategy,
    profile: author.contentIntelligence ?? buildFallbackContentIntelligence(params.config.strategy),
    recentContent: recentContentMemory.fingerprints,
  } : undefined;
  let discoveryPool: Awaited<ReturnType<TrendOrchestrationService['buildTrendPoolForBatch']>> | undefined;
  const mixedSelectionEvaluations: UnifiedSelectionEvaluation[] = [];
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
      return [
        ...(discoveryPool.qualifiedRanked ?? discoveryPool.ranked),
        ...(discoveryPool.evidenceOnlyRanked ?? []),
        ...(discoveryPool.rejectedSearchRanked ?? []),
      ];
    },
    performanceProfile,
    coherenceContext,
    selectionObserver: (evaluation) => mixedSelectionEvaluations.push(evaluation),
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
  const inventorySelectionEvaluations: UnifiedSelectionEvaluation[] = [];
  const finalNormalizedSelection = inventorySelected.length
    ? selectUnifiedBatchCandidates(
        [...mixed.observed.map((candidate) => candidate.ranked), ...inventorySelected],
        params.slotCount,
        createRecentContentMemory(recentContentMemory.fingerprints),
        performanceProfile,
        { observer: (evaluation) => inventorySelectionEvaluations.push(evaluation), coherenceContext },
      )
    : mixed.selected;
  const finalSelectionEvaluations = inventorySelected.length ? inventorySelectionEvaluations : mixedSelectionEvaluations;
  const selected = finalNormalizedSelection.map((candidate) => candidate.ranked);
  const selectedSearchFingerprints = new Set(selected
    .filter((item) => item.trend.sourceType !== 'strategy_derived')
    .map((item) => inventoryFingerprint(item.fingerprint)));
  const slotIdeaPools = buildSlotIdeaPools({
    selected,
    observed: [...mixed.observed.map((candidate) => candidate.ranked), ...inventorySelected],
    recentMemory: recentContentMemory.fingerprints,
    performanceProfile,
  });
  if (params.traceRecorder) {
    const finalIds = new Map(selected.map((candidate, index) => [candidateTraceId(candidate), index + 1]));
    const selectedDiagnostics = new Map(finalNormalizedSelection.map((candidate) => [candidateTraceId(candidate.ranked), candidate]));
    const latestEvaluation = new Map<string, UnifiedSelectionEvaluation>();
    for (const evaluation of finalSelectionEvaluations) {
      const traceId = candidateTraceId(evaluation.candidate.ranked);
      latestEvaluation.set(traceId, evaluation);
      params.traceRecorder.recordSelectionEvaluation({
        selectionStep: evaluation.selectionStep,
        candidateTraceId: traceId,
        adjustedScore: evaluation.adjustedScore,
        memoryPenalty: evaluation.memoryPenalty,
        performanceAdjustment: evaluation.performanceAdjustment,
        tier: evaluation.tier,
        disposition: evaluation.disposition,
        collisionCandidateTraceId: evaluation.collisionCandidate
          ? candidateTraceId(evaluation.collisionCandidate.ranked)
          : null,
        motifSimilarity: evaluation.motifSimilarity,
        motifPenalty: evaluation.motifPenalty,
        motifCollisionCandidateId: evaluation.motifCollisionCandidateId,
      });
    }
    const normalizedObserved = [...mixed.observed];
    for (const inventory of inventorySelected) {
      if (!normalizedObserved.some((candidate) => candidateTraceId(candidate.ranked) === candidateTraceId(inventory))) {
        normalizedObserved.push(normalizeBatchCandidate(inventory, coherenceContext));
      }
    }
    for (const candidate of normalizedObserved) {
      const traceId = candidateTraceId(candidate.ranked);
      const order = finalIds.get(traceId) ?? null;
      const diagnosticCandidate = selectedDiagnostics.get(traceId) ?? candidate;
      const evaluation = latestEvaluation.get(traceId);
      const hardReason = diagnosticCandidate.criticalIssues[0]
        ?? (!diagnosticCandidate.topic.trim() || !diagnosticCandidate.coreClaim.trim() ? 'SEMANTIC_OUTPUT_INVALID' : null)
        ?? (!diagnosticCandidate.ranked.novelty.allowed ? diagnosticCandidate.ranked.novelty.reasons[0] ?? 'RECENT_MECHANISM_DUPLICATE' : null);
      params.traceRecorder.recordCandidate({
        candidateTraceId: traceId,
        sourceType: diagnosticCandidate.ranked.trend.sourceType ?? null,
        ideaOrigin: diagnosticCandidate.ranked.trend.ideaOrigin ?? null,
        selectedClaim: diagnosticCandidate.coreClaim || null,
        selectedMechanism: diagnosticCandidate.mechanism || null,
        origin: diagnosticCandidateOrigin({
          ideaGenerationMode: diagnosticCandidate.ranked.trend.ideaGenerationMode,
          ideaOrigin: diagnosticCandidate.ranked.trend.ideaOrigin,
          sourceType: diagnosticCandidate.ranked.trend.sourceType,
          inventoryId: diagnosticCandidate.ranked.trend.inventoryId,
          provenance: diagnosticCandidate.provenance,
          evidenceEnriched: Boolean(diagnosticCandidate.evidence.enrichedCandidateId),
        }),
        generationMode: diagnosticCandidate.ranked.trend.ideaGenerationMode ?? null,
        pillar: diagnosticCandidate.pillar || null,
        territory: diagnosticCandidate.territory || null,
        topicNormalized: diagnosticCandidate.ranked.fingerprint.normalizedTopic || null,
        ideaFamily: diagnosticCandidate.ranked.trend.ideaFamily ?? diagnosticCandidate.ranked.trend.suggestedAngle ?? null,
        authorityMode: diagnosticCandidate.authorityMode,
        ideaQuality: diagnosticCandidate.ideaQuality,
        strategyFit: diagnosticCandidate.ranked.trend.ideaScoreBreakdown?.strategyFit ?? null,
        audienceValue: diagnosticCandidate.ranked.trend.ideaScoreBreakdown?.audienceValue ?? null,
        practicalValue: diagnosticCandidate.ranked.trend.ideaScoreBreakdown?.practicalValue ?? null,
        discussionPotential: diagnosticCandidate.ranked.trend.ideaScoreBreakdown?.discussionPotential ?? null,
        specificity: diagnosticCandidate.ranked.trend.ideaScoreBreakdown?.specificity ?? null,
        nonObviousness: diagnosticCandidate.ranked.trend.ideaScoreBreakdown?.nonObviousness ?? null,
        fallbackFamily: diagnosticCandidate.ranked.trend.ideaScoreBreakdown?.fallbackFamily ?? null,
        subjectRelevance: diagnosticCandidate.subjectRelevance,
        sourceClaimTransformability: diagnosticCandidate.sourceClaimTransformability,
        searchDisposition: diagnosticCandidate.searchDisposition,
        searchRejectionReason: diagnosticCandidate.searchRejectionReason,
        evidenceOnly: diagnosticCandidate.evidenceOnly,
        searchRelevanceBreakdown: diagnosticCandidate.ranked.trend.searchRelevanceBreakdown ?? null,
        conceptualMotif: diagnosticCandidate.conceptualMotif,
        reasoningArchetype: diagnosticCandidate.reasoningArchetype,
        motifSimilarity: evaluation?.motifSimilarity ?? null,
        motifPenalty: evaluation?.motifPenalty ?? null,
        motifCollisionCandidateId: evaluation?.motifCollisionCandidateId ?? null,
        authorityFit: diagnosticCandidate.ranked.trend.ideaScoreBreakdown?.authorityFit ?? null,
        audienceIdeaNaturalness: diagnosticCandidate.audienceIdeaNaturalness,
        creatorContentFit: diagnosticCandidate.creatorContentFit,
        candidateCoherence: diagnosticCandidate.candidateCoherence,
        coherencePenalty: diagnosticCandidate.coherencePenalty,
        coherenceRejectionReason: diagnosticCandidate.coherenceRejectionReason,
        resolvedAudience: diagnosticCandidate.resolvedAudience,
        sourceQuality: diagnosticCandidate.sourceQuality,
        freshness: diagnosticCandidate.freshness,
        novelty: diagnosticCandidate.ranked.noveltyScore,
        saturationPenalty: diagnosticCandidate.saturationPenalty,
        memoryPenalty: evaluation?.memoryPenalty ?? (order ? diagnosticCandidate.similarityPenalty : null),
        performanceAdjustment: evaluation?.performanceAdjustment ?? (order ? diagnosticCandidate.performanceAdjustment : null),
        unifiedQuality: diagnosticCandidate.ranked.totalScore,
        adjustedScore: evaluation?.adjustedScore ?? (order ? diagnosticCandidate.ranked.totalScore : null),
        tier: diagnosticCandidate.evidenceOnly ? 'EVIDENCE_ONLY' : evaluation ? String(evaluation.tier) : diagnosticCandidate.criticalIssues.length ? 'REJECTED' : diagnosticCandidate.ranked.novelty.allowed ? 'ELIGIBLE' : 'NOVELTY_REJECTED',
        rejectionReason: diagnosticCandidate.searchRejectionReason ?? hardReason ?? (order ? null : evaluation?.disposition ?? 'NOT_NEEDED_AFTER_BATCH_FILLED'),
        selected: Boolean(order),
        selectionOrder: order,
        disposition: order ? 'SELECTED' : diagnosticCandidate.evidenceOnly ? 'EVIDENCE_ONLY' : hardReason ? 'HARD_REJECTED'
          : evaluation?.disposition === 'BATCH_DUPLICATE' ? 'BATCH_DUPLICATE'
            : evaluation ? 'LOST_RANKING' : 'NOT_NEEDED_AFTER_BATCH_FILLED',
        collisionCandidateTraceId: evaluation?.collisionCandidate
          ? candidateTraceId(evaluation.collisionCandidate.ranked)
          : null,
      });
    }
    slotIdeaPools.forEach((pool, slotIndex) => {
      for (const alternate of pool.alternates) {
        const normalized = normalizeBatchCandidate(alternate.ranked, coherenceContext);
        params.traceRecorder!.recordCandidate({
          candidateTraceId: alternate.id,
          origin: diagnosticCandidateOrigin({
            ideaGenerationMode: normalized.ranked.trend.ideaGenerationMode,
            ideaOrigin: normalized.ranked.trend.ideaOrigin,
            sourceType: normalized.ranked.trend.sourceType,
            inventoryId: normalized.ranked.trend.inventoryId,
            provenance: normalized.provenance,
          }),
          generationMode: normalized.ranked.trend.ideaGenerationMode ?? null,
          pillar: normalized.pillar, territory: normalized.territory,
          topicNormalized: normalized.ranked.fingerprint.normalizedTopic,
          ideaFamily: normalized.ranked.trend.ideaFamily ?? null,
          authorityMode: normalized.authorityMode,
          ideaQuality: normalized.ideaQuality,
          strategyFit: normalized.ranked.trend.ideaScoreBreakdown?.strategyFit ?? null,
          audienceValue: normalized.ranked.trend.ideaScoreBreakdown?.audienceValue ?? null,
          practicalValue: normalized.ranked.trend.ideaScoreBreakdown?.practicalValue ?? null,
          discussionPotential: normalized.ranked.trend.ideaScoreBreakdown?.discussionPotential ?? null,
          specificity: normalized.ranked.trend.ideaScoreBreakdown?.specificity ?? null,
          nonObviousness: normalized.ranked.trend.ideaScoreBreakdown?.nonObviousness ?? null,
          fallbackFamily: normalized.ranked.trend.ideaScoreBreakdown?.fallbackFamily ?? null,
          subjectRelevance: normalized.subjectRelevance,
          sourceClaimTransformability: normalized.sourceClaimTransformability,
          searchDisposition: normalized.searchDisposition,
          searchRejectionReason: normalized.searchRejectionReason,
          evidenceOnly: normalized.evidenceOnly,
          searchRelevanceBreakdown: normalized.ranked.trend.searchRelevanceBreakdown ?? null,
          conceptualMotif: normalized.conceptualMotif,
          reasoningArchetype: normalized.reasoningArchetype,
          motifSimilarity: null, motifPenalty: null, motifCollisionCandidateId: null,
          authorityFit: normalized.ranked.trend.ideaScoreBreakdown?.authorityFit ?? null,
          audienceIdeaNaturalness: normalized.audienceIdeaNaturalness,
          creatorContentFit: normalized.creatorContentFit,
          candidateCoherence: normalized.candidateCoherence,
          coherencePenalty: normalized.coherencePenalty,
          coherenceRejectionReason: normalized.coherenceRejectionReason,
          resolvedAudience: normalized.resolvedAudience,
          sourceQuality: normalized.sourceQuality, freshness: normalized.freshness,
          novelty: normalized.ranked.noveltyScore, saturationPenalty: normalized.saturationPenalty,
          memoryPenalty: normalized.similarityPenalty || null, performanceAdjustment: normalized.performanceAdjustment || null,
          unifiedQuality: normalized.ranked.totalScore, adjustedScore: normalized.ranked.totalScore,
          tier: 'ELIGIBLE_ALTERNATE', rejectionReason: 'LOST_RANKING', selected: false,
          selectionOrder: null, disposition: 'ALTERNATE', collisionCandidateTraceId: null,
        });
      }
      void slotIndex;
    });
  }
  const reservedAlternateFingerprints = new Set(slotIdeaPools
    .flatMap((pool) => pool.alternates)
    .filter((candidate) => candidate.ranked.trend.sourceType !== 'strategy_derived')
    .map((candidate) => inventoryFingerprint(candidate.ranked.fingerprint)));
  const excessFresh = unselectedQualifiedTopics(searchQualified, selected.filter((item) => selectedSearchFingerprints.has(inventoryFingerprint(item.fingerprint))))
    .filter((candidate) => !reservedAlternateFingerprints.has(inventoryFingerprint(candidate.fingerprint)));
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
    slotIdeaPools,
    ideaRecoveryMemory: recentContentMemory.fingerprints,
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

export async function generateSlotPostWithIdeaRecovery(
  contentService: ContentService,
  initialIdea: SlotIdeaAttempt,
  author: AuthorContext,
  config: GhostwriterBotConfig,
  acceptedBodies: string[],
  provider: 'OPENAI' | 'GEMINI' = 'OPENAI',
  options?: SlotGenerationOptions,
  selectReplacement?: (
    failure: IdeaFailureState,
    attemptedCandidateIds: Set<string>,
  ) => Promise<SlotIdeaAttempt | null> | SlotIdeaAttempt | null,
): Promise<SlotIdeaRecoveryResult> {
  return generateSlotPostWithIdeaRecoveryImpl(
    contentService,
    initialIdea,
    author,
    config,
    acceptedBodies,
    provider,
    options,
    selectReplacement,
  );
}

export function buildReplacementPlan(params: {
  candidate: SlotIdeaPool['selected'];
  slotIndex: number;
  author: AuthorContext;
  config: GhostwriterBotConfig;
  editorialMemory?: NonNullable<Parameters<typeof buildTopicDiverseBatchPlan>[3]>['recentMemory'];
  performanceProfile?: AccountPerformanceProfile;
  acceptedPlans?: BatchPostPlan[];
}): BatchPostPlan {
  const replacement = buildTopicDiverseBatchPlan(
    [params.candidate.ranked],
    1,
    params.config.strategy?.writingStyle,
    {
      recentMemory: params.editorialMemory,
      audience: params.author.targetAudience,
      primaryGoal: params.config.strategy?.contentGoals.primaryGoal,
      personalEvidenceAvailable: false,
      performanceProfile: params.performanceProfile,
      currentBatch: (params.acceptedPlans ?? []).flatMap((plan) => plan.editorialDecision ? [plan.editorialDecision] : []),
    },
  )[0];
  return { ...replacement, trendIndex: params.slotIndex };
}

export type { SlotIdeaAttempt, SlotIdeaPool, RecentContentFingerprint };

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
    console.log('[ghostwriter] batch plan', summarizeBatchPlan(plan, author, ranked.slice(0, count).map((item) => item.trend)));
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
    resolvedAudience: editorialPlan[index]?.resolvedAudience ?? [],
  }));
  const plan = await contentService.narrowBatchClaims(basePlan, eligible, author, provider);
  console.log('[ghostwriter] batch plan', summarizeBatchPlan(plan, author, eligible.slice(0, count)));
  return plan;
}
