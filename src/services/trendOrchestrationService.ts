import type {
  AuthorContext,
  NicheExpansionPlan,
  PreviewTrendItem,
  RankedTrendCandidate,
  TrendCandidate,
  TrendPoolStats,
} from './generationTypes';
import {
  getPipelineConfig,
  targetCandidateCount,
  toPipelineMode,
  type TrendPipelineMode,
} from '../config/trendPipelineConfig';
import { buildNicheProfileFingerprintInput, flattenExpansionQueries, NicheExpansionService, validateExpansionQuery } from './nicheExpansionService';
import { TopicFingerprintService } from './topicFingerprintService';
import { applyBatchEvidenceComposition, processTrendCandidates } from './trendSelectionService';
import { rankedToTrendCandidates } from './trendDiversityService';
import { areHardBatchDuplicates, selectFinalBatchCandidates, selectNicheBalancedCandidates, selectPreviewRankedCandidates } from './trendRankingService';
import { TrendsService, type GenerationSearchRun, type TrendFetchMetrics } from './trendsService';
import type { Trend } from './trendsService';
import { mapWithConcurrencySettled } from './concurrencyUtils';
import { PipelineTimer } from './trendPipelineTiming';
import type { EffectiveBotStrategy } from './botStrategyService';
import { buildStrategyExpansionPlan } from './botStrategyTrendService';

export type OrchestratedTrendPool = {
  eligible: TrendCandidate[];
  ranked: RankedTrendCandidate[];
  expansionPlans: NicheExpansionPlan[];
  stats: TrendPoolStats & { openAiCalls?: number; sourceRequestCount?: number; cacheHits?: number; cacheMisses?: number };
  timingMs?: ReturnType<PipelineTimer['finish']>;
  qualifiedRanked?: RankedTrendCandidate[];
  evidenceOnlyRanked?: RankedTrendCandidate[];
  rejectedSearchRanked?: RankedTrendCandidate[];
};

export type RankedTrendPoolParams = {
  userId: string;
  niches: string[];
  author: AuthorContext;
  sources: string[];
  limit?: number;
  slotCount?: number;
  mode: 'preview' | 'batch' | 'generation';
  reuseRanked?: RankedTrendCandidate[];
  strategy?: EffectiveBotStrategy;
  searchAttempt?: number;
  generationSearchRun?: GenerationSearchRun;
  exhaustedNiches?: Set<string>;
};

export type RankedTrendPoolResult = OrchestratedTrendPool;
export interface NicheDiscoveryState {
  niche: string;
  rawCandidates: TrendCandidate[];
  hardEligibleCandidates: TrendCandidate[];
  strategyAcceptedCandidates: RankedTrendCandidate[];
  noveltyApprovedCandidates: RankedTrendCandidate[];
  executedRequestKeys: Set<string>;
  exhaustedRequestKeys: Set<string>;
  searchSpaceExhausted: boolean;
  stopReason: string | null;
}
export const MIN_INITIAL_EXECUTABLE_QUERIES = 4;
export const MAX_QUERIES_PER_ATTEMPT = 8;
export const MIN_RETRY_EXECUTABLE_QUERIES = 1;
/** Backwards-compatible name for initial profile health checks. */
export const MIN_EXECUTABLE_QUERIES_PER_NICHE = MIN_INITIAL_EXECUTABLE_QUERIES;

export function dedupeCrossNicheQualifiedTopics(topics: RankedTrendCandidate[]): RankedTrendCandidate[] {
  const kept: RankedTrendCandidate[] = [];
  for (const topic of [...topics].filter((item) => item.novelty.allowed).sort((a, b) => b.totalScore - a.totalScore)) {
    if (kept.some((item) => areHardBatchDuplicates(topic, item))) continue;
    kept.push(topic);
  }
  return kept;
}

export class InsufficientValidQueriesError extends Error {
  constructor(public readonly niche: string, public readonly diagnostics: Array<{ query: string; reasons: string[] }>) {
    super(`insufficient_valid_queries:${niche}`);
    this.name = 'InsufficientValidQueriesError';
  }
}

