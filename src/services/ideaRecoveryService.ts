import { createHash } from 'node:crypto';
import type { AccountPerformanceProfile } from './accountPerformanceLearningService';
import type { CandidateTier } from './ghostwriterCandidateSelection';
import type { QualityIssue, RankedTrendCandidate, TopicFingerprint } from './generationTypes';
import {
  createRecentContentMemory,
  semanticMemorySimilarity,
  type RecentContentFingerprint,
} from './recentContentMemoryService';
import { areHardBatchDuplicates } from './trendRankingService';
import { normalizeBatchCandidate, selectUnifiedBatchCandidates } from './unifiedBatchCandidateService';

export const SLOT_IDEA_RESERVE_SIZE = 3;
export const IDEA_EXHAUSTION_FRESH_GENERATIONS = 2;

const IDEA_LEVEL_FAILURE_CODES = new Set([
  'ARGUMENT_STAGNATION',
  'LOW_INFORMATION_DENSITY',
  'REDUNDANT_EXPLANATION',
  'WEAK_ARGUMENT_PROGRESSION',
]);

export type SlotIdeaCandidate = {
  id: string;
  ranked: RankedTrendCandidate;
};

export type SlotIdeaPool = {
  selected: SlotIdeaCandidate;
  alternates: SlotIdeaCandidate[];
};

export type IdeaFailureState = {
  candidateId: string;
  independentGenerationCount: number;
  recurringBlockingCodes: string[];
  recurringWarningCodes: string[];
  bestTier: CandidateTier | null;
  exhausted: boolean;
  exhaustionReason: string | null;
};

type RecordedFailure = { generations: Set<number>; severity: QualityIssue['severity'] };

export class IdeaFailureTracker {
  private independentGenerationCount = 0;
  private failures = new Map<string, RecordedFailure>();
  private bestTier: CandidateTier | null = null;

  constructor(readonly candidateId: string) {}

  recordAttempt(input: {
    kind: 'fresh' | 'repair';
    issues: QualityIssue[];
    bestTier?: CandidateTier | null;
  }): IdeaFailureState {
    if (input.bestTier) this.bestTier = input.bestTier;
    if (input.kind === 'repair') return this.state();

    this.independentGenerationCount += 1;
    const strongestByCode = new Map<string, QualityIssue['severity']>();
    for (const issue of input.issues) {
      if (!IDEA_LEVEL_FAILURE_CODES.has(issue.code)) continue;
      const existing = strongestByCode.get(issue.code);
      strongestByCode.set(issue.code, existing === 'error' || issue.severity === 'error' ? 'error' : 'warning');
    }
    for (const [code, severity] of strongestByCode) {
      const existing = this.failures.get(code) ?? { generations: new Set<number>(), severity };
      existing.generations.add(this.independentGenerationCount);
      if (severity === 'error') existing.severity = 'error';
      this.failures.set(code, existing);
    }
    return this.state();
  }

  state(): IdeaFailureState {
    const recurring = [...this.failures.entries()]
      .filter(([, failure]) => failure.generations.size >= IDEA_EXHAUSTION_FRESH_GENERATIONS);
    const recurringBlockingCodes = recurring.filter(([, failure]) => failure.severity === 'error').map(([code]) => code).sort();
    const recurringWarningCodes = recurring.filter(([, failure]) => failure.severity === 'warning').map(([code]) => code).sort();
    const exhausted = this.independentGenerationCount >= IDEA_EXHAUSTION_FRESH_GENERATIONS
      && recurring.length > 0;
    return {
      candidateId: this.candidateId,
      independentGenerationCount: this.independentGenerationCount,
      recurringBlockingCodes,
      recurringWarningCodes,
      bestTier: this.bestTier,
      exhausted,
      exhaustionReason: exhausted
        ? `recurring_semantic_failure:${[...recurringBlockingCodes, ...recurringWarningCodes].join(',')}`
        : null,
    };
  }
}

