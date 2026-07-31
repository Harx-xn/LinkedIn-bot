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
import { flattenExpansionQueries, NicheExpansionService, validateExpansionQuery } from './nicheExpansionService';
import { TopicFingerprintService } from './topicFingerprintService';
import { applyBatchEvidenceComposition, processTrendCandidates } from './trendSelectionService';
import { rankedToTrendCandidates } from './trendDiversityService';
import { selectDiverseRankedCandidates, selectNicheBalancedCandidates, selectPreviewRankedCandidates } from './trendRankingService';
import { TrendsService } from './trendsService';
import type { Trend } from './trendsService';
import { mapWithConcurrency } from './concurrencyUtils';
import { PipelineTimer } from './trendPipelineTiming';
import type { EffectiveBotStrategy } from './botStrategyService';
import { buildStrategyExpansionPlan } from './botStrategyTrendService';

export type OrchestratedTrendPool = {
  eligible: TrendCandidate[];
  ranked: RankedTrendCandidate[];
  expansionPlans: NicheExpansionPlan[];
  stats: TrendPoolStats & { openAiCalls?: number; sourceRequestCount?: number; cacheHits?: number; cacheMisses?: number };
  timingMs?: ReturnType<PipelineTimer['finish']>;
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
};

export type RankedTrendPoolResult = OrchestratedTrendPool;
export const MIN_EXECUTABLE_QUERIES_PER_NICHE = 4;

export class InsufficientValidQueriesError extends Error {
  constructor(public readonly niche: string, public readonly diagnostics: Array<{ query: string; reasons: string[] }>) {
    super(`insufficient_valid_queries:${niche}`);
    this.name = 'InsufficientValidQueriesError';
  }
}

