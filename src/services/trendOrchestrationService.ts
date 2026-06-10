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
import { fillEvergreenIfNeeded, rankedToTrendCandidates } from './trendDiversityService';
import { selectPreviewRankedCandidates } from './trendRankingService';
import { TrendsService } from './trendsService';
import type { Trend } from './trendsService';
import { mapWithConcurrency } from './concurrencyUtils';
import { PipelineTimer } from './trendPipelineTiming';

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
  customFeeds: string[];
  customLinks: string[];
  customRedditFeeds: string[];
  limit?: number;
  slotCount?: number;
  mode: 'preview' | 'batch' | 'generation';
  reuseRanked?: RankedTrendCandidate[];
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
    const perNicheLimit = Math.max(
      6,
      Math.ceil(candidateTarget / Math.max(1, params.niches.length)),
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
        const plan = await this.resolveExpansionPlan(params.userId, niche);

        let rawTrends: Trend[] = [];
        try {
          rawTrends = await this.trendsService.fetchTrendsWithInput({
            niche,
            queries: plan.queries,
            exclusions: plan.exclusions,
            sources: params.sources,
            customFeeds: params.customFeeds,
            customLinks: params.customLinks,
            customRedditFeeds: params.customRedditFeeds,
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
            queryCount: plan.queries.length,
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
      : allRanked.slice(0, limit);

    if (pipelineMode === 'generation' && ranked.length < limit) {
      const { extra, filled } = await fillEvergreenIfNeeded(
        params.userId,
        params.author,
        expansionPlans,
        ranked,
        limit - ranked.length,
      );
      aggregateStats.evergreenFilled = filled;

      for (const t of extra) {
        const fp = t.fingerprint ?? (await this.fingerprintService.fingerprintTrend(t));
        aggregateStats.openAiCalls = (aggregateStats.openAiCalls ?? 0) + 1;
        ranked.push({
          trend: { ...t, fingerprint: fp },
          fingerprint: fp,
          relevanceScore: 55,
          sourceQualityScore: 50,
          recencyScore: 40,
          technicalDepthScore: 50,
          noveltyScore: 70,
          totalScore: 55,
          novelty: { allowed: true, score: 70, reasons: ['evergreen_fallback'] },
        });
      }
      ranked = ranked.slice(0, limit);
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
    return this.getRankedTrendPool({ ...params, mode: params.mode ?? 'generation' });
  }

  async upgradeStoredPreviewPool(params: {
    userId: string;
    previewCandidates: RankedTrendCandidate[];
    author: AuthorContext;
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
