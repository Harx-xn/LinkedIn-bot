import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BatchGenerationTraceRecorder,
  createBatchTraceId,
  diagnosticCandidateOrigin,
  diagnosticFingerprint,
  getGenerationTrace,
  persistGenerationTraceSafe,
  type GenerationTraceCandidate,
  type GenerationTraceDraft,
} from './batchGenerationTraceService';
import { classifyPostDepthWithTrace } from './postDepth';
import { summarizeBatchPlan } from './ghostwriterBatchPlanner';
import type { AuthorContext, BatchPostPlan } from './generationTypes';

function recorder(id = 'job-1') {
  return new BatchGenerationTraceRecorder({
    batchTraceId: createBatchTraceId(id),
    strategyFingerprint: diagnosticFingerprint({ pillars: ['systems'] }),
    requestedPostCount: 1,
    recentMemoryWindowSize: 12,
  });
}

function candidate(overrides: Partial<GenerationTraceCandidate> = {}): GenerationTraceCandidate {
  return {
    candidateTraceId: 'candidate-a', origin: 'SEMANTIC_STRATEGY', generationMode: 'SEMANTIC',
    pillar: 'Systems', territory: 'reliability', topicNormalized: 'retry ownership', ideaFamily: 'hidden constraint',
    authorityMode: 'SUPPORTED_PRACTITIONER', ideaQuality: 84, strategyFit: null, audienceValue: null,
    practicalValue: null, discussionPotential: null, specificity: null, nonObviousness: null, fallbackFamily: null,
    subjectRelevance: null, sourceClaimTransformability: null, searchDisposition: null,
    searchRejectionReason: null, evidenceOnly: false, searchRelevanceBreakdown: null,
    conceptualMotif: null, reasoningArchetype: null, motifSimilarity: null,
    motifPenalty: null, motifCollisionCandidateId: null,
    authorityFit: null, sourceQuality: 72, freshness: 65, novelty: 90, saturationPenalty: 2,
    memoryPenalty: 4, performanceAdjustment: 1.5, unifiedQuality: 82, adjustedScore: 79.5,
    tier: 'ELIGIBLE', rejectionReason: null, selected: true, selectionOrder: 1,
    disposition: 'SELECTED', collisionCandidateTraceId: null, ...overrides,
  };
}

function plan(): BatchPostPlan {
  return {
    trendIndex: 0, sourceTopic: 'Retry ownership', angle: 'architecture_tradeoff', hookStyle: 'contrarian',
    endingStyle: 'takeaway', layout: 'opinion_with_reasoning', rationale: 'test', claimSource: 'STRATEGY_SELECTED',
    selectedCentralClaim: 'Retries need one explicit owner.', centralClaim: 'Retries need one explicit owner.',
    depthPlan: {
      centralClaim: 'Retries need one explicit owner.', whyThisClaimIsInteresting: 'Duplicate work hides ownership.',
      strongestObservations: ['Workers can retry independently.', 'Queues can redeliver after a timeout.'],
      underlyingCauseOrMechanism: 'Two retry loops amplify the same failure.', deeperInterpretation: 'Ownership is a system boundary.',
      meaningfulConsequence: 'Operators cannot predict load.', usefulTensionOrQualification: 'One owner may be slower but safer.',
      personalPerspective: { supported: false, insight: null }, endingInsight: 'Make ownership inspectable.', avoidIdeas: [],
    },
  };
}

