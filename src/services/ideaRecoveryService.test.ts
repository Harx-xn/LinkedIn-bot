import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ContentService } from './contentService';
import { SlotCandidatePool } from './ghostwriterCandidateSelection';
import {
  buildSlotIdeaPools,
  candidateTraceId,
  IdeaFailureTracker,
  selectReplacementIdea,
} from './ideaRecoveryService';
import { generateSlotPostWithIdeaRecovery, MAX_SLOT_WRITER_OPERATIONS } from './ghostwriterGenerationService';
import { buildReplacementPlan } from './ghostwriterPipeline';
import type { BatchPostPlan, GeneratedPostContent, QualityIssue, RankedTrendCandidate, TrendCandidate } from './generationTypes';
import { BatchGenerationTraceRecorder } from './batchGenerationTraceService';

const AUTHOR = { description: 'Product and operations writer.', tone: 'Professional', niches: ['Operations'] };

const STRONG_BODY = `A useful approval boundary records who can release a workflow and which condition authorizes that decision. The check happens before execution, so a failed approval cannot be mistaken for a completed action.

That boundary gives retries a stable state to inspect. A worker can distinguish pending approval from an execution failure instead of repeating the action whenever a timeout hides the previous response.

The narrow insight is that trust comes from an inspectable decision boundary. More automation is not the remedy when ownership of that decision remains ambiguous.

Once the boundary is explicit, recovery becomes a decision instead of a guess because the recorded state explains what may happen next.`;

const STAGNANT_BODY = `Approval ownership controls automation trust.

Automation trust is controlled by approval ownership.

Clear approval ownership controls whether teams trust automation.

The same approval ownership therefore controls automation trust for the team.`;

function post(body: string): GeneratedPostContent {
  return { headline: '', subheadline: '', bulletPoints: [], body, hashtags: '' };
}

function plan(sourceTopic: string): BatchPostPlan {
  return {
    trendIndex: 0,
    sourceTopic,
    centralClaim: 'Explicit approval boundaries make recovery decisions inspectable.',
    selectedCentralClaim: 'Explicit approval boundaries make recovery decisions inspectable.',
    angle: 'product_lesson', hookStyle: 'observation', endingStyle: 'natural',
    layout: 'short_observation', rationale: 'test', expressionMode: 'analytical',
    depthClass: 'COMPACT', targetLengthRange: { min: 400, max: 900 },
    depthPlan: {
      centralClaim: 'Explicit approval boundaries make recovery decisions inspectable.',
      whyThisClaimIsInteresting: null, strongestObservations: [], underlyingCauseOrMechanism: null,
      deeperInterpretation: null, meaningfulConsequence: null, usefulTensionOrQualification: null,
      personalPerspective: { supported: false, insight: null }, endingInsight: null, avoidIdeas: [],
    },
  };
}

function ranked(input: {
  claim: string;
  mechanism: string;
  pillar?: string;
  score?: number;
  allowed?: boolean;
  issues?: string[];
}): RankedTrendCandidate {
  const pillar = input.pillar ?? 'Operations';
  const score = input.score ?? 80;
  const fingerprint = {
    normalizedTopic: input.claim.toLowerCase(),
    topicCluster: input.claim.toLowerCase().replace(/\W+/g, '_'),
    coreClaim: input.claim,
    entities: [pillar],
    mechanisms: [input.mechanism],
  };
  return {
    trend: {
      topic: input.claim, summary: input.claim, sourceType: 'strategy_derived', ideaOrigin: 'STRATEGY_DERIVED',
      niche: pillar, originNiche: pillar, matchedPillar: pillar, territory: input.claim,
      authorityMode: 'SUPPORTED_PRACTITIONER', ideaQualityScore: score, fingerprint,
    },
    fingerprint, relevanceScore: score, sourceQualityScore: 70, recencyScore: 70,
    technicalDepthScore: score, noveltyScore: score, totalScore: score,
    novelty: { allowed: input.allowed ?? true, score, reasons: input.issues ?? [] },
    matchedPillar: pillar,
  };
}

