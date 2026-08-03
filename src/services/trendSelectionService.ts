import { TOPIC_DIVERSITY_CONFIG } from '../config/topicDiversityConfig';
import { getPipelineConfig, toPipelineMode, type TrendPipelineMode } from '../config/trendPipelineConfig';
import { buildFallbackExpansionPlan } from './nicheExpansionService';
import type {
  AuthorContext,
  CandidateEligibility,
  CandidateNicheMatch,
  NicheExpansionPlan,
  RankedTrendCandidate,
  TopicFingerprint,
  TrendCandidate,
  TrendPoolStats,
} from './generationTypes';
import { buildFallbackFingerprint, TopicFingerprintService } from './topicFingerprintService';
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

const MIN_GENERATION_RELEVANCE = Math.max(1, Number(process.env.TREND_MIN_RELEVANCE ?? 65) || 65);
const MIN_CLASSIFICATION_CONFIDENCE = Math.max(0.01, Number(process.env.TREND_MIN_CLASSIFICATION_CONFIDENCE ?? 0.65) || 0.65);

export function decideCandidateEligibility(
  nicheMatch: CandidateNicheMatch,
  activeStrategy: boolean,
): CandidateEligibility {
  const hardRejectionCodes = nicheMatch.rejectionCodes.filter((code) =>
    code.startsWith('excluded:')
    || code.startsWith('excluded_profile_term:')
    || code.startsWith('recent_duplicate:')
    || code === 'missing_ambiguity_context'
    || code === 'community_source_cannot_verify_solution'
    || code === 'missing_pillar_match'
    || code === 'missing_audience_match',
  );
  if (nicheMatch.avoidTopicMatch) hardRejectionCodes.push('avoid_topic_match');

  const directPath = (nicheMatch.directEvidence?.length ?? 0) > 0
    && nicheMatch.relevanceScore >= MIN_GENERATION_RELEVANCE
    && nicheMatch.confidence >= MIN_CLASSIFICATION_CONFIDENCE;
  const strategyPath = activeStrategy
    && Boolean(nicheMatch.matchedPillar || nicheMatch.matchedMonitorTopic || nicheMatch.matchedCategory || nicheMatch.matchedPlatform || nicheMatch.matchedEntity)
    && nicheMatch.relevanceScore >= 60
    && nicheMatch.confidence >= 0.55;
  const classificationPath = nicheMatch.relevant
    && nicheMatch.relevanceScore >= MIN_GENERATION_RELEVANCE
    && nicheMatch.confidence >= 0.8;
  const acceptancePath = directPath ? 'direct_evidence'
    : strategyPath ? 'strategy_match'
      : classificationPath ? 'high_confidence_classification' : undefined;
  const softSignals: string[] = [];
  if (nicheMatch.relevanceScore < MIN_GENERATION_RELEVANCE) softSignals.push('below_minimum_relevance');
  if (nicheMatch.confidence < MIN_CLASSIFICATION_CONFIDENCE) softSignals.push('low_classification_confidence');
  if (!nicheMatch.matchedMonitorTopic) softSignals.push('no_monitored_topic_match');
  const failedAcceptancePaths = [
    ...(!directPath ? ['direct_evidence_path_failed'] : []),
    ...(!strategyPath ? ['strategy_path_failed'] : []),
    ...(!classificationPath ? ['classification_path_failed'] : []),
  ];
  const eligible = hardRejectionCodes.length === 0 && Boolean(acceptancePath);
  const rejectionCodes = eligible ? [] : [...new Set([
    ...hardRejectionCodes,
    ...(!acceptancePath ? ['no_acceptance_path'] : []),
  ])];
  return { eligible, rejectionCodes, acceptancePath, hardRejectionCodes: [...new Set(hardRejectionCodes)], softSignals, failedAcceptancePaths };
}

