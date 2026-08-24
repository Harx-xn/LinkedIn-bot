import type { AuthorityMode } from './contentIntelligenceService';
import type { IdeaOrigin, RankedTrendCandidate, SourceReference } from './generationTypes';
import {
  createRecentContentMemory,
  scoreAgainstRecentContentMemory,
  semanticMemorySimilarity,
  updateRecentContentMemory,
  type RecentContentFingerprint,
  type RecentContentMemory,
} from './recentContentMemoryService';
import { areHardBatchDuplicates } from './trendRankingService';
import {
  scoreCandidateAgainstPerformance,
  type AccountPerformanceProfile,
  type CandidatePerformanceFeatures,
} from './accountPerformanceLearningService';
import {
  FALLBACK_PROVENANCE,
  logFallbackProvenance,
  type FallbackProvenance,
} from './fallbackProvenanceService';

export type UnifiedCandidateOrigin = Extract<IdeaOrigin,
  | 'STRATEGY_DERIVED'
  | 'AUDIENCE_PROBLEM'
  | 'EVERGREEN'
  | 'SEARCH_DISCOVERED'
  | 'RECENT_DEVELOPMENT'
  | 'USER_REQUESTED'
>;

export type CandidateEvidence = {
  sources: SourceReference[];
  sourceUrl?: string;
  summary?: string;
  enrichedCandidateId?: string;
};

export type NormalizedBatchCandidate = {
  id: string;
  origin: UnifiedCandidateOrigin;
  provenance: Extract<FallbackProvenance, 'STRATEGY_IDEA' | 'SEARCH_FILL' | 'LEGACY_DISCOVERY'>;
  pillar: string;
  territory: string;
  topic: string;
  coreClaim: string;
  mechanism: string;
  perspective: string;
  authorityMode: AuthorityMode;
  evidence: CandidateEvidence;
  sourceQuality: number;
  freshness: number;
  ideaQuality: number;
  saturationPenalty: number;
  similarityPenalty: number;
  performanceAdjustment: number;
  requiresSearch: boolean;
  publishabilityIssues: string[];
  criticalIssues: string[];
  ranked: RankedTrendCandidate;
};

export type UnifiedSelectionResult = {
  selected: NormalizedBatchCandidate[];
  observed: NormalizedBatchCandidate[];
  searchRequested: number;
  searchFailed: boolean;
  evidenceEnriched: number;
  provenanceCounts: Partial<Record<FallbackProvenance, number>>;
};

const TIMELY_INTENTS = new Set(['recent_development', 'official_update', 'industry_change', 'research_or_data', 'emerging_opportunity']);
const CRITICAL_ISSUE = /unsupported_authority|authority_boundary|prohibited|factual_safety|unsafe_evidence|excluded_topic|hard_platform/i;

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

function sourceReferences(candidate: RankedTrendCandidate): SourceReference[] {
  const references = [...(candidate.trend.supportingSources ?? [])];
  const url = candidate.trend.sourceUrl ?? candidate.trend.link;
  if (url && !references.some((reference) => reference.url === url)) {
    references.push({
      url,
      publisher: candidate.trend.publisher,
      source: candidate.trend.source ?? candidate.trend.discoverySource ?? 'search',
      evidenceRole: candidate.trend.evidenceRole ?? 'strong_secondary',
    });
  }
  return references;
}

function normalizedOrigin(candidate: RankedTrendCandidate): UnifiedCandidateOrigin {
  const supplied = candidate.trend.ideaOrigin;
  if (TIMELY_INTENTS.has(candidate.trend.discoveryIntent ?? '')
    || candidate.contentType === 'breaking_news' || candidate.contentType === 'industry_news') return 'RECENT_DEVELOPMENT';
  if (supplied === 'STRATEGY_DERIVED' || supplied === 'AUDIENCE_PROBLEM' || supplied === 'EVERGREEN'
    || supplied === 'SEARCH_DISCOVERED' || supplied === 'RECENT_DEVELOPMENT' || supplied === 'USER_REQUESTED') return supplied;
  if (candidate.trend.sourceType === 'strategy_derived') return 'STRATEGY_DERIVED';
  return 'SEARCH_DISCOVERED';
}

function stableCandidateId(candidate: RankedTrendCandidate): string {
  return [
    candidate.trend.sourceType ?? 'candidate', candidate.trend.ideaOrigin ?? '',
    candidate.fingerprint.normalizedTopic, candidate.fingerprint.coreClaim,
    candidate.trend.link ?? '',
  ].join('|').toLowerCase();
}

