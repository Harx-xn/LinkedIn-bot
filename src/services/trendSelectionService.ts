import { TOPIC_DIVERSITY_CONFIG } from '../config/topicDiversityConfig';
import { getPipelineConfig, toPipelineMode, type TrendPipelineMode } from '../config/trendPipelineConfig';
import { buildFallbackExpansionPlan } from './nicheExpansionService';
import type {
  AuthorContext,
  NicheExpansionPlan,
  RankedTrendCandidate,
  TopicFingerprint,
  TrendCandidate,
  TrendPoolStats,
} from './generationTypes';
import { TopicFingerprintService } from './topicFingerprintService';
import { loadRecentTopicHistory, type TopicHistoryRow } from './topicHistoryService';
import { evaluateTopicNovelty } from './topicNoveltyService';
import { classifyTrendContentType } from './trendContentType';
import { scoreDiscoverySourceQuality } from './trendPublisherUtils';
import {
  exactDedupeTrends,
  filterLowValueTrends,
  nearDedupeTrends,
} from './trendTitleUtils';
import type { Trend } from './trendsService';
import { jaccardSimilarity } from './ghostwriterTextUtils';
import { selectDiverseRankedCandidates, selectPreviewRankedCandidates } from './trendRankingService';
import {
  buildDeterministicTopicFingerprint,
  deterministicNearDedupeTrends,
} from './deterministicTrendFingerprint';
import {
  buildPreviewScoreInput,
  calculatePreviewScore,
} from './trendPreviewScore';
import type { EffectiveBotStrategy } from './botStrategyService';
import { scoreTrendForStrategy } from './botStrategyTrendService';

export type TrendSelectionStats = TrendPoolStats & {
  openAiCalls?: number;
};

function toTrendCandidate(trend: Trend, niche: string, exclusions: string[]): TrendCandidate {
  return {
    topic: trend.title,
    link: trend.link,
    source: trend.source,
    publisher: trend.publisher,
    discoverySource: trend.discoverySource,
    rawTitle: trend.rawTitle,
    publishedAt: trend.pubDate,
    niche,
    searchQuery: trend.searchQuery,
    exclusions,
    summary: trend.summary,
    keyPoints: trend.keyPoints,
  };
}

export function countUsableTrends(
  rawTrends: Trend[],
  niche: string,
  exclusions: string[],
): number {
  const candidates = rawTrends.map((t) => toTrendCandidate(t, niche, exclusions));
  const { accepted } = filterLowValueTrends(candidates, exclusions);
  return exactDedupeTrends(accepted).length;
}

function relevanceScore(trend: TrendCandidate, author: AuthorContext, plan: NicheExpansionPlan): number {
  const topic = trend.topic.toLowerCase();
  let score = 50;
  const niches = author.niches ?? [plan.niche];
  for (const niche of niches) {
    if (topic.includes(niche.toLowerCase())) score += 20;
  }
  for (const sub of plan.subtopics) {
    if (topic.includes(sub.toLowerCase())) score += 8;
  }
  const authorOverlap = jaccardSimilarity(topic, author.description ?? '');
  score += Math.round(authorOverlap * 20);
  return Math.max(0, Math.min(100, score));
}

function sourceQualityScore(trend: TrendCandidate): number {
  return scoreDiscoverySourceQuality(trend.discoverySource ?? trend.source, trend.publisher);
}

function recencyScore(publishedAt?: string | Date | null): number {
  if (!publishedAt) return 40;
  const t = Date.parse(String(publishedAt));
  if (!Number.isFinite(t)) return 40;
  const days = (Date.now() - t) / (1000 * 60 * 60 * 24);
  if (days <= 1) return 100;
  if (days <= 7) return 85;
  if (days <= 30) return 65;
  if (days <= 90) return 45;
  return 25;
}

function technicalDepthScore(topic: string): number {
  if (/\b(how to|guide|architecture|pattern|research|study|analysis|implementation|framework|api|database|queue|deploy)\b/i.test(topic)) {
    return 75;
  }
  return 45;
}