export function validatePlanQueries(plan: NicheExpansionPlan): {
  executable: string[];
  rejected: Array<{ query: string; reasons: string[] }>;
} {
  const executable: string[] = [];
  const rejected: Array<{ query: string; reasons: string[] }> = [];
  for (const query of [...new Set(flattenExpansionQueries(plan))]) {
    const result = validateExpansionQuery(query, plan.niche, plan.subtopics, executable, plan);
    if (result.valid && result.confidence >= 0.7) executable.push(query);
    else rejected.push({ query, reasons: result.reasons });
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
): string[] {
  if (searchAttempt <= 0) return [];
  const nicheKey = normalizeQueryPart(niche);
  const orderedQueries = plan.profileQueries?.length
    ? [...plan.profileQueries]
        .filter((item) => item.confidence >= 0.7)
        .sort((a, b) => b.confidence - a.confidence)
        .map((item) => item.query)
    : plan.queries;
  const uniqueQueries = [...new Map(orderedQueries
    .map((query) => [normalizeQueryPart(query), query.trim()] as const)
    .filter(([key]) => key && key !== nicheKey)).values()];
  const offset = (searchAttempt - 1) * MIN_EXECUTABLE_QUERIES_PER_NICHE;
  return uniqueQueries.slice(offset, offset + MIN_EXECUTABLE_QUERIES_PER_NICHE);
}

export class TrendOrchestrationService {
  private trendsService: TrendsService;
  private nicheExpansion: NicheExpansionService;
  private fingerprintService: TopicFingerprintService;

  constructor(openaiApiKey?: string | null) {
    this.trendsService = new TrendsService();
    this.nicheExpansion = new NicheExpansionService(openaiApiKey);
    this.fingerprintService = new TopicFingerprintService(openaiApiKey);
  }

  async resolveExpansionPlan(userId: string, niche: string): Promise<NicheExpansionPlan> {
    try {
      return await this.nicheExpansion.getOrCreatePlan(userId, niche);
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

    const candidateTarget = targetCandidateCount(pipelineMode, limit);
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
      stats: TrendPoolStats & { openAiCalls?: number };
      rawFetched: number;
      queryCount: number;
      durationMs: number;
    };

    const nicheStarted = performance.now();
    const nicheResults = await mapWithConcurrency(
      params.niches,
      cfg.nicheConcurrency,
      async (niche): Promise<NicheResult> => {
        const nicheTimer = performance.now();
        let cachedPlan = await this.resolveExpansionPlan(params.userId, niche);
        let basePlan = params.strategy
          ? buildStrategyExpansionPlan(params.strategy, niche, cachedPlan)
          : cachedPlan;
        let queryValidation = validatePlanQueries(basePlan);
        if (queryValidation.executable.length < MIN_EXECUTABLE_QUERIES_PER_NICHE) {
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
          );
          basePlan = params.strategy
            ? buildStrategyExpansionPlan(params.strategy, niche, cachedPlan)
            : cachedPlan;
          queryValidation = validatePlanQueries(basePlan);
        }
        if (queryValidation.executable.length < MIN_EXECUTABLE_QUERIES_PER_NICHE) {
          throw new InsufficientValidQueriesError(niche, queryValidation.rejected);
        }
        const retryQueries = buildFocusedRetryQueries(
          niche,
          basePlan,
          params.searchAttempt ?? 0,
        );
        if ((params.searchAttempt ?? 0) > 0 && retryQueries.length === 0) {
          throw new InsufficientValidQueriesError(niche, [{
            query: '',
            reasons: ['no_unused_valid_retry_queries'],
          }]);
        }
        const plan = retryQueries.length
          ? {
              ...basePlan,
              queries: retryQueries,
              queryBuckets: undefined,
              queryOrigin: 'retry_regenerated' as const,
            }
          : basePlan;
        const executionValidation = validatePlanQueries(plan);
        if (executionValidation.executable.length < MIN_EXECUTABLE_QUERIES_PER_NICHE) {
          throw new InsufficientValidQueriesError(niche, executionValidation.rejected);
        }
        console.info('[trend-query] query pool ready', {
          userId: params.userId,
          niche,
          cachedProfileQueries: cachedPlan.queries.length,
          strategyEnrichedQueries: basePlan.queries.length,
          generatedCandidates: flattenExpansionQueries(plan).length,
          validatedQueries: executionValidation.executable.length,
          executedQueries: Math.min(executionValidation.executable.length, cfg.maxQueriesPerNiche),
          searchAttempt: (params.searchAttempt ?? 0) + 1,
        });

        let rawTrends: Trend[] = [];
        try {
          rawTrends = await this.trendsService.fetchTrendsWithInput({
            niche,
            queries: plan.queries,
            exclusions: plan.exclusions,
            sources: params.sources,
            limit: perNicheLimit,
            expansionPlan: plan,
            pipelineMode,
            candidateTarget: Math.ceil(candidateTarget / params.niches.length),
            requestedCount: limit,
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

        const { ranked, stats } = await processTrendCandidates({
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
        console.info('[trend-orchestration] niche qualification completed', {
          niche,
          providerResults: rawTrends.length,
          exactDuplicatesRemoved: stats.exactDuplicatesRemoved,
          obviousLowValueRemoved: stats.rejectedLowValue,
          plausibleCandidatesBeforeCap: rawTrends.length,
          candidatesAfterCap: rawTrends.length,
          fullyQualified: ranked.length,
        });

        return {
          plan,
          ranked,
          stats,
          rawFetched: rawTrends.length,
          queryCount: plan.queries.length,
          durationMs: Math.round(performance.now() - nicheTimer),
        };
      },
    );

    timer.mark('sourceFetchMs');
    timer.mark('filteringMs');
    timer.mark('deduplicationMs');
    timer.mark('rankingMs');

    const expansionPlans = nicheResults.map((r) => r.plan);
    const allRanked = nicheResults.flatMap((r) => r.ranked);

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

    const fetchMetrics = this.trendsService.getLastFetchMetrics();
    aggregateStats.sourceRequestCount = fetchMetrics.sourceRequestCount;
    aggregateStats.cacheHits = fetchMetrics.cacheHits;
    aggregateStats.cacheMisses = fetchMetrics.cacheMisses;

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
    };
  }

  async buildTrendPoolForBatch(
    params: Omit<RankedTrendPoolParams, 'mode'> & {
      mode?: 'batch' | 'generation';
      reuseRanked?: RankedTrendCandidate[];
    },
  ): Promise<OrchestratedTrendPool> {
    const requested = params.slotCount ?? params.limit ?? 7;
    let accumulated: RankedTrendCandidate[] = [];
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
      });
      latest = pass;
      accumulated = selectNicheBalancedCandidates(
        applyBatchEvidenceComposition([...accumulated, ...pass.ranked], requested),
        requested,
      );
      for (const key of Object.keys(totals) as Array<keyof typeof totals>) {
        if (key === 'selected' || key === 'evergreenFilled') continue;
        totals[key] += Number(pass.stats[key] ?? 0);
      }
      totals.selected = accumulated.length;

      console.info('[trend-orchestration] generation search pass completed', {
        userId: params.userId,
        attempt: searchAttempt + 1,
        requested,
        qualifiedThisPass: pass.ranked.length,
        qualifiedAccumulated: accumulated.length,
      });
      if (accumulated.length >= requested) break;
    }

    if (!latest) return this.getRankedTrendPool({ ...params, mode: params.mode ?? 'generation' });
    return {
      ...latest,
      ranked: accumulated,
      eligible: rankedToTrendCandidates(accumulated),
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