export function normalizeBatchCandidate(candidate: RankedTrendCandidate): NormalizedBatchCandidate {
  const issues = [...candidate.novelty.reasons, ...(candidate.trend.strategyRiskFlags ?? [])];
  const criticalIssues = issues.filter((issue) => CRITICAL_ISSUE.test(issue));
  const pillar = candidate.matchedPillar ?? candidate.trend.matchedPillar ?? candidate.trend.originNiche ?? candidate.trend.niche ?? 'general';
  const territory = candidate.trend.territory ?? candidate.fingerprint.topicCluster ?? pillar;
  const mechanism = candidate.fingerprint.mechanisms.join(' ').trim();
  const ideaQuality = clamp(candidate.trend.ideaQualityScore ?? (
    candidate.totalScore * .40 + candidate.relevanceScore * .25 + candidate.technicalDepthScore * .20 + candidate.noveltyScore * .15
  ));
  const origin = normalizedOrigin(candidate);
  return {
    id: stableCandidateId(candidate),
    origin,
    provenance: origin === 'SEARCH_DISCOVERED' || origin === 'RECENT_DEVELOPMENT'
      ? FALLBACK_PROVENANCE.SEARCH_FILL
      : FALLBACK_PROVENANCE.STRATEGY_IDEA,
    pillar,
    territory,
    topic: candidate.trend.topic,
    coreClaim: candidate.fingerprint.coreClaim || candidate.trend.summary || candidate.trend.topic,
    mechanism,
    perspective: candidate.audienceRelevance ?? candidate.trend.audienceRelevance ?? '',
    authorityMode: candidate.trend.authorityMode ?? (sourceReferences(candidate).length ? 'EXPLORATORY' : 'UNKNOWN'),
    evidence: {
      sources: sourceReferences(candidate),
      sourceUrl: candidate.trend.sourceUrl ?? candidate.trend.link,
      summary: candidate.trend.summary,
    },
    sourceQuality: clamp(candidate.sourceQualityScore),
    freshness: clamp(candidate.recencyScore),
    ideaQuality,
    saturationPenalty: Math.max(0, candidate.trend.saturationPenalty ?? 0),
    similarityPenalty: 0,
    performanceAdjustment: 0,
    requiresSearch: Boolean(candidate.trend.searchRequired),
    publishabilityIssues: issues,
    criticalIssues,
    ranked: candidate,
  };
}

function performanceFeatures(candidate: NormalizedBatchCandidate): CandidatePerformanceFeatures {
  return {
    pillar: candidate.pillar,
    territory: candidate.territory,
    ideaFamily: candidate.ranked.trend.ideaFamily ?? candidate.ranked.trend.suggestedAngle,
    authorityMode: candidate.authorityMode,
  };
}

function toMemoryFingerprint(candidate: NormalizedBatchCandidate): RecentContentFingerprint {
  return {
    topic: candidate.topic,
    pillar: candidate.pillar,
    territory: candidate.territory,
    coreClaim: candidate.coreClaim,
    mechanism: candidate.mechanism,
    perspective: candidate.perspective,
    ideaFamily: candidate.ranked.trend.ideaFamily ?? candidate.ranked.trend.suggestedAngle,
    argumentPattern: candidate.ranked.trend.ideaFamily ?? candidate.ranked.trend.suggestedAngle,
    contentIntent: candidate.ranked.trend.discoveryIntent ?? candidate.ranked.trend.ideaFamily,
    authorityMode: candidate.authorityMode,
    origin: candidate.origin === 'STRATEGY_DERIVED' ? 'STRATEGY_DERIVED' : 'SEARCH_DERIVED',
  };
}

function qualityScore(candidate: NormalizedBatchCandidate): number {
  const authorityPenalty = candidate.authorityMode === 'UNKNOWN' ? 5 : candidate.authorityMode === 'EXPLORATORY' ? 2 : 0;
  const evidenceBonus = Math.min(5, candidate.evidence.sources.length * 2);
  return candidate.ideaQuality * .42
    + candidate.ranked.relevanceScore * .18
    + candidate.sourceQuality * .14
    + candidate.freshness * .08
    + candidate.ranked.technicalDepthScore * .10
    + candidate.ranked.noveltyScore * .08
    + evidenceBonus
    - candidate.saturationPenalty
    - authorityPenalty;
}

function tier(candidate: NormalizedBatchCandidate): number {
  if (candidate.criticalIssues.length || !candidate.topic.trim() || !candidate.coreClaim.trim()) return 0;
  if (candidate.ranked.novelty.allowed && qualityScore(candidate) >= 70) return 3;
  if (candidate.ranked.novelty.allowed) return 2;
  return 1;
}