function reviewFailure(code = 'LOW_INFORMATION_DENSITY'): ReturnType<ContentService['reviewTechnicalClaims']> extends Promise<infer T> ? T : never {
  return {
    available: true, passed: false, confidence: 1,
    informationDensity: 35, progressionQuality: 30, redundancyRisk: 75,
    genericDiscourseRisk: 40, claimFidelity: 90,
    issues: [{ code: code as 'LOW_INFORMATION_DENSITY', severity: 'error', excerpt: 'Repeated claim.', explanation: 'The argument does not advance.', repairInstruction: 'Add a distinct mechanism and consequence.' }],
  };
}

function cleanReview(): ReturnType<ContentService['reviewTechnicalClaims']> extends Promise<infer T> ? T : never {
  return {
    available: true, passed: true, confidence: 1,
    informationDensity: 90, progressionQuality: 90, redundancyRisk: 5,
    genericDiscourseRisk: 5, claimFidelity: 95, issues: [],
  };
}

describe('idea failure state', () => {
  const stagnation: QualityIssue[] = [{ code: 'ARGUMENT_STAGNATION', severity: 'error' }];

  it('does not exhaust an idea after one bad fresh generation', () => {
    const tracker = new IdeaFailureTracker('idea-a');
    const state = tracker.recordAttempt({ kind: 'fresh', issues: stagnation, bestTier: 'HARD_USABLE' });
    assert.equal(state.independentGenerationCount, 1);
    assert.equal(state.exhausted, false);
  });

  it('does not count repairs as independent idea failures', () => {
    const tracker = new IdeaFailureTracker('idea-a');
    tracker.recordAttempt({ kind: 'fresh', issues: stagnation });
    tracker.recordAttempt({ kind: 'repair', issues: stagnation });
    const state = tracker.recordAttempt({ kind: 'repair', issues: stagnation });
    assert.equal(state.independentGenerationCount, 1);
    assert.equal(state.exhausted, false);
  });

  it('exhausts an idea after the same semantic error recurs across two fresh generations', () => {
    const tracker = new IdeaFailureTracker('idea-a');
    tracker.recordAttempt({ kind: 'fresh', issues: stagnation });
    const state = tracker.recordAttempt({ kind: 'fresh', issues: stagnation, bestTier: 'HARD_USABLE' });
    assert.equal(state.exhausted, true);
    assert.deepEqual(state.recurringBlockingCodes, ['ARGUMENT_STAGNATION']);
    assert.match(state.exhaustionReason ?? '', /recurring_semantic_failure/);
  });

  it('tracks recurring warning-level density failures separately', () => {
    const tracker = new IdeaFailureTracker('idea-a');
    const density: QualityIssue[] = [{ code: 'LOW_INFORMATION_DENSITY', severity: 'warning' }];
    tracker.recordAttempt({ kind: 'fresh', issues: density });
    const state = tracker.recordAttempt({ kind: 'fresh', issues: density });
    assert.equal(state.exhausted, true);
    assert.deepEqual(state.recurringWarningCodes, ['LOW_INFORMATION_DENSITY']);
  });
});

