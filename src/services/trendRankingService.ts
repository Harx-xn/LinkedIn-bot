import { TREND_PREVIEW_CAPS, TREND_PREVIEW_COMPOSITION } from '../config/trendRankingConfig';
import { TOPIC_DIVERSITY_CONFIG } from '../config/topicDiversityConfig';
import type { RankedTrendCandidate, TrendContentType } from './generationTypes';
import {
  classifyTrendContentType,
  isAnalysisContentType,
  isTimelyContentType,
} from './trendContentType';
import { normalizeTrendTitle } from './trendTitleUtils';
import { jaccardSimilarity } from './ghostwriterTextUtils';

type DiversityCaps = {
  maxPerPublisher: number;
  maxMediumResults: number;
  maxLinkedInResults: number;
  maxRedditResults: number;
  maxPerSemanticCluster: number;
};

function discoveryKind(trend: RankedTrendCandidate): 'medium' | 'linkedin' | 'reddit' | 'other' {
  const ds = `${trend.trend.discoverySource ?? ''} ${trend.trend.source ?? ''}`.toLowerCase();
  if (ds.includes('medium')) return 'medium';
  if (ds.includes('linkedin')) return 'linkedin';
  if (ds.includes('reddit')) return 'reddit';
  return 'other';
}

function passesCaps(
  candidate: RankedTrendCandidate,
  counts: {
    publisher: Map<string, number>;
    medium: number;
    linkedin: number;
    reddit: number;
    cluster: Map<string, number>;
  },
  caps: DiversityCaps,
): boolean {
  const publisherKey = (candidate.trend.publisher ?? candidate.trend.source ?? 'unknown').toLowerCase();
  if ((counts.publisher.get(publisherKey) ?? 0) >= caps.maxPerPublisher) return false;

  const kind = discoveryKind(candidate);
  if (kind === 'medium' && counts.medium >= caps.maxMediumResults) return false;
  if (kind === 'linkedin' && counts.linkedin >= caps.maxLinkedInResults) return false;
  if (kind === 'reddit' && counts.reddit >= caps.maxRedditResults) return false;

  const cluster = candidate.fingerprint.topicCluster;
  if ((counts.cluster.get(cluster) ?? 0) >= caps.maxPerSemanticCluster) return false;

  return true;
}

function trackCandidate(
  candidate: RankedTrendCandidate,
  counts: {
    publisher: Map<string, number>;
    medium: number;
    linkedin: number;
    reddit: number;
    cluster: Map<string, number>;
  },
): void {
  const publisherKey = (candidate.trend.publisher ?? candidate.trend.source ?? 'unknown').toLowerCase();
  counts.publisher.set(publisherKey, (counts.publisher.get(publisherKey) ?? 0) + 1);
  const kind = discoveryKind(candidate);
  if (kind === 'medium') counts.medium++;
  if (kind === 'linkedin') counts.linkedin++;
  if (kind === 'reddit') counts.reddit++;
  counts.cluster.set(
    candidate.fingerprint.topicCluster,
    (counts.cluster.get(candidate.fingerprint.topicCluster) ?? 0) + 1,
  );
}

function isSemanticallySimilarToSelected(
  candidate: RankedTrendCandidate,
  selected: RankedTrendCandidate[],
): boolean {
  return selected.some((s) => {
    const claimSim = jaccardSimilarity(
      normalizeTrendTitle(s.fingerprint.coreClaim),
      normalizeTrendTitle(candidate.fingerprint.coreClaim),
    );
    const titleSim = jaccardSimilarity(s.trend.topic, candidate.trend.topic);
    return claimSim >= TOPIC_DIVERSITY_CONFIG.currentBatchSemanticThreshold
      || titleSim >= TOPIC_DIVERSITY_CONFIG.titleDuplicateThreshold;
  });
}

function mechanismOverlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const left = new Set(a.map((value) => normalizeTrendTitle(value)));
  const right = new Set(b.map((value) => normalizeTrendTitle(value)));
  const intersection = [...left].filter((value) => right.has(value)).length;
  return intersection / new Set([...left, ...right]).size;
}