function fallbackCluster(match: CandidateNicheMatch | undefined, plan: NicheExpansionPlan): string {
  const value = match?.matchedMonitorTopic
    || match?.matchedPillar
    || match?.matchedCategory
    || match?.matchedPlatform
    || match?.matchedEntity
    || match?.queryIntent
    || plan.normalizedNiche
    || plan.niche;
  return value?.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'unclassified';
}

export type TrendSelectionStats = TrendPoolStats & {
  openAiCalls?: number;
};

export function deriveGroundedSourceAngles(
  ranked: RankedTrendCandidate[],
  history: TopicHistoryRow[],
  maximumAnglesPerSource = 2,
): RankedTrendCandidate[] {
  if (maximumAnglesPerSource < 2) return [];
  const derived: RankedTrendCandidate[] = [];
  const used = new Set<string>();
  for (const item of ranked) {
    const trend = item.trend;
    const sourceId = trend.link || `${trend.publisher ?? ''}:${trend.topic}`;
    if (used.has(sourceId)) continue;
    used.add(sourceId);
    if (trend.evidenceRole !== 'primary' && trend.evidenceRole !== 'strong_secondary') continue;
    if (!item.matchedPillar && !trend.strategyReasons?.some((reason) => reason.startsWith('category_match:'))) continue;
    const supportingText = trend.summary?.split(/[.!?]\s/)[0]?.trim() || trend.keyPoints?.find((point) => !/^(score|comments):/.test(point));
    if (!supportingText || supportingText.length < 30) continue;
    const angleType = trend.discoveryIntent === 'research_or_data' ? 'practical_implication'
      : trend.discoveryIntent === 'risk_or_failure' ? 'risk_or_limitation' : 'why_it_matters';
    const topic = `${item.matchedPillar ?? trend.niche}: ${supportingText}`.slice(0, 180);
    const fingerprint: TopicFingerprint = {
      ...item.fingerprint,
      normalizedTopic: topic.toLowerCase(),
      coreClaim: supportingText,
      topicCluster: `${item.fingerprint.topicCluster}_${angleType}`,
    };
    const novelty = evaluateTopicNovelty(fingerprint, history);
    if (!novelty.allowed) continue;
    derived.push({
      ...item,
      trend: { ...trend, topic, sourceType: 'source_derived_angle', parentSourceId: sourceId, sourceUrl: trend.link, angleType, fingerprint },
      fingerprint, novelty, noveltyScore: novelty.score, totalScore: item.totalScore - 3,
    });
  }
  return derived;
}

export function applyBatchEvidenceComposition(ranked: RankedTrendCandidate[], limit: number): RankedTrendCandidate[] {
  const intentCounts = new Map<string, number>();
  let communityOnly = 0;
  const kept: RankedTrendCandidate[] = [];
  for (const item of [...ranked].sort((a, b) => b.totalScore - a.totalScore)) {
    const intent = item.trend.discoveryIntent ?? 'unclassified';
    if ((intentCounts.get(intent) ?? 0) >= 2) continue;
    const community = item.trend.evidenceRole === 'problem_discovery' || item.trend.evidenceRole === 'question_discovery';
    const communityOnlyItem = community && !(item.trend.supportingSources ?? []).some((source) => source.evidenceRole === 'primary' || source.evidenceRole === 'strong_secondary');
    if (communityOnlyItem && communityOnly >= Math.min(2, limit)) continue;
    kept.push(item);
    intentCounts.set(intent, (intentCounts.get(intent) ?? 0) + 1);
    if (communityOnlyItem) communityOnly++;
  }
  return kept;
}