export function validatePlanQueries(plan: NicheExpansionPlan): {
  executable: string[];
  rejected: Array<{ query: string; reasons: string[]; confidence: number }>;
} {
  const executable: string[] = [];
  const rejected: Array<{ query: string; reasons: string[]; confidence: number }> = [];
  for (const query of [...new Set(flattenExpansionQueries(plan))]) {
    const result = validateExpansionQuery(query, plan.niche, plan.subtopics, executable, plan);
    if (result.valid && result.confidence >= 0.7) executable.push(query);
    else rejected.push({ query, reasons: result.reasons, confidence: result.confidence });
  }
  return { executable, rejected };
}

function normalizeQueryPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Build retry searches from the pillar's search keywords, not its example
 * writing angles. Example angles often describe the shared audience (for
 * example, "for indie game devs") and can pull every niche into that domain.
 */
export function buildFocusedRetryQueries(
  niche: string,
  plan: NicheExpansionPlan,
  searchAttempt: number,
  executedRequestKeys: Set<string> = new Set(),
): string[] {
  if (searchAttempt <= 0) return [];
  const nicheKey = normalizeQueryPart(niche);
  const orderedQueries = plan.profileQueries?.length
    ? [...plan.profileQueries]
        .filter((item) => item.confidence >= 0.7)
        .sort((a, b) => b.confidence - a.confidence)
        .map((item) => item.query)
    : plan.queries;
  void executedRequestKeys;
  const uniqueQueries = [...new Map(orderedQueries
    .map((query) => [normalizeQueryPart(query), query.trim()] as const)
    .filter(([key]) => key && key !== nicheKey)).values()];
  const offset = searchAttempt * MAX_QUERIES_PER_ATTEMPT;
  return uniqueQueries.slice(offset, offset + MAX_QUERIES_PER_ATTEMPT);
}

export class TrendOrchestrationService {
  private nicheExpansion: NicheExpansionService;
  private fingerprintService: TopicFingerprintService;

  constructor(openaiApiKey?: string | null) {
    this.nicheExpansion = new NicheExpansionService(openaiApiKey);
    this.fingerprintService = new TopicFingerprintService(openaiApiKey);
  }

  async resolveExpansionPlan(userId: string, niche: string, strategy?: EffectiveBotStrategy): Promise<NicheExpansionPlan> {
    try {
      return await this.nicheExpansion.getOrCreatePlan(userId, niche, false, [], buildNicheProfileFingerprintInput(niche, strategy));
    } catch (error) {
      console.error('[trend-orchestration] niche expansion failed; using niche fallback', {
        userId,
        niche,
        message: error instanceof Error ? error.message : String(error),
      });
      const { buildFallbackExpansionPlan } = await import('./nicheExpansionService');
      return buildFallbackExpansionPlan(niche);
    }
  }