export function areHardBatchDuplicates(a: RankedTrendCandidate, b: RankedTrendCandidate): boolean {
  if (a === b) return true;
  const normalizedA = normalizeTrendTitle(a.fingerprint.normalizedTopic);
  const normalizedB = normalizeTrendTitle(b.fingerprint.normalizedTopic);
  if (normalizedA && normalizedA === normalizedB) return true;
  const titleSimilarity = jaccardSimilarity(normalizeTrendTitle(a.trend.topic), normalizeTrendTitle(b.trend.topic));
  const claimSimilarity = jaccardSimilarity(normalizeTrendTitle(a.fingerprint.coreClaim), normalizeTrendTitle(b.fingerprint.coreClaim));
  const mechanisms = mechanismOverlap(a.fingerprint.mechanisms, b.fingerprint.mechanisms);
  return titleSimilarity >= TOPIC_DIVERSITY_CONFIG.titleDuplicateThreshold
    || claimSimilarity >= TOPIC_DIVERSITY_CONFIG.currentBatchSemanticThreshold
    || (claimSimilarity >= 0.55 && mechanisms >= 0.7);
}

export type FinalBatchSelectionResult = {
  selected: RankedTrendCandidate[];
  hardRejected: RankedTrendCandidate[];
  diagnostics: Record<string, unknown>;
};

export function selectFinalBatchCandidates(
  candidates: RankedTrendCandidate[],
  requestedPosts: number,
): FinalBatchSelectionResult {
  const qualified = candidates.filter((item) => item.novelty.allowed).sort((a, b) => b.totalScore - a.totalScore);
  const niches = [...new Set(qualified.map((item) => item.trend.originNiche ?? item.trend.niche ?? 'unknown'))];
  const intents = [...new Set(qualified.map((item) => item.trend.discoveryIntent ?? 'unclassified'))];
  const base = niches.length ? Math.floor(requestedPosts / niches.length) : 0;
  const remainder = niches.length ? requestedPosts % niches.length : 0;
  const allocation = Object.fromEntries(niches.map((niche, index) => [niche, base + (index < remainder ? 1 : 0)]));
  const softIntentLimit = Math.max(2, Math.ceil(requestedPosts / Math.max(1, intents.length)));
  const softClusterLimit = Math.max(2, Math.ceil(requestedPosts / Math.max(1, niches.length)));
  const softPublisherLimit = Math.max(2, Math.ceil(requestedPosts / Math.max(1, niches.length)));
  const selected: RankedTrendCandidate[] = [];
  const hardRejected: RankedTrendCandidate[] = [];
  const hardRejectedSet = new Set<RankedTrendCandidate>();
  const deferred = { niche: 0, intent: 0, cluster: 0, category: 0, publisher: 0 };
  const counts = { niche: new Map<string, number>(), intent: new Map<string, number>(), cluster: new Map<string, number>(), category: new Map<string, number>(), publisher: new Map<string, number>() };
  const key = (item: RankedTrendCandidate, kind: keyof typeof counts): string => {
    if (kind === 'niche') return item.trend.originNiche ?? item.trend.niche ?? 'unknown';
    if (kind === 'intent') return item.trend.discoveryIntent ?? 'unclassified';
    if (kind === 'cluster') return item.fingerprint.topicCluster;
    if (kind === 'publisher') return (item.trend.publisher ?? item.trend.source ?? 'unknown').toLowerCase();
    return item.trend.strategyReasons?.find((reason) => reason.startsWith('category_match:'))?.split(':')[1] ?? 'unclassified';
  };
  const selectedByNiche = () => Object.fromEntries([...counts.niche.entries()]);
  const add = (item: RankedTrendCandidate): boolean => {
    if (selected.some((chosen) => areHardBatchDuplicates(item, chosen))) {
      if (!hardRejectedSet.has(item)) { hardRejectedSet.add(item); hardRejected.push(item); }
      return false;
    }
    selected.push(item);
    for (const kind of Object.keys(counts) as Array<keyof typeof counts>) {
      const value = key(item, kind); counts[kind].set(value, (counts[kind].get(value) ?? 0) + 1);
    }
    return true;
  };
  const run = (rules: { niche?: boolean; intent?: boolean; cluster?: boolean; category?: boolean; publisher?: boolean }): number => {
    const before = selected.length;
    for (const item of qualified) {
      if (selected.length >= requestedPosts) break;
      if (selected.includes(item) || hardRejectedSet.has(item)) continue;
      const niche = key(item, 'niche');
      if (rules.niche && (counts.niche.get(niche) ?? 0) >= (allocation[niche] ?? 0)) { deferred.niche++; continue; }
      if (rules.intent && (counts.intent.get(key(item, 'intent')) ?? 0) >= softIntentLimit) { deferred.intent++; continue; }
      if (rules.cluster && (counts.cluster.get(key(item, 'cluster')) ?? 0) >= softClusterLimit) { deferred.cluster++; continue; }
      if (rules.category && (counts.category.get(key(item, 'category')) ?? 0) >= softIntentLimit) { deferred.category++; continue; }
      if (rules.publisher && (counts.publisher.get(key(item, 'publisher')) ?? 0) >= softPublisherLimit) { deferred.publisher++; continue; }
      add(item);
    }
    return selected.length - before;
  };
  const stage1Added = run({ niche: true, intent: true, cluster: true, category: true, publisher: true });
  const stage1 = { selectedCount: selected.length, selectedByNiche: selectedByNiche(), rejectedByHardDuplicate: hardRejected.length, deferredBySoftNicheLimit: deferred.niche, deferredByIntentLimit: deferred.intent, deferredByClusterLimit: deferred.cluster, deferredByCategoryLimit: deferred.category };
  const stage2Added = run({ intent: true, cluster: true, category: true, publisher: true });
  const stage2 = { redistributedSlots: stage2Added, selectedCount: selected.length, selectedByNiche: selectedByNiche() };
  run({ cluster: true });
  const stage3 = { relaxedRules: ['per_niche', 'intent', 'category', 'publisher'], selectedCount: selected.length, selectedByNiche: selectedByNiche() };
  run({});
  const stage4 = { relaxedRules: ['broad_cluster', 'mechanism_preference'], selectedCount: selected.length, selectedByNiche: selectedByNiche() };
  const beforeStage5 = selected.length;
  run({});
  const stage5 = { scoreFillCount: selected.length - beforeStage5, selectedCount: selected.length, selectedByNiche: selectedByNiche() };
  const unselectedReasons = qualified.filter((item) => !selected.includes(item)).map((item) => ({
    normalizedTopic: item.fingerprint.normalizedTopic,
    reason: hardRejectedSet.has(item) ? 'hard_duplicate' : selected.length >= requestedPosts ? 'stored_as_excess' : 'hard_duplicate',
  }));
  const diagnostics = { requestedPosts, freshQualifiedCount: qualified.length, activeNiches: niches, initialAllocationByNiche: allocation, stage1: { ...stage1, added: stage1Added }, stage2, stage3, stage4, stage5, final: { freshSelected: selected.length, remainingDeficit: Math.max(0, requestedPosts - selected.length), excessFresh: qualified.length - selected.length - hardRejected.length, hardRejectedRemaining: hardRejected.length, stopReason: selected.length >= requestedPosts ? 'requested_count_filled' : 'hard_unique_pool_exhausted' }, unselectedReasons };
  console.info('[trend-selection] staged final selection', diagnostics);
  return { selected, hardRejected, diagnostics };
}

