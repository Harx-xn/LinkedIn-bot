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
import { NicheExpansionService } from './nicheExpansionService';
import { TopicFingerprintService } from './topicFingerprintService';
import { processTrendCandidates } from './trendSelectionService';
import { rankedToTrendCandidates } from './trendDiversityService';
import { selectDiverseRankedCandidates, selectPreviewRankedCandidates } from './trendRankingService';
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
        const basePlan = params.strategy
          ? buildStrategyExpansionPlan(params.strategy, niche)
          : await this.resolveExpansionPlan(params.userId, niche);
        const focusedSeeds = basePlan.subtopics
          .filter((seed) => seed.trim().toLowerCase() !== niche.trim().toLowerCase())
          .slice(0, 3);
        while (focusedSeeds.length < 3) {
          focusedSeeds.push(['product innovation', 'customer adoption', 'market competition'][focusedSeeds.length]);
        }
        const retryQueries = params.searchAttempt === 1
          ? [
              `${niche} ${focusedSeeds[0]} latest news 2026`,
              `${niche} ${focusedSeeds[1]} recent developments 2026`,
              `${niche} ${focusedSeeds[2]} industry analysis 2026`,
            ]
          : params.searchAttempt === 2
            ? [
                `${niche} ${focusedSeeds[0]} case study growth results`,
                `${niche} ${focusedSeeds[1]} funding partnerships acquisitions`,
                `${niche} ${focusedSeeds[2]} challenges opportunities research`,
              ]
            : params.searchAttempt === 3
              ? [
                  `${niche} ${focusedSeeds[0]} founders operators expert insights`,
                  `${niche} ${focusedSeeds[1]} enterprise benchmarks adoption`,
                  `${niche} ${focusedSeeds[2]} market outlook predictions`,
                ]
              : [];
        const plan = retryQueries.length
          ? {
              ...basePlan,
              queries: [...retryQueries, ...basePlan.queries],
              // Retry queries must be authoritative. Otherwise flattenExpansionQueries
              // prefers the cached query buckets and silently repeats pass one.
              queryBuckets: undefined,
            }
          : basePlan;

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
            sourceCount: params.sources.length,
            rawFetched: rawTrends.length,
          });
        } else {
          console.log('[trend-orchestration] raw trends fetched', {
            userId: params.userId,
            niche,
            searchAttempt: (params.searchAttempt ?? 0) + 1,
            queryCount: plan.queries.length,
            querySample: plan.queries.slice(0, 3),
            sourceCount: params.sources.length,
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
      : selectDiverseRankedCandidates(allRanked, limit);

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
      accumulated = selectDiverseRankedCandidates(
        [...accumulated, ...pass.ranked],
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