  async getRankedTrendPool(params: RankedTrendPoolParams): Promise<RankedTrendPoolResult> {
    const timer = new PipelineTimer();
    timer.mark('configurationMs');

    const pipelineMode: TrendPipelineMode = toPipelineMode(params.mode);
    const cfg = getPipelineConfig(pipelineMode);
    const limit = params.limit ?? params.slotCount ?? (pipelineMode === 'preview' ? 20 : 7);

    if (params.reuseRanked?.length) {
      const ranked = params.reuseRanked.slice(0, limit);
      return {
        eligible: rankedToTrendCandidates(ranked),
        ranked,
        expansionPlans: [],
        stats: {
          rawCount: params.reuseRanked.length,
          rejectedLowValue: 0,
          rejectedByExclusions: 0,
          exactDuplicatesRemoved: 0,
          nearDuplicatesRemoved: 0,
          historyMatchesRemoved: 0,
          fingerprinted: 0,
          selected: ranked.length,
          evergreenFilled: 0,
          openAiCalls: 0,
        },
      };
    }

    const candidateTarget = pipelineMode === 'generation' ? 20 * Math.max(1, params.niches.length) : targetCandidateCount(pipelineMode, limit);
    const perNicheLimit = Math.min(
      cfg.maxCandidatesPerNiche,
      Math.max(
        pipelineMode === 'generation' ? 18 : 6,
        Math.ceil(candidateTarget / Math.max(1, params.niches.length)),
      ),
    );

    timer.mark('searchPlanMs');

    type NicheResult = {
      plan: NicheExpansionPlan;
      ranked: RankedTrendCandidate[];
      evidenceOnlyRanked: RankedTrendCandidate[];
      rejectedSearchRanked: RankedTrendCandidate[];
      stats: TrendPoolStats & { openAiCalls?: number };
      rawFetched: number;
      queryCount: number;
      durationMs: number;
      fetchMetrics: TrendFetchMetrics;
    };

    const nicheStarted = performance.now();
    const activeNiches = params.niches.filter((niche) => !params.exhaustedNiches?.has(niche));
    const settledNicheResults = await mapWithConcurrencySettled(
      activeNiches,
      cfg.nicheConcurrency,
      async (niche): Promise<NicheResult> => {
        const trendsService = new TrendsService();
        const nicheTimer = performance.now();
        let cachedPlan = await this.resolveExpansionPlan(params.userId, niche, params.strategy);
        let basePlan = params.strategy
          ? buildStrategyExpansionPlan(params.strategy, niche, cachedPlan)
          : cachedPlan;
        let queryValidation = validatePlanQueries(basePlan);
        if (queryValidation.executable.length < MIN_INITIAL_EXECUTABLE_QUERIES) {
          console.warn('[trend-query] regenerating insufficient niche plan', {
            userId: params.userId,
            niche,
            cachedProfileQueries: cachedPlan.queries.length,
            strategyEnrichedQueries: basePlan.queries.length,
            generatedCandidates: flattenExpansionQueries(basePlan).length,
            validatedQueries: queryValidation.executable.length,
            diagnostics: queryValidation.rejected,
          });
          cachedPlan = await this.nicheExpansion.getOrCreatePlan(
            params.userId,
            niche,
            true,
            queryValidation.rejected,
            buildNicheProfileFingerprintInput(niche, params.strategy),
          );
          basePlan = params.strategy
            ? buildStrategyExpansionPlan(params.strategy, niche, cachedPlan)
            : cachedPlan;
          queryValidation = validatePlanQueries(basePlan);
        }
        const retryQueries = buildFocusedRetryQueries(
          niche,
          basePlan,
          params.searchAttempt ?? 0,
          params.generationSearchRun?.executedRequestKeys,
        );
        const attempt = params.searchAttempt ?? 0;
        const freshnessLayers = attempt === 0 ? ['7d'] as const
          : attempt === 1 ? ['30d'] as const
            : attempt === 2 ? ['fallback'] as const : [] as const;
        const expansionQueries = retryQueries.length
          ? retryQueries
          : (attempt > 0 && freshnessLayers.length ? queryValidation.executable.slice(0, MAX_QUERIES_PER_ATTEMPT) : []);
        const plan = attempt > 0
          ? {
              ...basePlan,
              queries: expansionQueries,
              profileQueries: undefined,
              queryBuckets: undefined,
              queryOrigin: 'retry_regenerated' as const,
            }
          : basePlan;
        const executionValidation = validatePlanQueries(plan);
        const rejectionCount = (pattern: RegExp) => executionValidation.rejected.filter((item) => item.reasons.some((reason) => pattern.test(reason))).length;
        const nicheRequestPrefix = `${niche.toLowerCase()}|`;
        const providerRequestKeysExecuted = [...(params.generationSearchRun?.executedRequestKeys ?? [])].filter((key) => key.startsWith(nicheRequestPrefix)).length;
        const providerRequestKeysExhausted = [...(params.generationSearchRun?.exhaustedQueries ?? [])].filter((key) => key.startsWith(nicheRequestPrefix)).length;
        const nicheExhausted = executionValidation.executable.length < MIN_RETRY_EXECUTABLE_QUERIES || freshnessLayers.length === 0;
        console.info('[trend-query] executable query funnel', {
          userId: params.userId,
          generationSearchRunId: params.generationSearchRun?.runId ?? null,
          niche,
          attempt: attempt + 1,
          storedProfileQueries: cachedPlan.queries.length, validatedQueryTexts: executionValidation.executable.length, newlyGeneratedQueries: Math.max(0, basePlan.queries.length - cachedPlan.queries.length), queriesRepaired: plan.repairMetrics?.attempted ?? 0, repairsAccepted: plan.repairMetrics?.accepted ?? 0, repairsRejected: plan.repairMetrics?.rejected ?? 0,
          rejectedBelowConfidence: executionValidation.rejected.filter((item) => item.confidence < 0.7).length,
          rejectedInsufficientContext: rejectionCount(/niche_context|specificity/), rejectedGeneric: rejectionCount(/generic/),
          rejectedPromotional: rejectionCount(/promotional/), rejectedDomainMismatch: rejectionCount(/domain_mismatch/), rejectedNearDuplicate: rejectionCount(/near_duplicate/),
          uniqueQueryTextsExecuted: executionValidation.executable.length, providerRequestKeysExecuted, providerRequestKeysExhausted,
          incompatibleProviderQueries: 0, unusedValidQueries: retryQueries.length,
          executableQueriesThisAttempt: Math.min(executionValidation.executable.length, MAX_QUERIES_PER_ATTEMPT),
          providersRemaining: params.sources, freshnessWindowsRemaining: freshnessLayers,
          nicheExhausted,
        });
        if (nicheExhausted) {
          params.exhaustedNiches?.add(niche);
          return { plan, ranked: [], evidenceOnlyRanked: [], rejectedSearchRanked: [], stats: { rawCount: 0, rejectedLowValue: 0, rejectedByExclusions: 0, exactDuplicatesRemoved: 0, nearDuplicatesRemoved: 0, historyMatchesRemoved: 0, fingerprinted: 0, selected: 0, evergreenFilled: 0 }, rawFetched: 0, queryCount: 0, durationMs: Math.round(performance.now() - nicheTimer), fetchMetrics: trendsService.getLastFetchMetrics() };
        }

        let rawTrends: Trend[] = [];
        try {
          rawTrends = await trendsService.fetchTrendsWithInput({
            niche,
            queries: plan.queries,
            exclusions: plan.exclusions,
            sources: params.sources,
            limit: perNicheLimit,
            expansionPlan: plan,
            pipelineMode,
            candidateTarget: Math.ceil(candidateTarget / params.niches.length),
            requestedCount: limit,
            cachePolicy: pipelineMode === 'preview' ? 'use_cache' : 'refresh',
            generationSearchRun: params.generationSearchRun,
            freshnessLayers: [...freshnessLayers],
          });
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('insufficient_valid_queries:')) throw error;
          console.error('[trend-orchestration] trend fetch failed', {
            userId: params.userId,
            niche,
            message: error instanceof Error ? error.message : String(error),
          });
        }

        if (pipelineMode === 'preview') {
          console.info({
            event: 'trend_preview_niche_completed',
            userId: params.userId,
            niche,
            queryCount: plan.queries.length,
            sourceMode: 'automatic',
            rawFetched: rawTrends.length,
          });
        } else {
          console.log('[trend-orchestration] raw trends fetched', {
            userId: params.userId,
            niche,
            searchAttempt: (params.searchAttempt ?? 0) + 1,
            queryCount: plan.queries.length,
            querySample: plan.queries.slice(0, 3),
            sourceMode: 'automatic',
            rawFetched: rawTrends.length,
          });
        }

        const { ranked, evidenceOnlyRanked, rejectedSearchRanked, stats } = await processTrendCandidates({
          userId: params.userId,
          rawTrends,
          niche,
          plan,
          author: { ...params.author, niches: params.niches },
          limit: perNicheLimit,
          fingerprintService: this.fingerprintService,
          pipelineMode,
          strategy: params.strategy,
        });
        const hardEligibleCount = Math.max(0, rawTrends.length - stats.rejectedLowValue - stats.rejectedByExclusions - stats.exactDuplicatesRemoved - stats.nearDuplicatesRemoved);
        params.generationSearchRun?.hardEligibleCountsByNiche.set(niche, hardEligibleCount);
        if (pipelineMode === 'generation' && hardEligibleCount >= 20) params.exhaustedNiches?.add(niche);
        if (pipelineMode === 'generation') console.info('[trend-discovery] niche cumulative target', {
          niche,
          attempt: attempt + 1,
          cumulativeRaw: rawTrends.length,
          cumulativeHardEligible: hardEligibleCount,
          targetHardEligible: 20,
          remainingNeeded: Math.max(0, 20 - hardEligibleCount),
          searchSpaceExhausted: params.exhaustedNiches?.has(niche) ?? false,
          stopReason: hardEligibleCount >= 20 ? 'target_hard_eligible_reached' : null,
        });
        console.info('[trend-orchestration] niche qualification completed', {
          niche,
          providerResults: rawTrends.length,
          exactDuplicatesRemoved: stats.exactDuplicatesRemoved,
          obviousLowValueRemoved: stats.rejectedLowValue,
          plausibleCandidatesBeforeCap: rawTrends.length,
          candidatesAfterCap: rawTrends.length,
          fullyQualified: ranked.length,
          eligibleCandidates: hardEligibleCount,
          generationSearchRunId: params.generationSearchRun?.runId ?? null,
          exhaustedQueries: params.generationSearchRun?.exhaustedQueries.size ?? 0,
        });

        return {
          plan,
          ranked,
          evidenceOnlyRanked,
          rejectedSearchRanked,
          stats,
          rawFetched: rawTrends.length,
          queryCount: plan.queries.length,
          durationMs: Math.round(performance.now() - nicheTimer),
          fetchMetrics: trendsService.getLastFetchMetrics(),
        };
      },
    );