export function selectDiverseRankedCandidates(
  ranked: RankedTrendCandidate[],
  limit: number,
  options?: {
    caps?: Partial<DiversityCaps>;
    preferTimely?: boolean;
    relaxCaps?: boolean;
  },
): RankedTrendCandidate[] {
  const caps: DiversityCaps = {
    maxPerPublisher: options?.caps?.maxPerPublisher ?? TREND_PREVIEW_CAPS.maxPerPublisher,
    maxMediumResults: options?.caps?.maxMediumResults ?? TREND_PREVIEW_CAPS.maxMediumResults,
    maxLinkedInResults: options?.caps?.maxLinkedInResults ?? TREND_PREVIEW_CAPS.maxLinkedInResults,
    maxRedditResults: options?.caps?.maxRedditResults ?? TREND_PREVIEW_CAPS.maxRedditResults,
    maxPerSemanticCluster: options?.caps?.maxPerSemanticCluster
      ?? TOPIC_DIVERSITY_CONFIG.maxPerClusterInBatch,
  };

  const allowed = ranked.filter((r) => r.novelty.allowed);
  const sorted = [...allowed].sort((a, b) => b.totalScore - a.totalScore);

  const trySelect = (activeCaps: DiversityCaps, requireNovelty: boolean): RankedTrendCandidate[] => {
    const selected: RankedTrendCandidate[] = [];
    const counts = {
      publisher: new Map<string, number>(),
      medium: 0,
      linkedin: 0,
      reddit: 0,
      cluster: new Map<string, number>(),
    };

    for (const candidate of sorted) {
      if (requireNovelty && !candidate.novelty.allowed) continue;
      if (isSemanticallySimilarToSelected(candidate, selected)) continue;
      if (!passesCaps(candidate, counts, activeCaps)) continue;
      selected.push(candidate);
      trackCandidate(candidate, counts);
      if (selected.length >= limit) break;
    }
    return selected;
  };

  const mergeUnique = (
    base: RankedTrendCandidate[],
    extra: RankedTrendCandidate[],
  ): RankedTrendCandidate[] => {
    const out = [...base];
    for (const item of extra) {
      if (!out.includes(item)) out.push(item);
      if (out.length >= limit) break;
    }
    return out;
  };

  let selected = trySelect(caps, true);
  if (selected.length < limit) {
    selected = mergeUnique(
      selected,
      trySelect(
        {
          ...caps,
          maxPerSemanticCluster: caps.maxPerSemanticCluster + 1,
          maxMediumResults: caps.maxMediumResults + 1,
        },
        true,
      ),
    );
  }
  if (selected.length < limit && options?.relaxCaps !== false) {
    selected = mergeUnique(
      selected,
      trySelect(
        {
          maxPerPublisher: caps.maxPerPublisher + 2,
          maxMediumResults: caps.maxMediumResults + 2,
          maxLinkedInResults: caps.maxLinkedInResults + 1,
          maxRedditResults: caps.maxRedditResults + 2,
          maxPerSemanticCluster: caps.maxPerSemanticCluster + 2,
        },
        false,
      ),
    );
  }

  return selected.slice(0, limit);
}

