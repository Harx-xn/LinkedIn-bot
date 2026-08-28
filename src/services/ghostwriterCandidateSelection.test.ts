import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SlotCandidatePool, type CandidateObservation, type SlotCandidateOrigin } from './ghostwriterCandidateSelection';
import type { QualityIssue } from './generationTypes';

const plan = {
  trendIndex: 0, sourceTopic: 'Approval ownership', angle: 'product_lesson' as const,
  hookStyle: 'observation' as const, endingStyle: 'natural' as const,
  layout: 'short_observation' as const, rationale: 'test',
  centralClaim: 'Explicit exception ownership prevents duplicate approval checks.',
  targetLengthRange: { min: 400, max: 900 }, depthClass: 'COMPACT' as const,
};

function observation(input: {
  origin: SlotCandidateOrigin;
  density?: number;
  fidelity?: number;
  genericRisk?: number;
  issues?: QualityIssue[];
  length?: number;
  reviewAvailable?: boolean;
}): CandidateObservation {
  const body = `Explicit exception ownership prevents duplicate approval checks because every failed decision has a known escalation path. ${'Useful implementation detail. '.repeat(Math.max(1, Math.floor((input.length ?? 560) / 30)))}`.slice(0, input.length ?? 560);
  const issues = input.issues ?? [];
  const reviewAvailable = input.reviewAvailable ?? true;
  return {
    origin: input.origin,
    generated: { headline: 'Ownership boundaries', subheadline: '', bulletPoints: [], body, hashtags: '' },
    finalized: { headline: 'Ownership boundaries', subheadline: '', bulletPoints: [], body, hashtags: '', content: body },
    acceptance: {
      accepted: issues.every((issue) => issue.severity !== 'error'), deterministicScore: 88,
      specificityScore: 82, qualityScore: input.density ?? 80, technicalPassed: reviewAvailable,
      blockingIssueCodes: issues.filter((issue) => issue.severity === 'error').map((issue) => issue.code),
      warningIssueCodes: issues.filter((issue) => issue.severity === 'warning').map((issue) => issue.code),
    },
    technicalReview: {
      available: reviewAvailable, passed: issues.every((issue) => issue.severity !== 'error'), confidence: 0.9,
      informationDensity: input.density ?? 80, progressionQuality: 80, redundancyRisk: 15,
      genericDiscourseRisk: input.genericRisk ?? 15, claimFidelity: input.fidelity ?? 90, issues: [],
    },
    issues,
    plan,
  };
}

describe('slot candidate retention and ranking', () => {
  it('keeps an initial draft when repair is weaker', () => {
    const pool = new SlotCandidatePool();
    const initial = pool.add(observation({ origin: 'initial_draft', density: 90, fidelity: 96 }));
    pool.add(observation({ origin: 'targeted_repair', density: 62, fidelity: 78, genericRisk: 45 }));
    assert.equal(pool.best(), initial);
  });

  it('selects a repair that fixes the issue and improves quality', () => {
    const pool = new SlotCandidatePool();
    pool.add(observation({ origin: 'initial_draft', density: 55, issues: [{ code: 'REDUNDANT_EXPLANATION', severity: 'error' }] }));
    const repair = pool.add(observation({ origin: 'targeted_repair', density: 88, fidelity: 94 }));
    assert.equal(pool.best(), repair);
  });

  it('does not prefer a later short or long candidate by recency', () => {
    const pool = new SlotCandidatePool();
    const initial = pool.add(observation({ origin: 'initial_draft', length: 650, density: 84 }));
    pool.add(observation({ origin: 'fresh_regeneration', length: 180, density: 84, issues: [{ code: 'generated_post_too_short', severity: 'error' }] }));
    pool.add(observation({ origin: 'fresh_regeneration', length: 1200, density: 84 }));
    assert.equal(pool.best(), initial);
  });

  it('does not let a relaxed late retry replace a cleaner earlier candidate', () => {
    const pool = new SlotCandidatePool();
    const earlier = pool.add(observation({ origin: 'targeted_repair', density: 82 }));
    pool.add(observation({ origin: 'late_retry', density: 86, issues: [{ code: 'WEAK_ARGUMENT_PROGRESSION', severity: 'error' }] }));
    assert.equal(pool.best(), earlier);
  });

  it('never selects a candidate with a critical violation', () => {
    const pool = new SlotCandidatePool();
    const safe = pool.add(observation({ origin: 'initial_draft', density: 50, reviewAvailable: false }));
    const unsafe = pool.add(observation({ origin: 'targeted_repair', density: 100, fidelity: 100, issues: [{ code: 'unsupported_first_person', severity: 'error' }] }));
    assert.equal(unsafe.eligible, false);
    assert.equal(pool.best(), safe);
  });

  it('prefers preserved evidence over an evidence-losing repair', () => {
    const pool = new SlotCandidatePool();
    const preserved = pool.add(observation({ origin: 'initial_draft', density: 80 }));
    pool.add(observation({ origin: 'targeted_repair', density: 80, issues: [{ code: 'SOURCE_EVIDENCE_LOSS', severity: 'warning' }] }));
    assert.equal(pool.best(), preserved);
  });

  it('prefers claim preservation over claim drift', () => {
    const pool = new SlotCandidatePool();
    const preserved = pool.add(observation({ origin: 'initial_draft', fidelity: 95 }));
    pool.add(observation({ origin: 'targeted_repair', density: 95, fidelity: 25, issues: [{ code: 'CLAIM_DRIFT', severity: 'error' }] }));
    assert.equal(pool.best(), preserved);
  });

  it('selects the highest-ranked hard-usable fallback instead of the latest', () => {
    const pool = new SlotCandidatePool();
    const bestFallback = pool.add(observation({ origin: 'initial_draft', density: 76, reviewAvailable: false, issues: [{ code: 'insufficient_specificity', severity: 'error' }] }));
    pool.add(observation({ origin: 'late_retry', density: 40, reviewAvailable: false, issues: [{ code: 'insufficient_specificity', severity: 'error' }, { code: 'generic_ending', severity: 'error' }] }));
    assert.equal(pool.best(), bestFallback);
    assert.equal(pool.best()?.tier, 'HARD_USABLE');
  });

  it('compares collision regeneration with the prior candidate', () => {
    const pool = new SlotCandidatePool();
    const prior = pool.add(observation({ origin: 'collision_prior', density: 88, fidelity: 94 }));
    pool.add(observation({ origin: 'collision_regeneration', density: 65, fidelity: 75 }));
    assert.equal(pool.best(), prior);
    assert.equal(pool.summary().candidateOrigins.length, 2);
  });

  it('does not publish an emergency candidate with a persistent quality failure', () => {
    const pool = new SlotCandidatePool();
    const emergency = pool.add(observation({ origin: 'emergency_fallback', density: 48, reviewAvailable: false, issues: [{ code: 'WEAK_ARGUMENT_PROGRESSION', severity: 'error' }] }));
    assert.equal(emergency.eligible, false);
    assert.equal(pool.best(), null);
  });

  it('retains a strong candidate whose only issue is rhetorical realization', () => {
    const pool = new SlotCandidatePool();
    const candidate = pool.add(observation({ origin: 'targeted_repair', density: 74, issues: [{ code: 'rhetorical_structure_mismatch', severity: 'error' }] }));
    assert.equal(candidate.eligible, true);
    assert.equal(pool.best(), candidate);
  });
});