    settledNicheResults.forEach((result, index) => {
      if (result.status === 'rejected') console.error('[trend-orchestration] niche discovery isolated failure', {
        userId: params.userId, niche: activeNiches[index], message: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    });
    const nicheResults = settledNicheResults.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);

    timer.mark('sourceFetchMs');
    timer.mark('filteringMs');
    timer.mark('deduplicationMs');
    timer.mark('rankingMs');

    const expansionPlans = nicheResults.map((r) => r.plan);
    const allRanked = nicheResults.flatMap((r) => r.ranked);
    const allEvidenceOnlyRanked = nicheResults.flatMap((r) => r.evidenceOnlyRanked ?? []);
    const allRejectedSearchRanked = nicheResults.flatMap((r) => r.rejectedSearchRanked ?? []);

    const aggregateStats: TrendPoolStats & {
      openAiCalls?: number;
      sourceRequestCount?: number;
      cacheHits?: number;
      cacheMisses?: number;
    } = {
      rawCount: 0,
      rejectedLowValue: 0,
      rejectedByExclusions: 0,
      exactDuplicatesRemoved: 0,
      nearDuplicatesRemoved: 0,
      historyMatchesRemoved: 0,
      fingerprinted: 0,
      selected: 0,
      evergreenFilled: 0,
      openAiCalls: 0,
    };

    for (const result of nicheResults) {
      aggregateStats.rawCount += result.stats.rawCount;
      aggregateStats.rejectedLowValue += result.stats.rejectedLowValue;
      aggregateStats.rejectedByExclusions += result.stats.rejectedByExclusions;
      aggregateStats.exactDuplicatesRemoved += result.stats.exactDuplicatesRemoved;
      aggregateStats.nearDuplicatesRemoved += result.stats.nearDuplicatesRemoved;
      aggregateStats.historyMatchesRemoved += result.stats.historyMatchesRemoved;
      aggregateStats.fingerprinted += result.stats.fingerprinted;
      aggregateStats.openAiCalls = (aggregateStats.openAiCalls ?? 0) + (result.stats.openAiCalls ?? 0);
    }

    aggregateStats.sourceRequestCount = nicheResults.reduce((sum, result) => sum + result.fetchMetrics.sourceRequestCount, 0);
    aggregateStats.cacheHits = nicheResults.reduce((sum, result) => sum + result.fetchMetrics.cacheHits, 0);
    aggregateStats.cacheMisses = nicheResults.reduce((sum, result) => sum + result.fetchMetrics.cacheMisses, 0);

    allRanked.sort((a, b) => b.totalScore - a.totalScore);

    let ranked = pipelineMode === 'preview'
      ? selectPreviewRankedCandidates(allRanked, limit)
      : selectNicheBalancedCandidates(applyBatchEvidenceComposition(allRanked, limit), limit);

    if (pipelineMode === 'generation') {
      const countByNiche = (items: RankedTrendCandidate[]) => items.reduce<Record<string, number>>((counts, item) => {
        const niche = item.trend.originNiche ?? item.trend.niche ?? 'unknown';
        counts[niche] = (counts[niche] ?? 0) + 1;
        return counts;
      }, {});
      const qualifiedByNiche = countByNiche(allRanked);
      const selectedByNiche = countByNiche(ranked);
      console.info('[trend-orchestration] final niche representation', {
        selectedByNiche,
        qualifiedByNiche,
        nichesWithoutQualifiedCandidates: params.niches.filter((niche) => !qualifiedByNiche[niche]),
      });
      for (const result of nicheResults) {
        const niche = result.plan.niche;
        const selected = selectedByNiche[niche] ?? 0;
        console.info('[trend-discovery] final niche funnel', {
          niche,
          queries: { stored: result.plan.queries.length, validated: result.queryCount, executed: result.fetchMetrics.queriesExecuted },
          providers: { planned: result.fetchMetrics.providerRequestsPlanned, executed: result.fetchMetrics.freshProviderRequests, exhausted: result.fetchMetrics.skippedExhaustedRequests, unavailable: result.fetchMetrics.providerRequestsUnavailable },
          candidates: { raw: result.fetchMetrics.rawProviderResults, plausible: result.fetchMetrics.plausibleCandidates, hardEligible: Math.max(0, result.rawFetched - result.stats.rejectedLowValue - result.stats.rejectedByExclusions - result.stats.exactDuplicatesRemoved - result.stats.nearDuplicatesRemoved), strategyAccepted: result.stats.strategyAccepted ?? 0, historyApproved: result.stats.historyApproved ?? 0, noveltyApproved: result.stats.noveltyApproved ?? 0 },
          output: { selected, storedInInventory: null },
        });
      }
    }

    aggregateStats.selected = ranked.length;
    timer.mark('previewPersistenceMs');
    const timingMs = timer.finish();

    if (pipelineMode === 'preview') {
      console.info({
        event: 'trend_preview_completed',
        userId: params.userId,
        nicheCount: params.niches.length,
        sourceRequestCount: aggregateStats.sourceRequestCount,
        cacheHits: aggregateStats.cacheHits,
        cacheMisses: aggregateStats.cacheMisses,
        openAiCalls: aggregateStats.openAiCalls ?? 0,
        selected: aggregateStats.selected,
        durationMs: timingMs.totalMs,
        nicheDurationMs: Math.round(performance.now() - nicheStarted),
      });
    } else {
      console.log('[trend-selection] selected batch topics', {
        userId: params.userId,
        mode: pipelineMode,
        topics: ranked.map((item) => ({
          title: item.trend.topic,
          publisher: item.trend.publisher,
          discoverySource: item.trend.discoverySource,
          intent: item.trend.discoveryIntent ?? null,
          dynamicCategory: item.trend.strategyReasons?.find((reason) => reason.startsWith('category_match:'))?.split(':')[1] ?? null,
          supportingSourceCount: item.trend.supportingSources?.length ?? 0,
          evidenceRole: item.trend.evidenceRole ?? 'idea_only',
          angleType: item.trend.angleType ?? null,
          relevanceScore: item.relevanceScore,
          confidence: item.trend.strategyScore ?? 0,
          cluster: item.fingerprint.topicCluster,
          normalizedTopic: item.fingerprint.normalizedTopic,
          score: Math.round(item.totalScore),
        })),
        stats: aggregateStats,
      });
    }

    return {
      eligible: rankedToTrendCandidates(ranked),
      ranked,
      expansionPlans,
      stats: aggregateStats,
      timingMs,
      qualifiedRanked: dedupeCrossNicheQualifiedTopics(allRanked),
      evidenceOnlyRanked: dedupeCrossNicheQualifiedTopics(allEvidenceOnlyRanked),
      rejectedSearchRanked: dedupeCrossNicheQualifiedTopics(allRejectedSearchRanked),
    };
  }