describe('slot idea reserve and replacement selection', () => {
  it('keeps the reserve bounded and prefers a coherent same-pillar alternate', () => {
    const selected = ranked({ claim: 'Initial operations idea', mechanism: 'initial boundary', pillar: 'Operations', score: 90 });
    const samePillar = ranked({ claim: 'Queue ownership idea', mechanism: 'stable queue owner', pillar: 'Operations', score: 70 });
    const crossPillar = ranked({ claim: 'Hiring calibration idea', mechanism: 'weighted scorecard', pillar: 'Hiring', score: 95 });
    const extra = ranked({ claim: 'Cash runway idea', mechanism: 'runway scenarios', pillar: 'Finance', score: 85 });
    const pools = buildSlotIdeaPools({ selected: [selected], observed: [selected, crossPillar, samePillar, extra], reserveSize: 2 });
    assert.equal(pools[0].alternates.length, 2);
    assert.equal(pools[0].alternates[0].id, candidateTraceId(samePillar));
  });

  it('does not retain hard-rejected or unsafe candidates', () => {
    const selected = ranked({ claim: 'Initial idea', mechanism: 'initial boundary' });
    const unsafe = ranked({ claim: 'Invent a personal result', mechanism: 'fabricated proof', score: 99, allowed: false, issues: ['unsupported_authority'] });
    const pools = buildSlotIdeaPools({ selected: [selected], observed: [selected, unsafe] });
    assert.equal(pools[0].alternates.length, 0);
  });

  it('assigns bounded reserve candidates uniquely across concurrent slots', () => {
    const selectedA = ranked({ claim: 'Initial operations idea', mechanism: 'initial boundary', pillar: 'Operations' });
    const selectedB = ranked({ claim: 'Initial hiring idea', mechanism: 'initial scorecard', pillar: 'Hiring' });
    const alternatives = [
      ranked({ claim: 'Queue ownership idea', mechanism: 'stable queue owner', pillar: 'Operations' }),
      ranked({ claim: 'Recovery checkpoint idea', mechanism: 'checkpoint recovery', pillar: 'Operations' }),
      ranked({ claim: 'Interview calibration idea', mechanism: 'weighted calibration', pillar: 'Hiring' }),
      ranked({ claim: 'Candidate evidence idea', mechanism: 'evidence rubric', pillar: 'Hiring' }),
    ];
    const pools = buildSlotIdeaPools({ selected: [selectedA, selectedB], observed: [selectedA, selectedB, ...alternatives], reserveSize: 2 });
    const ids = pools.flatMap((pool) => pool.alternates.map((alternate) => alternate.id));
    assert.equal(ids.length, 4);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('rechecks alternates against accepted mechanisms and skips a duplicate', () => {
    const selected = ranked({ claim: 'Initial idea', mechanism: 'initial boundary' });
    const duplicate = ranked({ claim: 'Different wording', mechanism: 'server validates entitlement', pillar: 'Operations', score: 95 });
    const distinct = ranked({ claim: 'Queue recovery idea', mechanism: 'stable queue ownership', pillar: 'Operations', score: 80 });
    const pool = buildSlotIdeaPools({ selected: [selected], observed: [selected, duplicate, distinct] })[0];
    const replacement = selectReplacementIdea({
      pool,
      attemptedCandidateIds: new Set([pool.selected.id]),
      acceptedBatchFingerprints: [{
        normalizedTopic: 'access checks', topicCluster: 'access', coreClaim: 'Access belongs at the trusted boundary',
        entities: [], mechanisms: ['server validates entitlements'],
      }],
    });
    assert.equal(replacement?.id, candidateTraceId(distinct));
  });

  it('allows a cross-pillar alternate when same-pillar options conflict with the current batch', () => {
    const selected = ranked({ claim: 'Initial operations idea', mechanism: 'initial boundary', pillar: 'Operations' });
    const same = ranked({ claim: 'Repeated queue idea', mechanism: 'stable queue ownership', pillar: 'Operations', score: 90 });
    const cross = ranked({ claim: 'Interview calibration idea', mechanism: 'weighted scorecard', pillar: 'Hiring', score: 75 });
    const pool = buildSlotIdeaPools({ selected: [selected], observed: [selected, same, cross] })[0];
    const replacement = selectReplacementIdea({
      pool,
      attemptedCandidateIds: new Set([pool.selected.id]),
      acceptedBatchFingerprints: [{
        normalizedTopic: 'queue recovery', topicCluster: 'queue', coreClaim: 'Queue ownership makes recovery predictable',
        entities: [], mechanisms: ['stable queue ownership'],
      }],
    });
    assert.equal(replacement?.id, candidateTraceId(cross));
  });

  it('keeps replacement planning isolated from personal-experience evidence', () => {
    const candidate = ranked({ claim: 'Queue ownership idea', mechanism: 'stable queue ownership' });
    const replacementPlan = buildReplacementPlan({
      candidate: { id: candidateTraceId(candidate), ranked: candidate },
      slotIndex: 2,
      author: AUTHOR,
      config: { niches: ['Operations'] },
    });
    assert.equal(replacementPlan.trendIndex, 2);
    assert.equal(replacementPlan.editorialDecision?.personalEvidenceAvailable, false);
    assert.equal(replacementPlan.depthPlan?.personalPerspective.supported, false);
    assert.equal(replacementPlan.depthClass, 'COMPACT');
    assert.deepEqual(replacementPlan.targetLengthRange, { min: 600, max: 1100 });
  });

  it('classifies a replacement from its own substance instead of inheriting the exhausted slot depth', () => {
    const candidate = ranked({ claim: 'One narrow queue ownership rule', mechanism: 'stable queue ownership' });
    const exhaustedSlot = { ...plan('Exhausted deep slot'), depthClass: 'DEEP' as const, targetLengthRange: { min: 1400, max: 2500 } };
    const replacementPlan = buildReplacementPlan({
      candidate: { id: candidateTraceId(candidate), ranked: candidate },
      slotIndex: exhaustedSlot.trendIndex ?? 0,
      author: AUTHOR,
      config: { niches: ['Operations'] },
      acceptedPlans: [exhaustedSlot],
    });
    assert.equal(exhaustedSlot.depthClass, 'DEEP');
    assert.equal(replacementPlan.depthClass, 'COMPACT');
    assert.deepEqual(replacementPlan.targetLengthRange, { min: 600, max: 1100 });
  });
});

describe('idea-level generation recovery', () => {
  const initialTrend: TrendCandidate = { topic: 'Weak idea', sourceType: 'strategy_derived', ideaOrigin: 'STRATEGY_DERIVED' };
  const alternateTrend: TrendCandidate = { topic: 'Strong alternate', sourceType: 'strategy_derived', ideaOrigin: 'STRATEGY_DERIVED' };

  it('lets a strong initial idea succeed without requesting replacement', async () => {
    let replacementCalls = 0;
    const traceRecorder = new BatchGenerationTraceRecorder({
      batchTraceId: 'batch-test', strategyFingerprint: 'strategy-hash', requestedPostCount: 1,
    });
    const service = {
      generatePlannedPost: async () => post(STRONG_BODY),
      reviewTechnicalClaims: async () => cleanReview(),
    } as unknown as ContentService;
    const recovery = await generateSlotPostWithIdeaRecovery(
      service, { candidateId: 'idea-a', plan: plan('Strong initial'), trend: initialTrend },
      AUTHOR, { niches: ['Operations'] }, [], 'OPENAI', { traceRecorder, slotTraceId: 'slot-test' },
      () => { replacementCalls += 1; return null; },
    );
    assert.equal(recovery.finalIdea.candidateId, 'idea-a');
    assert.equal(replacementCalls, 0);
    assert.equal(recovery.result.acceptance.accepted, true);
    assert.equal(traceRecorder.snapshot().draftAttempts.length, 1);
    assert.equal(traceRecorder.snapshot().draftAttempts[0].candidateTraceId, 'idea-a');
    assert.equal(traceRecorder.snapshot().draftAttempts[0].acceptedNormally, true);
  });

  it('allows one bad fresh draft to be repaired without exhausting or replacing the idea', async () => {
    let reviewCalls = 0;
    let replacementCalls = 0;
    const service = {
      generatePlannedPost: async () => post(STAGNANT_BODY),
      reviewTechnicalClaims: async () => (++reviewCalls === 1 ? reviewFailure() : cleanReview()),
      repairPost: async () => post(STRONG_BODY),
    } as unknown as ContentService;
    const recovery = await generateSlotPostWithIdeaRecovery(
      service, { candidateId: 'idea-a', plan: plan('Repairable idea'), trend: initialTrend },
      AUTHOR, { niches: ['Operations'] }, [], 'OPENAI', {},
      () => { replacementCalls += 1; return null; },
    );
    assert.equal(recovery.finalIdea.candidateId, 'idea-a');
    assert.equal(replacementCalls, 0);
    assert.equal(recovery.result.acceptance.accepted, true);
  });

  it('replaces an exhausted idea and keeps its prior best draft while a valid alternate wins', async () => {
    const pool = new SlotCandidatePool();
    let replacementCalls = 0;
    const service = {
      generatePlannedPost: async (currentPlan: BatchPostPlan) => post(currentPlan.sourceTopic === 'Strong alternate' ? STRONG_BODY : STAGNANT_BODY),
      reviewTechnicalClaims: async (_post: GeneratedPostContent, _author: unknown, currentPlan: BatchPostPlan) => currentPlan.sourceTopic === 'Strong alternate' ? cleanReview() : reviewFailure(),
      repairPost: async (generated: GeneratedPostContent) => generated,
    } as unknown as ContentService;
    const recovery = await generateSlotPostWithIdeaRecovery(
      service, { candidateId: 'idea-a', plan: plan('Weak idea'), trend: initialTrend },
      AUTHOR, { niches: ['Operations'] }, [], 'OPENAI', { candidatePool: pool },
      () => {
        replacementCalls += 1;
        return { candidateId: 'idea-b', plan: plan('Strong alternate'), trend: alternateTrend, origin: 'STRATEGY_DERIVED' };
      },
    );
    assert.equal(replacementCalls, 1);
    assert.equal(pool.bestForIdea('idea-a'), null);
    assert.equal(recovery.finalIdea.candidateId, 'idea-b');
    assert.equal(recovery.result.acceptance.accepted, true);
    assert.ok((recovery.result.writerOperationsUsed ?? 0) <= MAX_SLOT_WRITER_OPERATIONS);
  });

  it('returns the prior safe draft when the replacement produces no usable candidate', async () => {
    const pool = new SlotCandidatePool();
    const service = {
      generatePlannedPost: async (currentPlan: BatchPostPlan) => {
        if (currentPlan.sourceTopic === 'Broken alternate') throw new Error('provider unavailable');
        return post(STAGNANT_BODY);
      },
      reviewTechnicalClaims: async () => reviewFailure(),
      repairPost: async (generated: GeneratedPostContent) => generated,
    } as unknown as ContentService;
    const recovery = await generateSlotPostWithIdeaRecovery(
      service, { candidateId: 'idea-a', plan: plan('Weak idea'), trend: initialTrend },
      AUTHOR, { niches: ['Operations'] }, [], 'OPENAI', { candidatePool: pool },
      () => ({ candidateId: 'idea-b', plan: plan('Broken alternate'), trend: alternateTrend }),
    );
    assert.equal(recovery.finalIdea.candidateId, 'idea-b');
    assert.ok(recovery.result.fallbackProvenance?.includes('SAFE_FALLBACK_ACCEPTANCE'));
  });

  it('returns the best safe draft when both bounded ideas are exhausted', async () => {
    let replacementCalls = 0;
    const service = {
      generatePlannedPost: async () => post(STAGNANT_BODY),
      reviewTechnicalClaims: async () => reviewFailure(),
      repairPost: async (generated: GeneratedPostContent) => generated,
    } as unknown as ContentService;
    const recovery = await generateSlotPostWithIdeaRecovery(
      service, { candidateId: 'idea-a', plan: plan('Weak idea'), trend: initialTrend },
      AUTHOR, { niches: ['Operations'] }, [], 'OPENAI', {},
      () => {
        replacementCalls += 1;
        return { candidateId: 'idea-b', plan: plan('Also weak'), trend: alternateTrend };
      },
    );
    assert.equal(replacementCalls, 1);
    assert.equal(recovery.result.ok, true);
    assert.ok(recovery.result.fallbackProvenance?.includes('SAFE_FALLBACK_ACCEPTANCE'));
    assert.ok((recovery.result.writerOperationsUsed ?? 0) <= MAX_SLOT_WRITER_OPERATIONS);
  });

  it('never retains a critical authority violation from a replacement as fallback', async () => {
    const pool = new SlotCandidatePool();
    const criticalBody = `In building Veyrais, I achieved a guaranteed result for every client. ${'Unsupported personal proof. '.repeat(20)}`;
    const service = {
      generatePlannedPost: async (currentPlan: BatchPostPlan) => post(currentPlan.sourceTopic === 'Critical alternate' ? criticalBody : STAGNANT_BODY),
      reviewTechnicalClaims: async () => reviewFailure(),
      repairPost: async (generated: GeneratedPostContent) => generated,
    } as unknown as ContentService;
    const recovery = await generateSlotPostWithIdeaRecovery(
      service, { candidateId: 'idea-a', plan: plan('Weak idea'), trend: initialTrend },
      AUTHOR, { niches: ['Operations'] }, [], 'OPENAI', { candidatePool: pool },
      () => ({ candidateId: 'idea-b', plan: plan('Critical alternate'), trend: alternateTrend }),
    );
    assert.equal(pool.bestForIdea('idea-b'), null);
    assert.equal(recovery.finalIdea.candidateId, 'idea-b');
    assert.ok(recovery.result.fallbackProvenance?.includes('SAFE_FALLBACK_ACCEPTANCE'));
  });
});