export function selectNicheBalancedCandidates(
  ranked: RankedTrendCandidate[],
  limit: number,
): RankedTrendCandidate[] {
  const qualified = ranked.filter((candidate) => candidate.novelty.allowed)
    .sort((a, b) => b.totalScore - a.totalScore);
  const bestByNiche = new Map<string, RankedTrendCandidate>();
  for (const candidate of qualified) {
    const niche = candidate.trend.originNiche ?? candidate.trend.niche;
    if (niche && !bestByNiche.has(niche)) bestByNiche.set(niche, candidate);
  }
  const representatives = selectDiverseRankedCandidates([...bestByNiche.values()], limit, { relaxCaps: false });
  const remaining = qualified.filter((candidate) =>
    !representatives.includes(candidate) && !isSemanticallySimilarToSelected(candidate, representatives),
  );
  const fill = selectDiverseRankedCandidates(remaining, limit - representatives.length);
  return [...representatives, ...fill].slice(0, limit);
}

export function selectPreviewRankedCandidates(
  ranked: RankedTrendCandidate[],
  limit: number,
): RankedTrendCandidate[] {
  const withTypes = ranked.map((r) => ({
    ...r,
    contentType: r.contentType ?? classifyTrendContentType(r.trend),
  }));

  const timelyTarget = Math.min(TREND_PREVIEW_COMPOSITION.minTimelyNews, limit);
  const analysisTarget = Math.min(TREND_PREVIEW_COMPOSITION.minAnalysis, Math.max(0, limit - timelyTarget));

  const selected: RankedTrendCandidate[] = [];
  const addFrom = (
    predicate: (type: TrendContentType) => boolean,
    max: number,
  ) => {
    const pool = selectDiverseRankedCandidates(
      withTypes.filter((r) => predicate(r.contentType!) && !selected.includes(r)),
      max,
      { relaxCaps: false },
    );
    for (const item of pool) {
      if (!selected.includes(item)) selected.push(item);
    }
  };

  addFrom(isTimelyContentType, timelyTarget);
  addFrom(isAnalysisContentType, analysisTarget);

  const remainder = selectDiverseRankedCandidates(
    withTypes.filter((r) => !selected.includes(r)),
    limit - selected.length,
  );
  for (const item of remainder) {
    if (!selected.includes(item)) selected.push(item);
  }

  return selected.slice(0, limit);
}