export function candidateTraceId(candidate: RankedTrendCandidate): string {
  const material = [
    candidate.trend.sourceType ?? 'candidate',
    candidate.trend.ideaOrigin ?? '',
    candidate.fingerprint.normalizedTopic,
    candidate.fingerprint.coreClaim,
    candidate.trend.link ?? '',
  ].join('|').toLowerCase();
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

function candidatePillar(candidate: RankedTrendCandidate): string {
  return candidate.matchedPillar
    ?? candidate.trend.matchedPillar
    ?? candidate.trend.originNiche
    ?? candidate.trend.niche
    ?? '';
}

function safeCandidate(candidate: RankedTrendCandidate): boolean {
  const normalized = normalizeBatchCandidate(candidate);
  return candidate.novelty.allowed
    && normalized.criticalIssues.length === 0
    && normalized.topic.trim().length > 0
    && normalized.coreClaim.trim().length > 0;
}

function batchFingerprintMemory(fingerprint: TopicFingerprint): RecentContentFingerprint {
  return {
    topic: fingerprint.normalizedTopic,
    coreClaim: fingerprint.coreClaim,
    mechanism: fingerprint.mechanisms.join(' '),
    origin: 'CURRENT_BATCH',
  };
}

function conflictsWithAcceptedBatch(candidate: RankedTrendCandidate, accepted: TopicFingerprint[]): boolean {
  return accepted.some((fingerprint) => {
    const sameTopic = candidate.fingerprint.normalizedTopic.trim().toLowerCase()
      === fingerprint.normalizedTopic.trim().toLowerCase();
    const claimSimilarity = semanticMemorySimilarity(candidate.fingerprint.coreClaim, fingerprint.coreClaim);
    const mechanismSimilarity = semanticMemorySimilarity(
      candidate.fingerprint.mechanisms.join(' '),
      fingerprint.mechanisms.join(' '),
    );
    return claimSimilarity >= 0.62
      || mechanismSimilarity >= 0.45
      || (sameTopic && claimSimilarity >= 0.55);
  });
}

function rankReserveCandidates(params: {
  candidates: RankedTrendCandidate[];
  selected: RankedTrendCandidate;
  recentMemory: RecentContentFingerprint[];
  performanceProfile?: AccountPerformanceProfile;
}): RankedTrendCandidate[] {
  const ranked = selectUnifiedBatchCandidates(
    params.candidates,
    params.candidates.length,
    createRecentContentMemory(params.recentMemory),
    params.performanceProfile,
  ).map((candidate) => candidate.ranked);
  const pillar = candidatePillar(params.selected);
  return ranked.sort((a, b) => {
    const samePillarA = candidatePillar(a) === pillar ? 1 : 0;
    const samePillarB = candidatePillar(b) === pillar ? 1 : 0;
    return samePillarB - samePillarA || b.totalScore - a.totalScore;
  });
}

export function buildSlotIdeaPools(params: {
  selected: RankedTrendCandidate[];
  observed: RankedTrendCandidate[];
  recentMemory?: RecentContentFingerprint[];
  performanceProfile?: AccountPerformanceProfile;
  reserveSize?: number;
}): SlotIdeaPool[] {
  const reserveSize = Math.max(0, Math.min(SLOT_IDEA_RESERVE_SIZE, params.reserveSize ?? SLOT_IDEA_RESERVE_SIZE));
  const selectedIds = new Set(params.selected.map(candidateTraceId));
  const assignedReserveIds = new Set<string>();
  const safeObserved = params.observed.filter(safeCandidate);

  return params.selected.map((selected, slotIndex) => {
    const candidates = safeObserved.filter((candidate) => {
      const id = candidateTraceId(candidate);
      if (selectedIds.has(id) || assignedReserveIds.has(id)) return false;
      return !params.selected.some((other, otherIndex) => otherIndex !== slotIndex && areHardBatchDuplicates(other, candidate));
    });
    const alternates = rankReserveCandidates({
      candidates,
      selected,
      recentMemory: params.recentMemory ?? [],
      performanceProfile: params.performanceProfile,
    }).slice(0, reserveSize).map((ranked) => ({ id: candidateTraceId(ranked), ranked }));
    for (const alternate of alternates) assignedReserveIds.add(alternate.id);
    return {
      selected: { id: candidateTraceId(selected), ranked: selected },
      alternates,
    };
  });
}

export function selectReplacementIdea(params: {
  pool: SlotIdeaPool;
  attemptedCandidateIds: Set<string>;
  acceptedBatchFingerprints?: TopicFingerprint[];
  recentMemory?: RecentContentFingerprint[];
  performanceProfile?: AccountPerformanceProfile;
}): SlotIdeaCandidate | null {
  const accepted = params.acceptedBatchFingerprints ?? [];
  const eligible = params.pool.alternates
    .filter((candidate) => !params.attemptedCandidateIds.has(candidate.id))
    .filter((candidate) => safeCandidate(candidate.ranked))
    .filter((candidate) => !conflictsWithAcceptedBatch(candidate.ranked, accepted));
  if (!eligible.length) return null;

  const reranked = selectUnifiedBatchCandidates(
    eligible.map((candidate) => candidate.ranked),
    eligible.length,
    createRecentContentMemory([
      ...(params.recentMemory ?? []),
      ...accepted.map(batchFingerprintMemory),
    ]),
    params.performanceProfile,
  ).map((candidate) => candidate.ranked);
  const selectedPillar = candidatePillar(params.pool.selected.ranked);
  reranked.sort((a, b) => {
    const samePillarA = candidatePillar(a) === selectedPillar ? 1 : 0;
    const samePillarB = candidatePillar(b) === selectedPillar ? 1 : 0;
    return samePillarB - samePillarA || b.totalScore - a.totalScore;
  });
  const winner = reranked[0];
  return winner ? eligible.find((candidate) => candidate.id === candidateTraceId(winner)) ?? null : null;
}