function addSlot(trace = recorder()) {
  const depth = classifyPostDepthWithTrace(plan());
  trace.recordSlot({
    slotTraceId: 'slot-1', slotIndex: 0, candidateTraceId: 'candidate-a',
    selectedCentralClaim: 'Retries need one explicit owner.', claimSource: 'STRATEGY_SELECTED',
    depth: {
      depthClass: depth.depthClass,
      targetLengthRange: depth.targetLengthRange,
      depthScore: depth.depthScore,
      rawDepthSignals: depth.rawDepthSignals,
      independentSubstanceUnits: depth.independentSubstanceUnits,
      discountedRedundantSignals: depth.discountedRedundantSignals,
      signalsContributing: depth.signalsContributing,
    },
    editorial: {
      shareabilityPotential: 77, valueType: 'INSIGHT', recommendedPresentation: 'COMPACT_TEXT',
      contentObjective: 'TEACH', conversionObjective: 'SAVE', hookFamily: 'CONTRARIAN_CLAIM',
      rhetoricalStructure: 'COMPARISON', endingIntent: 'CONCLUSION',
    },
    alternateCandidateTraceIds: ['candidate-b', 'candidate-c', 'candidate-d', 'candidate-e', 'candidate-f', 'candidate-g'],
  });
  return trace;
}

function draft(overrides: Partial<GenerationTraceDraft> = {}): GenerationTraceDraft {
  return {
    draftAttemptId: 'draft-1', slotTraceId: 'slot-1', candidateTraceId: 'candidate-a', ideaAttemptId: 'idea-1',
    ideaAttemptIndex: 0, origin: 'INITIAL', charLength: 804, deterministicScore: 71, specificityScore: 54,
    reviewerPassed: false, claimFidelity: 88, informationDensity: 42, progressionQuality: 39,
    redundancyRisk: 71, genericDiscourseRisk: 55, issueCodes: ['LOW_INFORMATION_DENSITY'],
    candidateTier: 'HARD_USABLE', becameBestCandidate: true, acceptedNormally: false, returnedAsFallback: false,
    ...overrides,
  };
}