function rankGenerationCandidate(
  trend: TrendCandidate,
  fingerprint: TopicFingerprint,
  author: AuthorContext,
  plan: NicheExpansionPlan,
  history: TopicHistoryRow[],
): RankedTrendCandidate {
  const novelty = evaluateTopicNovelty(fingerprint, history);
  const relevance = relevanceScore(trend, author, plan);
  const sourceQ = sourceQualityScore(trend);
  const recency = recencyScore(trend.publishedAt);
  const depth = technicalDepthScore(trend.topic);
  const totalScore =
    relevance * 0.30
    + sourceQ * 0.15
    + recency * 0.15
    + depth * 0.15
    + novelty.score * 0.25;

  const strategyScore = author.strategy
    ? scoreTrendForStrategy(trend, author.strategy, { recentHistory: history, fingerprint })
    : null;
  const adjustedTotalScore = strategyScore
    ? totalScore * 0.65 + strategyScore.score * 0.35
    : totalScore;

  return {
    trend: {
      ...trend,
      fingerprint,
      contentType: classifyTrendContentType(trend),
      matchedPillar: strategyScore?.matchedPillar,
      suggestedAngle: strategyScore?.suggestedAngle,
      audienceRelevance: strategyScore?.audienceRelevance,
      strategyScore: strategyScore?.score,
      strategyReasons: strategyScore?.reasons,
      strategyRiskFlags: strategyScore?.riskFlags,
    },
    fingerprint,
    relevanceScore: relevance,
    sourceQualityScore: sourceQ,
    recencyScore: recency,
    technicalDepthScore: depth,
    noveltyScore: novelty.score,
    totalScore: adjustedTotalScore,
    novelty,
    contentType: classifyTrendContentType(trend),
    matchedPillar: strategyScore?.matchedPillar,
    suggestedAngle: strategyScore?.suggestedAngle,
    audienceRelevance: strategyScore?.audienceRelevance,
  };
}

function rankPreviewCandidate(
  trend: TrendCandidate,
  fingerprint: TopicFingerprint,
  author: AuthorContext,
  plan: NicheExpansionPlan,
): RankedTrendCandidate {
  const relevance = relevanceScore(trend, author, plan);
  const previewInput = buildPreviewScoreInput(trend, relevance);
  const totalScore = calculatePreviewScore(previewInput);
  const strategyScore = author.strategy
    ? scoreTrendForStrategy(trend, author.strategy, { fingerprint })
    : null;
  const adjustedTotalScore = strategyScore
    ? totalScore * 0.65 + strategyScore.score * 0.35
    : totalScore;

  return {
    trend: {
      ...trend,
      fingerprint,
      contentType: classifyTrendContentType(trend),
      matchedPillar: strategyScore?.matchedPillar,
      suggestedAngle: strategyScore?.suggestedAngle,
      audienceRelevance: strategyScore?.audienceRelevance,
      strategyScore: strategyScore?.score,
      strategyReasons: strategyScore?.reasons,
      strategyRiskFlags: strategyScore?.riskFlags,
    },
    fingerprint,
    relevanceScore: relevance,
    sourceQualityScore: previewInput.sourceQualityScore,
    recencyScore: previewInput.recencyScore,
    technicalDepthScore: technicalDepthScore(trend.topic),
    noveltyScore: 100,
    totalScore: adjustedTotalScore,
    novelty: { allowed: true, score: 100, reasons: [] },
    contentType: classifyTrendContentType(trend),
    matchedPillar: strategyScore?.matchedPillar,
    suggestedAngle: strategyScore?.suggestedAngle,
    audienceRelevance: strategyScore?.audienceRelevance,
  };
}

/** @deprecated use selectDiverseRankedCandidates from trendRankingService */
export function selectDiverseCandidates(
  ranked: RankedTrendCandidate[],
  limit: number,
  maxPerCluster = TOPIC_DIVERSITY_CONFIG.maxPerClusterInBatch,
): RankedTrendCandidate[] {
  return selectDiverseRankedCandidates(ranked, limit, {
    caps: { maxPerSemanticCluster: maxPerCluster },
  });
}

