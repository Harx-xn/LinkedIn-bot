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