/** Applies the same authority, publishability, saturation, memory and batch-diversity rules to every origin. */
export function selectUnifiedBatchCandidates(
  candidates: Array<RankedTrendCandidate | NormalizedBatchCandidate>,
  count: number,
  memory: RecentContentMemory = createRecentContentMemory(),
  performanceProfile?: AccountPerformanceProfile,
): NormalizedBatchCandidate[] {
  const remaining = candidates.map((candidate) => 'ranked' in candidate ? candidate : normalizeBatchCandidate(candidate));
  const selected: NormalizedBatchCandidate[] = [];
  while (selected.length < count && remaining.length) {
    const evaluated = remaining.map((candidate) => {
      const fingerprint = toMemoryFingerprint(candidate);
      const memoryPenalty = scoreAgainstRecentContentMemory(fingerprint, memory);
      const performance = scoreCandidateAgainstPerformance(performanceProfile, performanceFeatures(candidate), {
        explicitUserChoice: candidate.origin === 'USER_REQUESTED',
      });
      return {
        candidate,
        fingerprint,
        tier: tier(candidate),
        adjusted: qualityScore(candidate) - memoryPenalty.total + performance.adjustment,
        memoryPenalty,
        performance,
      };
    }).sort((a, b) => b.tier - a.tier || b.adjusted - a.adjusted);
    const choice = evaluated.find(({ candidate, tier: candidateTier }) => candidateTier > 0
      && !selected.some((prior) => areHardBatchDuplicates(prior.ranked, candidate.ranked)));
    if (!choice) break;
    const selectedCandidate: NormalizedBatchCandidate = {
      ...choice.candidate,
      similarityPenalty: choice.memoryPenalty.total,
      performanceAdjustment: choice.performance.adjustment,
      ranked: {
        ...choice.candidate.ranked,
        totalScore: choice.adjusted,
        noveltyScore: Math.max(0, choice.candidate.ranked.noveltyScore - choice.memoryPenalty.total),
        trend: {
          ...choice.candidate.ranked.trend,
          saturationPenalty: choice.candidate.saturationPenalty + choice.memoryPenalty.total,
          strategyReasons: [
            ...(choice.candidate.ranked.trend.strategyReasons ?? []),
            ...choice.memoryPenalty.strong.map((reason) => `content_memory_strong:${reason}`),
            ...choice.memoryPenalty.medium.map((reason) => `content_memory_medium:${reason}`),
            ...choice.memoryPenalty.light.map((reason) => `content_memory_light:${reason}`),
            ...choice.performance.reasons,
          ],
        },
      },
    };
    selected.push(selectedCandidate);
    updateRecentContentMemory(memory, { ...choice.fingerprint, origin: 'CURRENT_BATCH' });
    remaining.splice(remaining.indexOf(choice.candidate), 1);
  }
  return selected;
}

export function bufferedSearchCandidateCount(deficit: number, evidenceNeeds: number): number {
  if (deficit <= 0 && evidenceNeeds <= 0) return 0;
  return Math.max(evidenceNeeds > 0 ? 2 : 0, deficit + Math.min(3, Math.max(1, Math.ceil(deficit / 2))));
}

function evidenceMatch(strategy: NormalizedBatchCandidate, searched: NormalizedBatchCandidate): number {
  const claim = semanticMemorySimilarity(strategy.coreClaim, searched.coreClaim);
  const mechanism = semanticMemorySimilarity(strategy.mechanism, searched.mechanism);
  const territory = semanticMemorySimilarity(strategy.territory, `${searched.territory} ${searched.topic}`);
  return Math.max(claim, mechanism, territory * .65);
}

function enrichWithEvidence(strategy: NormalizedBatchCandidate, searched: NormalizedBatchCandidate): NormalizedBatchCandidate {
  const sources = [...strategy.evidence.sources];
  for (const source of searched.evidence.sources) if (!sources.some((existing) => existing.url === source.url)) sources.push(source);
  const ranked = {
    ...strategy.ranked,
    sourceQualityScore: Math.max(strategy.ranked.sourceQualityScore, searched.sourceQuality),
    recencyScore: Math.max(strategy.ranked.recencyScore, searched.freshness),
    trend: {
      ...strategy.ranked.trend,
      searchRequired: false,
      supportingSources: sources,
      // The strategy claim, mechanism, topic and origin intentionally remain immutable.
    },
  };
  return {
    ...strategy,
    requiresSearch: false,
    sourceQuality: Math.max(strategy.sourceQuality, searched.sourceQuality),
    freshness: Math.max(strategy.freshness, searched.freshness),
    evidence: { ...strategy.evidence, sources, enrichedCandidateId: searched.id },
    ranked,
  };
}