describe('production-safe batch generation trace', () => {
  it('gives a batch job one stable trace ID', () => {
    assert.equal(createBatchTraceId('job-123'), 'job-123');
    assert.equal(recorder('job-123').batchTraceId, 'job-123');
  });

  it('keeps semantic and deterministic strategy provenance distinguishable', () => {
    assert.equal(diagnosticCandidateOrigin({ ideaGenerationMode: 'SEMANTIC', sourceType: 'strategy_derived' }), 'SEMANTIC_STRATEGY');
    assert.equal(diagnosticCandidateOrigin({ ideaGenerationMode: 'DETERMINISTIC_FALLBACK', sourceType: 'strategy_derived' }), 'DETERMINISTIC_STRATEGY_FALLBACK');
  });

  it('persists real search scoring fields', () => {
    const trace = recorder();
    trace.recordCandidate(candidate({ origin: 'SEARCH_DISCOVERED', sourceQuality: 91, freshness: 87, adjustedScore: 83 }));
    assert.deepEqual(trace.snapshot().candidates[0].sourceQuality, 91);
    assert.equal(trace.snapshot().candidates[0].adjustedScore, 83);
  });

  it('persists deterministic fallback scoring dimensions and family', () => {
    const trace = recorder();
    trace.recordCandidate(candidate({
      origin: 'DETERMINISTIC_STRATEGY_FALLBACK', generationMode: 'DETERMINISTIC_FALLBACK',
      strategyFit: 63, audienceValue: 58, practicalValue: 74, discussionPotential: 61,
      specificity: 79, nonObviousness: 71, fallbackFamily: 'unexpected interaction',
    }));
    const stored = trace.snapshot().candidates[0];
    assert.deepEqual(
      [stored.strategyFit, stored.audienceValue, stored.practicalValue, stored.discussionPotential, stored.specificity, stored.nonObviousness, stored.fallbackFamily],
      [63, 58, 74, 61, 79, 71, 'unexpected interaction'],
    );
  });

  it('persists search admission, original relevance, and evidence-only disposition', () => {
    const trace = recorder();
    trace.recordCandidate(candidate({
      origin: 'SEARCH_DISCOVERED', subjectRelevance: 86, creatorContentFit: 24,
      audienceIdeaNaturalness: 12, sourceClaimTransformability: 18,
      searchDisposition: 'EVIDENCE_ONLY',
      searchRejectionReason: 'SEARCH_SOURCE_CLAIM_TRANSFORMABILITY_TOO_LOW',
      evidenceOnly: true,
      searchRelevanceBreakdown: { directNicheEvidence: 35, pillarMatch: 40, finalScore: 86 },
      disposition: 'EVIDENCE_ONLY', selected: false, selectionOrder: null,
    }));
    const stored = trace.snapshot().candidates[0];
    assert.equal(stored.subjectRelevance, 86);
    assert.equal(stored.sourceClaimTransformability, 18);
    assert.equal(stored.searchDisposition, 'EVIDENCE_ONLY');
    assert.equal(stored.evidenceOnly, true);
    assert.equal(stored.searchRelevanceBreakdown?.directNicheEvidence, 35);
  });

  it('persists conceptual motif collision diagnostics without post content', () => {
    const trace = recorder();
    trace.recordCandidate(candidate({
      conceptualMotif: 'LOCAL_IMPROVEMENT_SHIFTS_COST',
      reasoningArchetype: 'COST_OR_CONSTRAINT_TRANSFER', motifSimilarity: 1,
      motifPenalty: 28, motifCollisionCandidateId: 'candidate:prior',
    }));
    const stored = trace.snapshot().candidates[0];
    assert.equal(stored.conceptualMotif, 'LOCAL_IMPROVEMENT_SHIFTS_COST');
    assert.equal(stored.motifPenalty, 28);
    assert.equal(stored.motifCollisionCandidateId, 'candidate:prior');
    assert.equal('body' in stored, false);
  });

  it('retains a hard candidate rejection reason', () => {
    const trace = recorder();
    trace.recordCandidate(candidate({ selected: false, selectionOrder: null, disposition: 'HARD_REJECTED', rejectionReason: 'AUTHORITY_REJECTED' }));
    assert.equal(trace.snapshot().candidates[0].rejectionReason, 'AUTHORITY_REJECTED');
  });

  it('persists bounded candidate-coherence decisions without raw profile text', () => {
    const trace = recorder();
    trace.recordCandidate(candidate({
      audienceIdeaNaturalness: 72,
      creatorContentFit: 81,
      candidateCoherence: {
        audienceIdeaNaturalness: 72, creatorContentFit: 81, pillarClaimFit: 77,
        sourceClaimFit: 70, authorityFramingFit: 88, overall: 78,
      },
      coherencePenalty: 0,
      coherenceRejectionReason: null,
      resolvedAudience: ['Operations leaders'],
    }));
    const stored = trace.snapshot().candidates[0];
    assert.equal(stored.audienceIdeaNaturalness, 72);
    assert.equal(stored.creatorContentFit, 81);
    assert.equal(stored.candidateCoherence?.overall, 78);
    assert.deepEqual(stored.resolvedAudience, ['Operations leaders']);
  });

  it('distinguishes ranking loss from a hard rejection', () => {
    const trace = recorder();
    trace.recordCandidate(candidate({ candidateTraceId: 'lost', selected: false, selectionOrder: null, disposition: 'LOST_RANKING', rejectionReason: 'LOST_RANKING' }));
    trace.recordCandidate(candidate({ candidateTraceId: 'hard', selected: false, selectionOrder: null, disposition: 'HARD_REJECTED', rejectionReason: 'SATURATION' }));
    assert.deepEqual(trace.snapshot().candidates.map((item) => item.disposition), ['LOST_RANKING', 'HARD_REJECTED']);
  });

  it('makes greedy selection order reconstructible', () => {
    const trace = recorder();
    trace.recordCandidate(candidate({ candidateTraceId: 'second', selectionOrder: 2 }));
    trace.recordCandidate(candidate({ candidateTraceId: 'first', selectionOrder: 1 }));
    trace.recordSelectionEvaluation({ selectionStep: 1, candidateTraceId: 'first', adjustedScore: 88, memoryPenalty: 3, performanceAdjustment: 1, tier: 3, disposition: 'SELECTED', collisionCandidateTraceId: null });
    trace.recordSelectionEvaluation({ selectionStep: 2, candidateTraceId: 'second', adjustedScore: 76, memoryPenalty: 9, performanceAdjustment: -1, tier: 2, disposition: 'SELECTED', collisionCandidateTraceId: null });
    assert.deepEqual(trace.snapshot().candidates.map((item) => item.selectionOrder), [2, 1]);
    assert.deepEqual(trace.snapshot().selectionSteps.map((item) => [item.selectionStep, item.candidateTraceId, item.memoryPenalty]), [[1, 'first', 3], [2, 'second', 9]]);
  });

  it('bounds retained alternatives to the highest five references', () => {
    assert.deepEqual(addSlot().snapshot().slots[0].alternateCandidateTraceIds, ['candidate-b', 'candidate-c', 'candidate-d', 'candidate-e', 'candidate-f']);
  });

  it('retains selected central claim provenance separately from source title', () => {
    const slot = addSlot().snapshot().slots[0];
    assert.equal(slot.selectedCentralClaim, 'Retries need one explicit owner.');
    assert.equal(slot.claimSource, 'STRATEGY_SELECTED');
  });

  it('retains deterministic depth score and signal contribution breakdown', () => {
    const depth = addSlot().snapshot().slots[0].depth!;
    assert.ok(depth.depthScore >= 6);
    assert.equal(depth.signalsContributing.mechanismPresent, true);
    assert.equal(depth.signalsContributing.walkthroughPresent, false);
    assert.ok(depth.rawDepthSignals.includes('mechanism'));
    assert.ok(depth.independentSubstanceUnits.some((unit) => unit.type === 'CAUSAL_MECHANISM'));
  });

  it('retains draft issue codes and candidate tier without draft body', () => {
    const trace = addSlot(); trace.recordDraft(draft());
    assert.deepEqual(trace.snapshot().draftAttempts[0].issueCodes, ['LOW_INFORMATION_DENSITY']);
    assert.equal(trace.snapshot().draftAttempts[0].candidateTier, 'HARD_USABLE');
    assert.equal('body' in trace.snapshot().draftAttempts[0], false);
  });

  it('reconstructs best-candidate changes from draft flags', () => {
    const trace = addSlot();
    trace.recordDraft(draft());
    trace.recordDraft(draft({ draftAttemptId: 'draft-2', origin: 'REPAIR', becameBestCandidate: true, reviewerPassed: true, candidateTier: 'REVIEWER_VALIDATED' }));
    assert.deepEqual(trace.snapshot().draftAttempts.filter((item) => item.becameBestCandidate).map((item) => item.draftAttemptId), ['draft-1', 'draft-2']);
  });

  it('makes best-usable fallback provenance visible', () => {
    const trace = addSlot(); trace.recordDraft(draft({ returnedAsFallback: true }));
    trace.recordFinal('slot-1', 'candidate-a', ['BEST_USABLE_FALLBACK']);
    assert.equal(trace.snapshot().draftAttempts[0].returnedAsFallback, true);
    assert.deepEqual(trace.snapshot().slots[0].finalProvenance, ['BEST_USABLE_FALLBACK']);
  });

  it('represents idea exhaustion and replacement', () => {
    const trace = addSlot();
    const compactDepth = classifyPostDepthWithTrace({ ...plan(), depthPlan: { ...plan().depthPlan!, strongestObservations: [], underlyingCauseOrMechanism: null, deeperInterpretation: null, meaningfulConsequence: null, usefulTensionOrQualification: null } });
    trace.recordIdeaReplacement('slot-1', {
      exhaustionReason: 'recurring_semantic_failure', replacementCandidateTraceId: 'candidate-b',
      replacementSelectionReason: 'highest_ranked_safe_current_batch_alternate',
      replacementDepth: {
        depthClass: compactDepth.depthClass, targetLengthRange: compactDepth.targetLengthRange,
        depthScore: compactDepth.depthScore, rawDepthSignals: compactDepth.rawDepthSignals,
        independentSubstanceUnits: compactDepth.independentSubstanceUnits,
        discountedRedundantSignals: compactDepth.discountedRedundantSignals,
        signalsContributing: compactDepth.signalsContributing,
      },
    });
    assert.equal(trace.snapshot().slots[0].ideaExhausted, true);
    assert.equal(trace.snapshot().slots[0].replacementCandidateTraceId, 'candidate-b');
    assert.equal(trace.snapshot().slots[0].depth?.depthClass, 'COMPACT');
  });

  it('replaces evergreenCount with explicit provenance metrics', () => {
    const trace = recorder();
    trace.recordCandidate(candidate());
    trace.recordCandidate(candidate({ candidateTraceId: 'det', origin: 'DETERMINISTIC_STRATEGY_FALLBACK', generationMode: 'DETERMINISTIC_FALLBACK', selectionOrder: 2 }));
    assert.deepEqual(trace.snapshot().metrics, {
      semanticStrategySelected: 1, deterministicStrategySelected: 1, searchSelected: 0,
      inventorySelected: 0, legacySelected: 0, emptyPlanCount: 0,
    });
    const summary = summarizeBatchPlan([plan()], { description: '', tone: '', niches: [] } as AuthorContext, [{ topic: 'x', ideaGenerationMode: 'SEMANTIC', sourceType: 'strategy_derived' }]);
    assert.equal('evergreenCount' in summary, false);
    assert.equal(summary.semanticStrategySelected, 1);
  });

  it('does not fail generation when telemetry persistence fails', async () => {
    const ok = await persistGenerationTraceSafe('job-1', recorder(), {
      store: { update: async () => { throw new Error('database unavailable'); }, findUnique: async () => null },
    });
    assert.equal(ok, false);
  });

  it('excludes prompt bodies, secrets, and raw Personal Experience fields', () => {
    const trace = addSlot();
    trace.recordSlot({
      slotTraceId: 'slot-1', slotIndex: 0, candidateTraceId: 'candidate-a',
      selectedCentralClaim: 'Use sk-abcdefghijklmnop safely', claimSource: 'STRATEGY_SELECTED', depth: null, editorial: null,
      promptBody: 'do not persist me', personalExperienceRawText: 'private story',
    } as never);
    const serialized = JSON.stringify(trace.snapshot());
    assert.doesNotMatch(serialized, /abcdefghijklmnop|do not persist me|private story/);
    assert.match(serialized, /REDACTED_SECRET/);
  });

  it('retains no Experience Bank data in generic strategy context', () => {
    const snapshot = recorder().snapshot();
    assert.equal('experienceBank' in snapshot.strategyContext, false);
    assert.equal('personalExperience' in snapshot.strategyContext, false);
  });

  it('reconstructs one coherent completed diagnostic object', async () => {
    const trace = addSlot(); trace.recordCandidate(candidate()); trace.recordDraft(draft()); trace.recordFinal('slot-1', 'candidate-a', ['NORMAL_ACCEPTANCE']);
    const stored = trace.snapshot(true);
    const reconstructed = await getGenerationTrace('job-1', {
      update: async () => undefined,
      findUnique: async () => ({ generationTrace: stored }),
    });
    assert.equal(reconstructed?.batchTraceId, 'job-1');
    assert.equal(reconstructed?.candidates.length, 1);
    assert.equal(reconstructed?.slots[0].finalCandidateTraceId, 'candidate-a');
    assert.equal(reconstructed?.draftAttempts.length, 1);
  });
});