export async function processTrendCandidates(params: {
  userId: string;
  rawTrends: Trend[];
  niche: string;
  plan: NicheExpansionPlan;
  author: AuthorContext;
  limit: number;
  fingerprintService: TopicFingerprintService;
  history?: TopicHistoryRow[];
  mode?: 'preview' | 'batch' | 'generation';
  pipelineMode?: TrendPipelineMode;
  strategy?: EffectiveBotStrategy;
}): Promise<{ ranked: RankedTrendCandidate[]; selected: RankedTrendCandidate[]; stats: TrendSelectionStats }> {
  const pipelineMode = params.pipelineMode ?? toPipelineMode(params.mode ?? 'generation');
  const cfg = getPipelineConfig(pipelineMode);
  const exclusions = params.plan.exclusions ?? [];

  const { accepted, rejected } = filterLowValueTrends(
    params.rawTrends.map((t) => toTrendCandidate(t, params.niche, exclusions)),
    exclusions,
  );
  const rejectedByExclusions = rejected.filter((r) => r.code?.startsWith('exclusion:')).length;
  const rejectedLowValue = rejected.length - rejectedByExclusions;
  const rejectionCodes = rejected.reduce<Record<string, number>>((counts, item) => {
    counts[item.code] = (counts[item.code] ?? 0) + 1;
    return counts;
  }, {});

  const afterExact = exactDedupeTrends(accepted);
  const exactDuplicatesRemoved = accepted.length - afterExact.length;

  const nearThreshold = cfg.nearDuplicateThreshold;
  const nearResult = pipelineMode === 'preview'
    ? deterministicNearDedupeTrends(afterExact, nearThreshold)
    : nearDedupeTrends(afterExact, nearThreshold);
  let candidates = nearResult.kept;
  const nearDuplicatesRemoved = nearResult.removed;
  const strategy = params.strategy ?? params.author.strategy;
  let rejectedByStrategy = 0;
  const strategyRejectionFlags: Record<string, number> = {};

  if (strategy && pipelineMode === 'preview') {
    const strategyAccepted = candidates.filter((candidate) => {
      const score = scoreTrendForStrategy(candidate, strategy);
      if (score.accepted) return true;
      rejectedByStrategy++;
      return false;
    });
    // Preview is a view over real fetched trends, not a generation gate. If
    // strict strategy scoring rejects every otherwise-safe candidate, retain
    // the fetched pool and let relevance ranking put the best matches first.
    // This is niche-agnostic and avoids inventing hard-coded fallback topics.
    if (strategyAccepted.length > 0) {
      candidates = strategyAccepted;
    } else if (candidates.length > 0) {
      console.info({
        event: 'trend_preview_strategy_filter_relaxed',
        userId: params.userId,
        niche: params.niche,
        candidateCount: candidates.length,
      });
      rejectedByStrategy = 0;
    }
  }

  const preRanked = candidates
    .map((t) => ({
      trend: t,
      preScore:
        relevanceScore(t, params.author, params.plan)
        + sourceQualityScore(t)
        + recencyScore(t.publishedAt),
    }))
    .sort((a, b) => b.preScore - a.preScore)
    .slice(0, cfg.maxFingerprintCandidates || cfg.maxCandidatesPerNiche)
    .map((x) => x.trend);

  let openAiCalls = 0;
  const ranked: RankedTrendCandidate[] = [];
  let historyMatchesRemoved = 0;

  if (pipelineMode === 'preview') {
    for (const trend of preRanked) {
      const fp = buildDeterministicTopicFingerprint(trend);
      ranked.push(rankPreviewCandidate(trend, fp, params.author, params.plan));
    }
  } else {
    const history = params.history ?? (cfg.useHistoryMatching
      ? await loadRecentTopicHistory(params.userId)
      : []);
    const fingerprintLimit = cfg.maxFingerprintCandidates;
    const toFingerprint = preRanked.slice(0, fingerprintLimit);
    if (strategy) {
      const beforeStrategy = toFingerprint.length;
      const strategyAccepted = toFingerprint.filter((candidate) => {
        const score = scoreTrendForStrategy(candidate, strategy, { recentHistory: history });
        if (!score.accepted) {
          for (const flag of score.riskFlags ?? ['strategy_rejected']) {
            strategyRejectionFlags[flag] = (strategyRejectionFlags[flag] ?? 0) + 1;
          }
        }
        return score.accepted;
      });
      rejectedByStrategy += beforeStrategy - strategyAccepted.length;
      toFingerprint.length = 0;
      toFingerprint.push(...strategyAccepted);
    }

    if (cfg.useAiFingerprints) {
      await params.fingerprintService.fingerprintTrends(
        toFingerprint,
        TOPIC_DIVERSITY_CONFIG.fingerprintConcurrency,
      );
      openAiCalls = toFingerprint.length;
    }

    for (const trend of toFingerprint) {
      const fp = cfg.useAiFingerprints
        ? (params.fingerprintService.getCached(trend)
          ?? (await params.fingerprintService.fingerprintTrend(trend)))
        : buildDeterministicTopicFingerprint(trend);

      const item = rankGenerationCandidate(trend, fp, params.author, params.plan, history);
      if (!item.novelty.allowed) historyMatchesRemoved++;
      ranked.push(item);

      if (cfg.logPerCandidate) {
        console.log('[trend-selection] candidate evaluated', {
          userId: params.userId,
          title: trend.topic.slice(0, 80),
          niche: params.niche,
          publisher: trend.publisher,
          discoverySource: trend.discoverySource,
          cluster: fp.topicCluster,
          relevanceScore: item.relevanceScore,
          sourceQualityScore: item.sourceQualityScore,
          recencyScore: item.recencyScore,
          noveltyScore: item.noveltyScore,
          totalScore: Math.round(item.totalScore),
          noveltyReasons: item.novelty.reasons,
        });
      }
    }
  }

  const selected = pipelineMode === 'preview'
    ? selectPreviewRankedCandidates(ranked, params.limit)
    : selectDiverseRankedCandidates(ranked, params.limit, {
      caps: { maxPerSemanticCluster: TOPIC_DIVERSITY_CONFIG.maxPerClusterInBatch },
    });

  if (pipelineMode === 'generation') {
    console.info('[trend-selection] quality funnel', {
      userId: params.userId,
      niche: params.niche,
      raw: params.rawTrends.length,
      rejectedByHeadlineRules: rejected.length,
      rejectionCodes,
      rejectedByStrategy,
      strategyRejectionFlags,
      fingerprinted: Math.max(0, preRanked.length - rejectedByStrategy),
      ranked: ranked.length,
      selected: selected.length,
    });
  }

  return {
    ranked: ranked.sort((a, b) => b.totalScore - a.totalScore),
    selected,
    stats: {
      rawCount: params.rawTrends.length,
      rejectedLowValue: rejectedLowValue + rejectedByStrategy,
      rejectedByExclusions,
      exactDuplicatesRemoved,
      nearDuplicatesRemoved,
      historyMatchesRemoved,
      fingerprinted: preRanked.length,
      selected: selected.length,
      evergreenFilled: 0,
      openAiCalls,
    },
  };
}