export function toTrendCandidate(trend: Trend, niche: string, exclusions: string[]): TrendCandidate {
  const originNiche = trend.originNiche ?? trend.niche ?? niche;
  return {
    topic: trend.title,
    link: trend.link,
    source: trend.source,
    publisher: trend.publisher,
    discoverySource: trend.discoverySource,
    rawTitle: trend.rawTitle,
    publishedAt: trend.pubDate,
    niche: originNiche,
    originNiche,
    profileFingerprint: trend.profileFingerprint,
    originatingQuery: trend.originatingQuery ?? trend.searchQuery,
    queryIntent: trend.queryIntent ?? trend.discoveryIntent,
    originatingSource: trend.originatingSource ?? trend.discoverySource ?? trend.source,
    searchQuery: trend.searchQuery,
    exclusions,
    summary: trend.summary,
    keyPoints: trend.keyPoints,
    discoveryIntent: trend.discoveryIntent,
    evidenceRole: trend.evidenceRole,
    supportingSources: trend.supportingSources,
    sourceUrl: trend.link,
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
  let score = 0;
  const niches = author.niches ?? [plan.niche];
  for (const niche of niches) {
    if (topic.includes(niche.toLowerCase())) score += 45;
  }
  for (const sub of plan.subtopics) {
    if (topic.includes(sub.toLowerCase())) score += 15;
  }
  const authorOverlap = jaccardSimilarity(topic, author.description ?? '');
  score += Math.round(authorOverlap * 30);
  return Math.max(0, Math.min(100, score));
}

function sourceQualityScore(trend: TrendCandidate): number {
  const base = scoreDiscoverySourceQuality(trend.discoverySource ?? trend.source, trend.publisher);
  const roleAdjustment = trend.evidenceRole === 'primary' ? 20
    : trend.evidenceRole === 'strong_secondary' ? 10
      : trend.evidenceRole === 'idea_only' ? -20 : 0;
  const listiclePenalty = trend.evidenceRole === 'practitioner' && /\b\d+\s+(best|top)|ultimate guide\b/i.test(trend.topic) ? -20 : 0;
  return Math.max(0, Math.min(100, base + roleAdjustment + listiclePenalty));
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
  const sourceQ = sourceQualityScore(trend);
  const recency = recencyScore(trend.publishedAt);
  const depth = technicalDepthScore(trend.topic);
  const strategyScore = author.strategy
    ? scoreTrendForStrategy(trend, author.strategy, { recentHistory: history, fingerprint, profile: plan })
    : null;
  const relevance = strategyScore?.nicheMatch?.relevanceScore
    ?? strategyScore?.score
    ?? relevanceScore(trend, author, plan);
  const totalScore =
    relevance * 0.45
    + (strategyScore?.score ?? relevance) * 0.25
    + sourceQ * 0.12
    + novelty.score * 0.10
    + recency * 0.08;

  const adjustedTotalScore = totalScore;

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
      qualificationConfidence: strategyScore?.nicheMatch?.confidence,
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
    ? scoreTrendForStrategy(trend, author.strategy, { fingerprint, profile: plan })
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
      qualificationConfidence: strategyScore?.nicheMatch?.confidence,
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

  const normalized = params.rawTrends.map((t) => toTrendCandidate(t, params.niche, exclusions));
  const routed = normalized.filter((candidate) => {
    const valid = candidate.originNiche === params.niche;
    if (!valid) console.error('[trend-selection] candidate routing error', {
      title: candidate.topic,
      originNiche: candidate.originNiche,
      activeQualificationNiche: params.niche,
      profileFingerprint: candidate.profileFingerprint,
      decision: 'rejected',
      rejectionReason: 'origin_niche_mismatch',
    });
    return valid;
  });
  const { accepted, rejected } = filterLowValueTrends(
    routed,
    exclusions,
  );
  const rejectedByExclusions = rejected.filter((r) => r.code?.startsWith('exclusion:')).length;
  const rejectedLowValue = rejected.length - rejectedByExclusions;
  const rejectionCodes = rejected.reduce<Record<string, number>>((counts, item) => {
    counts[item.code] = (counts[item.code] ?? 0) + 1;
    return counts;
  }, {});
  for (const item of rejected) {
    console.info('[trend-selection] candidate rejected by headline rule', {
      title: item.trend.topic.slice(0, 120), niche: params.niche,
      providerQuery: item.trend.searchQuery ?? null,
      hardRejectionReasons: [item.code], finalDecision: 'rejected',
    });
  }

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
  const acceptancePathCounts: Record<string, number> = {};
  const fallbackEligible: Array<{ trend: TrendCandidate; match: CandidateNicheMatch }> = [];

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

  const preRankedCandidates = candidates
    .map((t) => ({
      trend: t,
      preScore:
        relevanceScore(t, params.author, params.plan)
        + sourceQualityScore(t)
        + recencyScore(t.publishedAt),
    }))
    .sort((a, b) => b.preScore - a.preScore);
  const preRanked = (pipelineMode === 'preview'
    ? preRankedCandidates.slice(0, cfg.maxCandidatesPerNiche)
    : preRankedCandidates).map((x) => x.trend);

  let openAiCalls = 0;
  let strategyAcceptedCount = preRanked.length;
  let fingerprintedCount = 0;
  const ranked: RankedTrendCandidate[] = [];
  let historyMatchesRemoved = 0;
  let generationHistory: TopicHistoryRow[] = [];

  if (pipelineMode === 'preview') {
    for (const trend of preRanked) {
      const fp = buildDeterministicTopicFingerprint(trend);
      ranked.push(rankPreviewCandidate(trend, fp, params.author, params.plan));
    }
  } else {
    const history = params.history ?? (cfg.useHistoryMatching
      ? await loadRecentTopicHistory(params.userId)
      : []);
    generationHistory = history;
    const toFingerprint = [...preRanked];
    if (strategy) {
      const beforeStrategy = toFingerprint.length;
      const strategyAccepted = toFingerprint.filter((candidate) => {
        const score = scoreTrendForStrategy(candidate, strategy, { recentHistory: history, profile: params.plan });
        const eligibility = score.nicheMatch
          ? decideCandidateEligibility(score.nicheMatch, true)
          : { eligible: false, rejectionCodes: ['niche_classification_failed'] };
        if (!eligibility.eligible) {
          for (const flag of eligibility.rejectionCodes) {
            strategyRejectionFlags[flag] = (strategyRejectionFlags[flag] ?? 0) + 1;
          }
          console.info('[trend-selection] candidate rejected before fingerprint', {
            userId: params.userId, niche: params.niche, title: candidate.topic.slice(0, 120),
            providerQuery: candidate.searchQuery ?? null,
            queryOrigin: params.plan.queryOrigin ?? null,
            matchedTerms: score.nicheMatch?.matchedTerms ?? [],
            directEvidence: score.nicheMatch?.directEvidence ?? [],
            ...score.breakdown,
            pillarMatch: score.nicheMatch?.matchedPillar ?? null,
            categoryMatch: score.nicheMatch?.matchedCategory ?? null,
            platformMatch: score.nicheMatch?.matchedPlatform ?? null,
            entityMatch: score.nicheMatch?.matchedEntity ?? null,
            monitoredTopicMatch: score.nicheMatch?.matchedMonitorTopic ?? null,
            ambiguityResolved: score.nicheMatch?.ambiguityResolved ?? false,
            classificationConfidence: score.nicheMatch?.confidence ?? 0,
            hardRejectionReasons: eligibility.hardRejectionCodes,
            softNegativeSignals: eligibility.softSignals,
            failedAcceptancePaths: eligibility.failedAcceptancePaths,
            finalDecision: 'rejected',
            originNiche: candidate.originNiche,
            activeQualificationNiche: params.niche,
            profileFingerprint: candidate.profileFingerprint ?? params.plan.inputFingerprint ?? null,
            matchedActivePillar: score.nicheMatch?.matchedPillar ?? null,
            matchedForeignPillars: score.nicheMatch?.matchedForeignPillars ?? [],
            matchedEntity: score.nicheMatch?.matchedEntity ?? null,
            matchedAlias: score.nicheMatch?.matchedAlias ?? null,
            pillarSatisfied: score.nicheMatch?.activeNicheEvidence?.pillarSatisfied ?? false,
            pillarSatisfiedBy: score.nicheMatch?.activeNicheEvidence?.pillarSatisfiedBy ?? null,
            matchedEntities: score.nicheMatch?.activeNicheEvidence?.matchedEntities ?? [],
            matchedAliases: score.nicheMatch?.activeNicheEvidence?.matchedAliases ?? [],
            matchedPlatforms: score.nicheMatch?.activeNicheEvidence?.matchedPlatforms ?? [],
            evidenceStrength: score.nicheMatch?.activeNicheEvidence?.strength ?? 0,
            ambiguityResolutionReason: score.nicheMatch?.activeNicheEvidence?.ambiguityResolutionReason ?? null,
            finalRelevanceScore: score.score,
            decision: 'rejected',
          });
          if (score.nicheMatch
            && (score.nicheMatch.directEvidence?.length ?? 0) > 0
            && (eligibility.hardRejectionCodes?.length ?? 0) === 0
            && score.nicheMatch.relevanceScore >= 50
            && score.nicheMatch.confidence >= 0.45
            && sourceQualityScore(candidate) >= 40
            && candidate.topic.trim().length >= 20) {
            fallbackEligible.push({ trend: candidate, match: score.nicheMatch });
          }
        } else if (eligibility.acceptancePath) {
          acceptancePathCounts[eligibility.acceptancePath] = (acceptancePathCounts[eligibility.acceptancePath] ?? 0) + 1;
        }
        return eligibility.eligible;
      });
      rejectedByStrategy += beforeStrategy - strategyAccepted.length;
      toFingerprint.length = 0;
      toFingerprint.push(...strategyAccepted);
      strategyAcceptedCount = strategyAccepted.length;
    }

    fingerprintedCount = toFingerprint.length;

    if (cfg.useAiFingerprints) {
      await params.fingerprintService.fingerprintTrends(
        toFingerprint,
        TOPIC_DIVERSITY_CONFIG.fingerprintConcurrency,
        params.plan,
      );
      openAiCalls = toFingerprint.length;
    }

    for (const trend of toFingerprint) {
      let fp = cfg.useAiFingerprints
        ? (params.fingerprintService.getCached(trend)
          ?? (await params.fingerprintService.fingerprintTrend(trend, params.plan)))
        : buildFallbackFingerprint(trend, params.plan);
      if (strategy && fp.topicCluster === 'unclassified') {
        const classification = scoreTrendForStrategy(trend, strategy, { recentHistory: history, fingerprint: fp, profile: params.plan }).nicheMatch;
        fp = { ...fp, topicCluster: fallbackCluster(classification, params.plan) };
      }

      const item = rankGenerationCandidate(trend, fp, params.author, params.plan, history);
      if (!item.novelty.allowed) {
        historyMatchesRemoved++;
        const matchedHistory = history.find((row) => row.id === item.novelty.closestMatch?.historyId);
        console.info('[trend-history] candidate rejected', {
          candidateTitle: trend.topic,
          originNiche: trend.originNiche ?? trend.niche ?? params.niche,
          matchedHistoryTopic: matchedHistory?.normalizedTopic ?? null,
          matchedHistoryNiche: null,
          similarity: item.novelty.closestMatch?.similarity ?? null,
          rejectionReason: item.novelty.reasons[0] ?? 'history_match',
        });
      }
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
          relevanceComponents: strategy
            ? scoreTrendForStrategy(trend, strategy, { recentHistory: history, fingerprint: fp, profile: params.plan }).breakdown
            : undefined,
          originNiche: trend.originNiche,
          activeQualificationNiche: params.niche,
          profileFingerprint: trend.profileFingerprint ?? params.plan.inputFingerprint ?? null,
          matchedActivePillar: item.matchedPillar ?? null,
          matchedForeignPillars: strategy ? scoreTrendForStrategy(trend, strategy, { profile: params.plan }).nicheMatch?.matchedForeignPillars ?? [] : [],
          matchedEntity: strategy ? scoreTrendForStrategy(trend, strategy, { profile: params.plan }).nicheMatch?.matchedEntity ?? null : null,
          matchedAlias: strategy ? scoreTrendForStrategy(trend, strategy, { profile: params.plan }).nicheMatch?.matchedAlias ?? null : null,
          directNicheEvidence: strategy ? scoreTrendForStrategy(trend, strategy, { profile: params.plan }).breakdown.directNicheEvidence : 0,
          activeNicheEvidence: strategy ? scoreTrendForStrategy(trend, strategy, { profile: params.plan }).nicheMatch?.activeNicheEvidence : undefined,
          finalRelevanceScore: item.relevanceScore,
          decision: item.novelty.allowed ? 'qualified' : 'rejected',
        });
      }
    }
  }

  if (pipelineMode === 'generation' && ranked.length < params.limit) {
    ranked.push(...deriveGroundedSourceAngles(ranked, generationHistory, 2).slice(0, params.limit - ranked.length));
  }

  let selected = pipelineMode === 'preview'
    ? selectPreviewRankedCandidates(ranked, params.limit)
    : selectDiverseRankedCandidates(applyBatchEvidenceComposition(ranked, params.limit), params.limit, {
      caps: { maxPerSemanticCluster: TOPIC_DIVERSITY_CONFIG.maxPerClusterInBatch },
    });

  if (pipelineMode === 'generation' && params.rawTrends.length > 0 && selected.length === 0 && strategy && fallbackEligible.length > 0) {
    const history = params.history ?? await loadRecentTopicHistory(params.userId);
    const fallbackRanked = fallbackEligible.map(({ trend, match }) => {
      const fp = buildFallbackFingerprint(trend, params.plan);
      const clustered = fp.topicCluster === 'unclassified' ? { ...fp, topicCluster: fallbackCluster(match, params.plan) } : fp;
      const rankedItem = rankGenerationCandidate({ ...trend, selectionMode: 'zero_result_fallback' }, clustered, params.author, params.plan, history);
      return rankedItem;
    }).filter((item) => item.novelty.allowed && item.relevanceScore >= 50)
      .sort((a, b) => b.totalScore - a.totalScore);
    selected = selectDiverseRankedCandidates(fallbackRanked, Math.min(params.limit, 3), {
      caps: { maxPerSemanticCluster: TOPIC_DIVERSITY_CONFIG.maxPerClusterInBatch },
    });
    ranked.push(...selected.filter((item) => !ranked.includes(item)));
    if (selected.length) acceptancePathCounts.zero_result_fallback = selected.length;
  }

  if (pipelineMode === 'generation') {
    console.info('[trend-selection] quality funnel', {
      userId: params.userId,
      niche: params.niche,
      raw: params.rawTrends.length,
      rejectedByHeadlineRules: rejected.length,
      hardExclusionRejected: rejectedByExclusions + Object.entries(strategyRejectionFlags)
        .filter(([code]) => code.startsWith('excluded') || code === 'avoid_topic_match')
        .reduce((total, [, count]) => total + count, 0),
      classificationRejected: strategyRejectionFlags.no_acceptance_path ?? 0,
      duplicateRejected: exactDuplicatesRemoved + nearDuplicatesRemoved + historyMatchesRemoved,
      rejectionCodes,
      rejectedByStrategy,
      strategyRejectionFlags,
      acceptedByPath: acceptancePathCounts,
      strategyAccepted: strategyAcceptedCount,
      fingerprinted: fingerprintedCount,
      historyApproved: ranked.filter((item) => item.novelty.allowed).length,
      noveltyApproved: ranked.filter((item) => item.novelty.allowed).length,
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
      fingerprinted: fingerprintedCount,
      strategyAccepted: strategyAcceptedCount,
      historyApproved: ranked.filter((item) => item.novelty.allowed).length,
      noveltyApproved: ranked.filter((item) => item.novelty.allowed).length,
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