export async function buildUnifiedCandidateSelection(params: {
  strategyCandidates: RankedTrendCandidate[];
  count: number;
  memory?: RecentContentMemory;
  search?: (candidateCount: number) => Promise<RankedTrendCandidate[]>;
  legacyFallbackCandidates?: RankedTrendCandidate[];
  performanceProfile?: AccountPerformanceProfile;
}): Promise<UnifiedSelectionResult> {
  const memory = params.memory ?? createRecentContentMemory();
  let strategy = params.strategyCandidates.map(normalizeBatchCandidate);
  const viableStrategy = selectUnifiedBatchCandidates(
    strategy.filter((candidate) => tier(candidate) >= 2),
    params.count,
    createRecentContentMemory(memory.fingerprints),
    params.performanceProfile,
  );
  const viableStrategyIds = new Set(viableStrategy.map((candidate) => candidate.id));
  const deficit = Math.max(0, params.count - viableStrategy.length);
  const evidenceNeeds = viableStrategy.filter((candidate) => candidate.requiresSearch).length;
  const searchRequested = params.search ? bufferedSearchCandidateCount(deficit, evidenceNeeds) : 0;
  let searched: NormalizedBatchCandidate[] = [];
  let searchFailed = false;
  if (searchRequested > 0 && params.search) {
    try {
      searched = (await params.search(searchRequested)).map(normalizeBatchCandidate);
    } catch {
      searchFailed = true;
    }
  }

  const consumedEvidence = new Set<string>();
  let evidenceEnriched = 0;
  strategy = strategy.map((candidate) => {
    if (!candidate.requiresSearch || !viableStrategyIds.has(candidate.id)) return candidate;
    const match = searched
      .filter((searchedCandidate) => searchedCandidate.evidence.sources.length && !consumedEvidence.has(searchedCandidate.id))
      .map((searchedCandidate) => ({ searchedCandidate, score: evidenceMatch(candidate, searchedCandidate) }))
      .sort((a, b) => b.score - a.score)[0];
    if (!match || match.score < .45) return candidate;
    consumedEvidence.add(match.searchedCandidate.id);
    evidenceEnriched++;
    return enrichWithEvidence(candidate, match.searchedCandidate);
  });

  const legacy = (params.legacyFallbackCandidates ?? []).map((candidate) => ({
    ...normalizeBatchCandidate(candidate),
    provenance: FALLBACK_PROVENANCE.LEGACY_DISCOVERY as Extract<FallbackProvenance, 'LEGACY_DISCOVERY'>,
  }));
  const primaryObserved = [
    ...strategy,
    ...searched.filter((candidate) => !consumedEvidence.has(candidate.id)),
  ];
  // Strong strategy work is retained first. Search expands the option set for
  // the actual deficit; buffered search results cannot evict already-selected
  // strategy ideas merely because fallback discovery ran.
  const retainedStrategy = selectUnifiedBatchCandidates(
    strategy.filter((candidate) => viableStrategyIds.has(candidate.id)),
    params.count,
    createRecentContentMemory(memory.fingerprints),
    params.performanceProfile,
  );
  const fillMemory = createRecentContentMemory(memory.fingerprints);
  for (const candidate of retainedStrategy) updateRecentContentMemory(fillMemory, { ...toMemoryFingerprint(candidate), origin: 'CURRENT_BATCH' });
  const fillCandidates = primaryObserved.filter((candidate) => !retainedStrategy.some((retained) => retained.id === candidate.id));
  const primaryFill = selectUnifiedBatchCandidates(
    fillCandidates,
    params.count - retainedStrategy.length,
    fillMemory,
    params.performanceProfile,
  ).filter((candidate) => !retainedStrategy.some((prior) => areHardBatchDuplicates(prior.ranked, candidate.ranked)));
  const primarySelected = [...retainedStrategy, ...primaryFill].slice(0, params.count);
  let selected = primarySelected;
  if (selected.length < params.count && legacy.length) {
    const fillMemory = createRecentContentMemory(memory.fingerprints);
    for (const candidate of selected) updateRecentContentMemory(fillMemory, { ...toMemoryFingerprint(candidate), origin: 'CURRENT_BATCH' });
    const legacyFill = selectUnifiedBatchCandidates(
      legacy,
      params.count - selected.length,
      fillMemory,
      params.performanceProfile,
    ).filter((candidate) => !selected.some((prior) => areHardBatchDuplicates(prior.ranked, candidate.ranked)));
    selected = [...selected, ...legacyFill].slice(0, params.count);
  }
  const observed = [...primaryObserved, ...legacy];
  const provenanceCounts = selected.reduce<Partial<Record<FallbackProvenance, number>>>((counts, candidate) => {
    counts[candidate.provenance] = (counts[candidate.provenance] ?? 0) + 1;
    return counts;
  }, {});
  for (const [provenance, countValue] of Object.entries(provenanceCounts)) {
    logFallbackProvenance({ provenance: provenance as FallbackProvenance, stage: 'candidate_selection', count: countValue });
  }
  return { selected, observed, searchRequested, searchFailed, evidenceEnriched, provenanceCounts };
}
