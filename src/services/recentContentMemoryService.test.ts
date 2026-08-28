import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRecentContentMemory,
  scoreAgainstRecentContentMemory,
  selectRankedCandidatesWithMemory,
  semanticMemorySimilarity,
  updateRecentContentMemory,
  type RecentContentFingerprint,
} from './recentContentMemoryService';
import { classifyFinalPostFingerprint } from './finalPostFingerprintClassifier';
import type { RankedTrendCandidate } from './generationTypes';

function memoryFingerprint(overrides: Partial<RecentContentFingerprint> = {}): RecentContentFingerprint {
  return {
    topic: 'approval workflows', pillar: 'Operations', territory: 'Workflow design',
    coreClaim: 'Explicit exception ownership prevents duplicate approval checks.',
    mechanism: 'named exception ownership creates one escalation path', perspective: 'operator decision',
    ideaFamily: 'hidden constraint', argumentPattern: 'CLAIM_MECHANISM_CONSEQUENCE',
    hookType: 'OBSERVATION_HOOK', endingType: 'SYNTHESIS_CLOSE', ctaType: 'TAKEAWAY_CLOSE',
    contentIntent: 'EXPLAIN_MECHANISM', authorityMode: 'GENERAL_REASONING', ...overrides,
  };
}

function ranked(topic: string, claim: string, mechanism: string, totalScore: number, sourceType: 'searched' | 'strategy_derived' | 'source_derived_angle' = 'searched'): RankedTrendCandidate {
  return {
    trend: { topic, sourceType, source: 'search', territory: 'General territory', fingerprint: { normalizedTopic: topic, topicCluster: 'other', coreClaim: claim, entities: [], mechanisms: [mechanism] } },
    fingerprint: { normalizedTopic: topic, topicCluster: 'other', coreClaim: claim, entities: [], mechanisms: [mechanism] },
    relevanceScore: 80, sourceQualityScore: 80, recencyScore: 80, technicalDepthScore: 80,
    noveltyScore: 80, totalScore, novelty: { allowed: true, score: 80, reasons: [] }, contentType: 'industry_news',
  };
}