  async buildTrendPoolForBatch(
    params: Omit<RankedTrendPoolParams, 'mode'> & {
      mode?: 'batch' | 'generation';
      reuseRanked?: RankedTrendCandidate[];
    },
  ): Promise<OrchestratedTrendPool> {
    const requested = params.slotCount ?? params.limit ?? 7;
    const generationSearchRun: GenerationSearchRun = {
      runId: `generation-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      executedRequestKeys: new Set(), exhaustedQueries: new Set(), currentRunFetches: new Map(),
      hardEligibleByNiche: new Map(),
      hardEligibleCountsByNiche: new Map(),
    };
    const exhaustedNiches = new Set<string>();
    let accumulated: RankedTrendCandidate[] = [];
    let accumulatedEvidenceOnly: RankedTrendCandidate[] = [];
    let accumulatedRejectedSearch: RankedTrendCandidate[] = [];
    let latest: OrchestratedTrendPool | null = null;
    const totals = {
      rawCount: 0,
      rejectedLowValue: 0,
      rejectedByExclusions: 0,
      exactDuplicatesRemoved: 0,
      nearDuplicatesRemoved: 0,
      historyMatchesRemoved: 0,
      fingerprinted: 0,
      selected: 0,
      evergreenFilled: 0,
      openAiCalls: 0,
      sourceRequestCount: 0,
      cacheHits: 0,
      cacheMisses: 0,
    };

    for (let searchAttempt = 0; searchAttempt < 4; searchAttempt++) {
      const pass = await this.getRankedTrendPool({
        ...params,
        mode: params.mode ?? 'generation',
        searchAttempt,
        generationSearchRun,
        exhaustedNiches,
      });
      latest = pass;
      accumulated = dedupeCrossNicheQualifiedTopics([...accumulated, ...(pass.qualifiedRanked ?? pass.ranked)]);
      accumulatedEvidenceOnly = dedupeCrossNicheQualifiedTopics([...accumulatedEvidenceOnly, ...(pass.evidenceOnlyRanked ?? [])]);
      accumulatedRejectedSearch = dedupeCrossNicheQualifiedTopics([...accumulatedRejectedSearch, ...(pass.rejectedSearchRanked ?? [])]);
      for (const key of Object.keys(totals) as Array<keyof typeof totals>) {
        if (key === 'selected' || key === 'evergreenFilled') continue;
        totals[key] += Number(pass.stats[key] ?? 0);
      }
      totals.selected = Math.min(requested, accumulated.length);

      console.info('[trend-orchestration] generation search pass completed', {
        userId: params.userId,
        generationSearchRunId: generationSearchRun.runId,
        attempt: searchAttempt + 1,
        requested,
        qualifiedThisPass: pass.ranked.length,
        qualifiedAccumulated: accumulated.length,
      });
      const everyNicheAtTarget = params.niches.every((niche) => (generationSearchRun.hardEligibleCountsByNiche.get(niche) ?? 0) >= 20);
      if (everyNicheAtTarget) break;
      if (exhaustedNiches.size >= params.niches.length) break;
    }

    if (!latest) return this.getRankedTrendPool({ ...params, mode: params.mode ?? 'generation' });
    const finalSelection = selectFinalBatchCandidates(accumulated, requested);
    return {
      ...latest,
      ranked: finalSelection.selected,
      eligible: rankedToTrendCandidates(finalSelection.selected),
      qualifiedRanked: accumulated,
      evidenceOnlyRanked: accumulatedEvidenceOnly,
      rejectedSearchRanked: accumulatedRejectedSearch,
      stats: totals,
    };
  }

  async upgradeStoredPreviewPool(params: {
    userId: string;
    previewCandidates: RankedTrendCandidate[];
    author: AuthorContext;
    strategy?: EffectiveBotStrategy;
    plans: NicheExpansionPlan[];
    slotCount: number;
  }): Promise<{ ranked: RankedTrendCandidate[]; eligible: TrendCandidate[]; openAiCalls: number }> {
    const { upgradePreviewPoolForGeneration } = await import('./trendSelectionService');
    return upgradePreviewPoolForGeneration({
      ...params,
      fingerprintService: this.fingerprintService,
    });
  }
}

export function rankedToPreviewItems(ranked: RankedTrendCandidate[]): PreviewTrendItem[] {
  return ranked.map((r) => ({
    title: r.trend.topic,
    link: r.trend.link ?? '',
    pubDate: r.trend.publishedAt ? String(r.trend.publishedAt) : undefined,
    source: r.trend.source,
    publisher: r.trend.publisher,
    discoverySource: r.trend.discoverySource,
    niche: r.trend.niche,
    searchQuery: r.trend.searchQuery,
    score: Math.round(r.totalScore),
    relevanceScore: r.relevanceScore,
    recencyScore: r.recencyScore,
    sourceQualityScore: r.sourceQualityScore,
    noveltyScore: r.noveltyScore,
    contentType: r.contentType,
    cluster: r.fingerprint.topicCluster,
    matchedPillar: r.matchedPillar,
    suggestedAngle: r.suggestedAngle,
    audienceRelevance: r.audienceRelevance,
  }));
}

export function rankedToLegacyTrends(ranked: RankedTrendCandidate[]): Trend[] {
  return ranked.map((r) => ({
    title: r.trend.topic,
    link: r.trend.link ?? '',
    pubDate: r.trend.publishedAt ? String(r.trend.publishedAt) : '',
    source: r.trend.source ?? '',
    publisher: r.trend.publisher,
    discoverySource: r.trend.discoverySource,
    rawTitle: r.trend.rawTitle,
    niche: r.trend.niche,
    searchQuery: r.trend.searchQuery,
  }));
}