/** Re-run generation-quality fingerprinting and history checks on a saved preview pool. */
export async function upgradePreviewPoolForGeneration(params: {
  userId: string;
  previewCandidates: RankedTrendCandidate[];
  author: AuthorContext;
  strategy?: EffectiveBotStrategy;
  plans: NicheExpansionPlan[];
  slotCount: number;
  fingerprintService: TopicFingerprintService;
}): Promise<{ ranked: RankedTrendCandidate[]; eligible: TrendCandidate[]; openAiCalls: number }> {
  const cfg = getPipelineConfig('generation');
  const history = await loadRecentTopicHistory(params.userId);
  const planByNiche = new Map(params.plans.map((p) => [p.niche, p]));

  const trends = params.previewCandidates.map((c) => c.trend);
  let openAiCalls = 0;

  if (cfg.useAiFingerprints) {
    await params.fingerprintService.fingerprintTrends(
      trends,
      TOPIC_DIVERSITY_CONFIG.fingerprintConcurrency,
    );
    openAiCalls = trends.length;
  }

  const ranked: RankedTrendCandidate[] = [];
  for (const candidate of params.previewCandidates) {
    const plan = planByNiche.get(candidate.trend.niche ?? '')
      ?? params.plans[0]
      ?? buildFallbackExpansionPlan(candidate.trend.niche ?? 'general');
    const fp = cfg.useAiFingerprints
      ? (params.fingerprintService.getCached(candidate.trend)
        ?? (await params.fingerprintService.fingerprintTrend(candidate.trend)))
      : candidate.fingerprint;
    ranked.push(rankGenerationCandidate(candidate.trend, fp, params.author, plan, history));
  }

  ranked.sort((a, b) => b.totalScore - a.totalScore);
  const selected = selectDiverseRankedCandidates(ranked, params.slotCount, {
    caps: { maxPerSemanticCluster: TOPIC_DIVERSITY_CONFIG.maxPerClusterInBatch },
  });

  return {
    ranked: selected,
    eligible: selected.map((s) => s.trend),
    openAiCalls,
  };
}