describe('recent content memory', () => {
  it('uses rejected-generation fingerprints only to penalize immediate duplication', () => {
    const rejected = memoryFingerprint({
      origin: 'REJECTED_DUPLICATE_ONLY',
      topic: 'affordable web design',
      coreClaim: 'Affordable web design becomes costly when scalability and performance are deferred.',
      mechanism: null,
      authorityMode: null,
    });
    const memory = createRecentContentMemory([rejected]);
    const penalty = scoreAgainstRecentContentMemory(memoryFingerprint({
      topic: 'low cost web design',
      coreClaim: 'Affordable web design becomes expensive when performance and scalability are postponed.',
      mechanism: null,
    }), memory);
    assert.ok(penalty.total >= 36);
    assert.ok(penalty.strong.includes('recent_core_claim'));
    assert.equal(memory.fingerprints[0].authorityMode, null);
  });

  it('allows the same topic when the claim and mechanism differ', () => {
    const memory = createRecentContentMemory([memoryFingerprint()]);
    const penalty = scoreAgainstRecentContentMemory(memoryFingerprint({
      coreClaim: 'Approval queues expose which decisions lack a response deadline.',
      mechanism: 'response deadlines reveal stalled decision ownership', perspective: 'service-level design',
    }), memory);
    assert.equal(penalty.strong.length, 0);
    assert.ok(penalty.medium.some((reason) => reason.startsWith('territory_saturation')));
  });

  it('strongly penalizes different topics with the same underlying mechanism', () => {
    const memory = createRecentContentMemory([memoryFingerprint({
      topic: 'SaaS authorization', coreClaim: 'Client-side checks cannot enforce authorization; critical entitlements belong on the server.',
      mechanism: 'client-side checks cannot enforce authorization critical entitlements belong on server',
    })]);
    const penalty = scoreAgainstRecentContentMemory(memoryFingerprint({
      topic: 'Streaming playback', coreClaim: 'Streaming platforms should validate player entitlements server-side rather than trusting clients.',
      mechanism: 'validate player entitlements server side rather than trusting clients',
    }), memory);
    assert.ok(penalty.maxMechanismSimilarity >= .45);
    assert.ok(penalty.strong.includes('recent_mechanism'));
  });

  it('detects a paraphrased core claim', () => {
    const similarity = semanticMemorySimilarity(
      'Named exception owners prevent teams from repeating approval checks.',
      'Duplicate approval checks disappear when every exception has an explicit owner.',
    );
    assert.ok(similarity >= .62);
  });

  it('allows territory reuse while increasing saturation softly', () => {
    const memory = createRecentContentMemory([memoryFingerprint()]);
    const candidate = memoryFingerprint({ coreClaim: 'A different claim about queue deadlines.', mechanism: 'deadline visibility' });
    const first = scoreAgainstRecentContentMemory(candidate, memory);
    updateRecentContentMemory(memory, memoryFingerprint({ coreClaim: 'Another distinct claim.', mechanism: 'handoff timing' }));
    const second = scoreAgainstRecentContentMemory(candidate, memory);
    assert.ok(second.total > first.total);
    assert.ok(second.total < 90);
  });

  it('treats repeated hook family as a light penalty only', () => {
    const memory = createRecentContentMemory([memoryFingerprint()]);
    const penalty = scoreAgainstRecentContentMemory(memoryFingerprint({
      pillar: 'Recruiting', territory: 'Different territory', coreClaim: 'A completely distinct hiring calibration claim.',
      mechanism: 'shared scoring examples align interviewer judgment', ideaFamily: 'calibration',
      argumentPattern: 'CONTRAST_REFRAME', endingType: 'ACTION_CLOSE', ctaType: 'ACTION_CTA',
      perspective: 'interviewer calibration', contentIntent: 'COMPARE_OPTIONS', authorityMode: 'SOURCE_GROUNDED',
    }), memory);
    assert.equal(penalty.strong.length, 0);
    assert.ok(penalty.light.some((reason) => reason.startsWith('hook_reuse')));
    assert.ok(penalty.total <= 6);
  });

  it('penalizes repeated argument patterns', () => {
    const memory = createRecentContentMemory([memoryFingerprint()]);
    const penalty = scoreAgainstRecentContentMemory(memoryFingerprint({
      territory: 'Different', coreClaim: 'Distinct claim about diagnostic thresholds.', mechanism: 'threshold calibration',
      ideaFamily: 'diagnostic', hookType: 'DIRECT_CLAIM_HOOK', endingType: 'ACTION_CLOSE',
    }), memory);
    assert.ok(penalty.medium.some((reason) => reason.startsWith('argument_pattern_reuse')));
  });

  it('applies the same memory scoring to search-derived candidates', () => {
    const memory = createRecentContentMemory([memoryFingerprint({ mechanism: 'named exception ownership creates one escalation path' })]);
    const repeated = ranked('Recruiting operations', 'Exception ownership improves interview operations.', 'named exception ownership creates one escalation path', 100);
    const fresh = ranked('Clinical follow-up', 'Escalation windows expose delayed follow-up.', 'time bounded escalation window', 82);
    const [selected] = selectRankedCandidatesWithMemory([repeated, fresh], 1, memory);
    assert.equal(selected.trend.topic, 'Clinical follow-up');
  });

  it('updates diversity memory after each current-batch selection', () => {
    const memory = createRecentContentMemory();
    const first = ranked('Approval ownership', 'Exception owners reduce duplicate decisions.', 'shared calibration mechanism', 100);
    const repeated = ranked('Interview scoring', 'Scoring owners reduce inconsistent decisions.', 'shared calibration mechanism', 95);
    const diverse = ranked('Clinical follow-up', 'Escalation windows expose delayed care.', 'independent feedback loop', 80);
    const selected = selectRankedCandidatesWithMemory([first, repeated, diverse], 2, memory);
    assert.deepEqual(selected.map((item) => item.trend.topic), ['Approval ownership', 'Clinical follow-up']);
    assert.equal(memory.fingerprints.filter((item) => item.origin === 'CURRENT_BATCH').length, 2);
  });

  it('classifies hook family from the final post rather than editorial angle', () => {
    const classified = classifyFinalPostFingerprint('Why do exception queues keep growing?\n\nOwnership is implicit, so nobody closes the loop.');
    assert.equal(classified.hookType, 'QUESTION_HOOK');
  });

  it('classifies meaningful ending and CTA families', () => {
    const takeaway = classifyFinalPostFingerprint('Ownership controls queue health.\n\nThis means the escalation path is part of the design.');
    const action = classifyFinalPostFingerprint('Ownership controls queue health.\n\nReview the exception owner before adding another approval.');
    assert.equal(takeaway.endingType, 'SYNTHESIS_CLOSE');
    assert.equal(takeaway.ctaType, 'TAKEAWAY_CLOSE');
    assert.equal(action.ctaType, 'ACTION_CTA');
  });

  it('keeps legacy users with no rich fingerprints generatable', () => {
    const memory = createRecentContentMemory();
    const candidate = ranked('Legacy topic', 'A useful legacy claim.', 'a useful mechanism', 70);
    const selected = selectRankedCandidatesWithMemory([candidate], 1, memory)[0];
    assert.equal(selected.trend.topic, candidate.trend.topic);
    assert.equal(selected.totalScore, candidate.totalScore);
  });
});
