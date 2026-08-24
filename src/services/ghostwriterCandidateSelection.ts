import type {
  BatchPostPlan,
  GeneratedPostContent,
  QualityIssue,
  SlotAcceptanceDecision,
  TechnicalReviewResult,
} from './generationTypes';
import { evaluateGeneratedPostLength } from './generatedPostLength';
import { resolvePostDepthMetadata } from './postDepth';
import { canForceAcceptBlockingCodes, isCriticalCandidateIssueCode } from './ghostwriterValidationService';

export type SlotCandidateOrigin =
  | 'initial_draft'
  | 'targeted_repair'
  | 'specificity_expansion'
  | 'fresh_regeneration'
  | 'late_retry'
  | 'collision_regeneration'
  | 'collision_prior'
  | 'emergency_fallback';

export type FinalizedCandidateContent = {
  headline: string;
  subheadline: string;
  bulletPoints: string[];
  body: string;
  hashtags: string;
  content: string;
};

export type CandidateObservation = {
  origin: SlotCandidateOrigin;
  generated: GeneratedPostContent;
  finalized: FinalizedCandidateContent;
  acceptance: SlotAcceptanceDecision;
  technicalReview: TechnicalReviewResult;
  issues: QualityIssue[];
  plan: BatchPostPlan;
};

export type CandidateTier = 'REVIEWER_VALIDATED' | 'DETERMINISTIC_VALID' | 'HARD_USABLE' | 'EMERGENCY';

export type RankedSlotCandidate = CandidateObservation & {
  sequence: number;
  eligible: boolean;
  tier: CandidateTier;
  tierRank: number;
  claimFidelity: number;
  informationDensity: number;
  evidencePreservation: number;
  depthFit: number;
  genericRisk: number;
  issueCount: number;
  rankScore: number;
};

function evaluateObservation(observation: CandidateObservation, sequence: number): RankedSlotCandidate {
  const issueCodes = observation.issues.map((issue) => issue.code);
  const critical = issueCodes.some(isCriticalCandidateIssueCode)
    || observation.finalized.content.length > 3000;
  const errors = observation.issues.filter((issue) => issue.severity === 'error');
  const reviewAvailable = observation.technicalReview.available !== false;
  const tier: CandidateTier = errors.length === 0 && reviewAvailable && observation.technicalReview.passed
    ? 'REVIEWER_VALIDATED'
    : errors.length === 0
      ? 'DETERMINISTIC_VALID'
      : reviewAvailable || canForceAcceptBlockingCodes(issueCodes)
        ? 'HARD_USABLE'
        : 'EMERGENCY';
  const tierRank = { REVIEWER_VALIDATED: 4, DETERMINISTIC_VALID: 3, HARD_USABLE: 2, EMERGENCY: 1 }[tier];
  const depth = resolvePostDepthMetadata(observation.plan);
  const lengthStatus = evaluateGeneratedPostLength(
    observation.finalized.content,
    depth.targetLengthRange,
    depth.minimumCompleteLength,
  );
  const depthFit = lengthStatus === 'PREFERRED' ? 100 : lengthStatus === 'ACCEPTABLE' ? 85 : 45;
  const claimFidelity = observation.technicalReview.claimFidelity ?? (issueCodes.includes('CLAIM_DRIFT') ? 20 : 75);
  const informationDensity = observation.technicalReview.informationDensity ?? observation.acceptance.specificityScore;
  const genericRisk = observation.technicalReview.genericDiscourseRisk ?? (
    issueCodes.some((code) => code.includes('GENERIC') || code === 'generic_ending') ? 75 : 25
  );
  const evidenceDamage = issueCodes.filter((code) => (
    code === 'unsupported_first_person'
    || code === 'unsupported_personal_claim'
    || code === 'CLAIM_DRIFT'
    || code === 'SOURCE_EVIDENCE_LOSS'
    || code.includes('overclaim')
    || code === 'guaranteed_outcome'
  )).length;
  const evidencePreservation = Math.max(0, 100 - evidenceDamage * 35);
  const issueCount = observation.issues.length;
  const rankScore = tierRank * 10000
    + claimFidelity * 22
    + informationDensity * 16
    + evidencePreservation * 14
    + depthFit * 8
    + (100 - genericRisk) * 10
    + observation.acceptance.deterministicScore * 8
    - issueCount * 120;

  return {
    ...observation,
    sequence,
    eligible: !critical && observation.finalized.body.trim().length >= 40,
    tier,
    tierRank,
    claimFidelity,
    informationDensity,
    evidencePreservation,
    depthFit,
    genericRisk,
    issueCount,
    rankScore,
  };
}

export function compareSlotCandidates(a: RankedSlotCandidate, b: RankedSlotCandidate): number {
  if (a.eligible !== b.eligible) return a.eligible ? 1 : -1;
  if (a.tierRank !== b.tierRank) return a.tierRank - b.tierRank;
  if (a.claimFidelity !== b.claimFidelity) return a.claimFidelity - b.claimFidelity;
  if (a.informationDensity !== b.informationDensity) return a.informationDensity - b.informationDensity;
  if (a.issueCount !== b.issueCount) return b.issueCount - a.issueCount;
  if (a.evidencePreservation !== b.evidencePreservation) return a.evidencePreservation - b.evidencePreservation;
  if (a.depthFit !== b.depthFit) return a.depthFit - b.depthFit;
  if (a.genericRisk !== b.genericRisk) return b.genericRisk - a.genericRisk;
  if (a.rankScore !== b.rankScore) return a.rankScore - b.rankScore;
  return b.sequence - a.sequence;
}

export class SlotCandidatePool {
  private candidates: RankedSlotCandidate[] = [];
  private bestChanges: Array<{ from: string | null; to: string; reason: string }> = [];

  add(observation: CandidateObservation): RankedSlotCandidate {
    const previous = this.best();
    const candidate = evaluateObservation(observation, this.candidates.length + 1);
    this.candidates.push(candidate);
    const next = this.best();
    if (next === candidate && previous !== next) {
      const reason = !previous
        ? 'first eligible candidate'
        : `tier ${candidate.tierRank} vs ${previous.tierRank}; fidelity ${candidate.claimFidelity} vs ${previous.claimFidelity}; density ${candidate.informationDensity} vs ${previous.informationDensity}; issues ${candidate.issueCount} vs ${previous.issueCount}`;
      this.bestChanges.push({ from: previous?.origin ?? null, to: candidate.origin, reason });
      console.info('[ghostwriter] best candidate changed', {
        from: previous?.origin ?? null,
        to: candidate.origin,
        reason,
        candidateCount: this.candidates.length,
      });
    }
    return candidate;
  }

  best(): RankedSlotCandidate | null {
    return this.candidates.filter((candidate) => candidate.eligible).sort(compareSlotCandidates).at(-1) ?? null;
  }

  summary() {
    return {
      candidateCount: this.candidates.length,
      candidateOrigins: this.candidates.map((candidate) => candidate.origin),
      candidateIssueCounts: this.candidates.map((candidate) => ({ origin: candidate.origin, count: candidate.issueCount })),
      bestCandidateChanges: [...this.bestChanges],
      finalFallbackTier: this.best()?.tier ?? null,
    };
  }
}
