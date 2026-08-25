import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { classifyConceptualMotif } from './conceptualMotifService';
import { classifyFinalPostFingerprint } from './finalPostFingerprintClassifier';
import type { RankedTrendCandidate } from './generationTypes';
import {
  createRecentContentMemory,
  scoreAgainstRecentContentMemory,
  type RecentContentFingerprint,
} from './recentContentMemoryService';
import { selectUnifiedBatchCandidates } from './unifiedBatchCandidateService';

function memory(overrides: Partial<RecentContentFingerprint> = {}): RecentContentFingerprint {
  return {
    topic: 'topic', coreClaim: 'A bounded decision changes the outcome.', mechanism: 'bounded decision',
    perspective: 'operator decision', pillar: 'Pillar A', territory: 'Territory A',
    candidateId: 'candidate:prior', origin: 'HISTORICAL', ...overrides,
  };
}

function candidate(input: {
  id: string; claim: string; mechanism: string; motif: string; archetype: string;
  pillar?: string; perspective?: string; searched?: boolean; score?: number;
}): RankedTrendCandidate {
  const score = input.score ?? 85;
  const pillar = input.pillar ?? 'Pillar A';
  const fingerprint = {
    normalizedTopic: input.id, topicCluster: input.id, coreClaim: input.claim,
    entities: [], mechanisms: [input.mechanism],
  };
  return {
    trend: {
      topic: input.claim, summary: input.claim, matchedPillar: pillar, territory: input.id,
      sourceType: input.searched ? 'searched' : 'strategy_derived',
      ideaOrigin: input.searched ? 'SEARCH_DISCOVERED' : 'STRATEGY_DERIVED',
      authorityMode: 'SUPPORTED_PRACTITIONER', ideaQualityScore: score,
      audienceRelevance: input.perspective ?? 'operator decision',
      conceptualMotif: input.motif, reasoningArchetype: input.archetype,
    },
    fingerprint, relevanceScore: score, sourceQualityScore: 75, recencyScore: 70,
    technicalDepthScore: score, noveltyScore: 90, totalScore: score,
    novelty: { allowed: true, score: 90, reasons: [] }, matchedPillar: pillar,
    audienceRelevance: input.perspective ?? 'operator decision',
  };
}

describe('conceptual motif classification and memory', () => {
  it('penalizes different topics with the same abstract motif', () => {
    const recent = createRecentContentMemory([memory({
      conceptualMotif: 'LOCAL_IMPROVEMENT_SHIFTS_COST', reasoningArchetype: 'COST_OR_CONSTRAINT_TRANSFER',
      coreClaim: 'Faster screening moves congestion into onboarding.', mechanism: 'screening throughput',
    })]);
    const result = scoreAgainstRecentContentMemory(memory({
      topic: 'inventory allocation', pillar: 'Pillar B', territory: 'Territory B',
      coreClaim: 'Optimizing one warehouse moves the bottleneck downstream.', mechanism: 'warehouse allocation',
      conceptualMotif: 'LOCAL_IMPROVEMENT_SHIFTS_COST', reasoningArchetype: 'COST_OR_CONSTRAINT_TRANSFER',
    }), recent);
    assert.equal(result.motifPenalty, 28);
    assert.equal(result.motifCollisionCandidateId, 'candidate:prior');
  });

  it('applies motif memory across different pillars', () => {
    const recent = createRecentContentMemory([memory({ pillar: 'Health', conceptualMotif: 'CONTEXT_CHANGES_RULE_VALIDITY', reasoningArchetype: 'CONTEXT_DEPENDENT_VALIDITY' })]);
    const result = scoreAgainstRecentContentMemory(memory({ pillar: 'Finance', territory: 'Portfolio policy', conceptualMotif: 'CONTEXT_CHANGES_RULE_VALIDITY', reasoningArchetype: 'CONTEXT_DEPENDENT_VALIDITY' }), recent);
    assert.ok(result.motifPenalty >= 16);
  });

  it('does not add motif penalty for the same topic with a different thesis shape', () => {
    const recent = createRecentContentMemory([memory({ conceptualMotif: 'VISIBILITY_WITHOUT_SYSTEM_CHANGE', reasoningArchetype: 'SURFACE_VS_UNDERLYING_SYSTEM' })]);
    const result = scoreAgainstRecentContentMemory(memory({ conceptualMotif: 'UPSTREAM_DECISION_CONTROLS_DOWNSTREAM', reasoningArchetype: 'DEPENDENCY_OR_CONTROL' }), recent);
    assert.equal(result.motifPenalty, 0);
  });

  it('leaves concrete mechanism and perspective handling in the existing layer', () => {
    const recent = createRecentContentMemory([memory({ mechanism: 'authoritative approval owner', perspective: 'operator decision' })]);
    const result = scoreAgainstRecentContentMemory(memory({ mechanism: 'approval owner authority', perspective: 'audience consequence' }), recent);
    assert.ok(result.maxMechanismSimilarity >= .45);
    assert.equal(result.motifPenalty, 0);
  });

  it('does not infer conceptual motif from rhetorical structure alone', () => {
    const result = classifyConceptualMotif('Observation. Because the evidence exists. Therefore a consequence follows.');
    assert.equal(result.conceptualMotif, null);
  });

  it('recognizes local optimization moving a bottleneck across unrelated domains', () => {
    const first = classifyConceptualMotif('A local optimization in triage moves the bottleneck downstream into discharge.');
    const second = classifyConceptualMotif('Fixing one warehouse shifts the bottleneck elsewhere in fulfillment.');
    assert.equal(first.conceptualMotif, 'LOCAL_IMPROVEMENT_SHIFTS_COST');
    assert.equal(second.conceptualMotif, first.conceptualMotif);
  });

  it('recognizes context-dependent rule validity across unrelated domains', () => {
    const first = classifyConceptualMotif('A standard practice stops working when the surrounding context changes.');
    const second = classifyConceptualMotif('The portfolio rule is valid only under the constraint that justified it.');
    assert.equal(first.conceptualMotif, 'CONTEXT_CHANGES_RULE_VALIDITY');
    assert.equal(second.conceptualMotif, first.conceptualMotif);
  });

  it('updates current-batch motif memory immediately after selection', () => {
    const first = candidate({ id: 'first', claim: 'A local improvement moves cost into the next stage.', mechanism: 'local throughput', motif: 'LOCAL_IMPROVEMENT_SHIFTS_COST', archetype: 'COST_OR_CONSTRAINT_TRANSFER', score: 90 });
    const repeated = candidate({ id: 'repeat', claim: 'Optimizing one queue shifts the bottleneck elsewhere.', mechanism: 'queue throughput', motif: 'LOCAL_IMPROVEMENT_SHIFTS_COST', archetype: 'COST_OR_CONSTRAINT_TRANSFER', score: 89, pillar: 'Pillar B' });
    const distinct = candidate({ id: 'distinct', claim: 'An upstream decision determines the later handoff.', mechanism: 'decision boundary', motif: 'UPSTREAM_DECISION_CONTROLS_DOWNSTREAM', archetype: 'DEPENDENCY_OR_CONTROL', score: 88, pillar: 'Pillar C' });
    const selected = selectUnifiedBatchCandidates([first, repeated, distinct], 2);
    assert.deepEqual(selected.map((item) => item.coreClaim), [first.fingerprint.coreClaim, distinct.fingerprint.coreClaim]);
  });

  it('uses a historical motif as a soft rather than absolute block', () => {
    const recent = createRecentContentMemory([memory({ conceptualMotif: 'CONTEXT_CHANGES_RULE_VALIDITY', reasoningArchetype: 'CONTEXT_DEPENDENT_VALIDITY', perspective: 'diagnostic' })]);
    const result = scoreAgainstRecentContentMemory(memory({ conceptualMotif: 'CONTEXT_CHANGES_RULE_VALIDITY', reasoningArchetype: 'CONTEXT_DEPENDENT_VALIDITY', perspective: 'operator decision', mechanism: 'different mechanism' }), recent);
    assert.equal(result.motifPenalty, 16);
    assert.ok(result.total < 90);
  });

  it('keeps legacy fingerprints without motifs safe', () => {
    const recent = createRecentContentMemory([memory({ conceptualMotif: undefined, reasoningArchetype: undefined })]);
    const result = scoreAgainstRecentContentMemory(memory({ conceptualMotif: 'CONTEXT_CHANGES_RULE_VALIDITY', reasoningArchetype: 'CONTEXT_DEPENDENT_VALIDITY' }), recent);
    assert.equal(result.motifPenalty, 0);
    assert.equal(result.motifSimilarity, 0);
  });

  it('does not overblock a broad strategic archetype with a different motif and perspective', () => {
    const recent = createRecentContentMemory([memory({ conceptualMotif: 'TOOL_OR_PROCESS_BECOMES_CONSTRAINT', reasoningArchetype: 'DEPENDENCY_OR_CONTROL', perspective: 'diagnostic' })]);
    const result = scoreAgainstRecentContentMemory(memory({ conceptualMotif: 'UPSTREAM_DECISION_CONTROLS_DOWNSTREAM', reasoningArchetype: 'DEPENDENCY_OR_CONTROL', perspective: 'operator decision' }), recent);
    assert.equal(result.motifPenalty, 0);
  });

  it('classifies the final body independently from rhetorical form', () => {
    const final = classifyFinalPostFingerprint('A simple policy works at first.\n\nAs the organization grows, coordination cost makes that policy a constraint.');
    assert.equal(final.conceptualMotif, 'SIMPLICITY_CREATES_LATER_COORDINATION_COST');
    assert.equal(final.reasoningArchetype, 'TEMPORAL_TRADEOFF');
  });

  it('applies motif memory to strategy and search candidates alike', () => {
    const recent = createRecentContentMemory([memory({ conceptualMotif: 'LOCAL_IMPROVEMENT_SHIFTS_COST', reasoningArchetype: 'COST_OR_CONSTRAINT_TRANSFER' })]);
    const events: Array<{ origin: string; motifPenalty: number }> = [];
    selectUnifiedBatchCandidates([
      candidate({ id: 'strategy', claim: 'One local fix shifts cost downstream.', mechanism: 'local fix', motif: 'LOCAL_IMPROVEMENT_SHIFTS_COST', archetype: 'COST_OR_CONSTRAINT_TRANSFER' }),
      candidate({ id: 'search', claim: 'A local optimization moves the bottleneck elsewhere.', mechanism: 'local optimization', motif: 'LOCAL_IMPROVEMENT_SHIFTS_COST', archetype: 'COST_OR_CONSTRAINT_TRANSFER', searched: true }),
    ], 2, recent, undefined, { observer: (event) => events.push({ origin: event.candidate.origin, motifPenalty: event.motifPenalty }) });
    assert.ok(events.some((event) => event.origin === 'STRATEGY_DERIVED' && event.motifPenalty > 0));
    assert.ok(events.some((event) => event.origin === 'SEARCH_DISCOVERED' && event.motifPenalty > 0));
  });

  it('uses no niche branch or per-post model call', () => {
    const source = readFileSync(require.resolve('./conceptualMotifService'), 'utf8');
    assert.doesNotMatch(source, /OpenAI|chat\.completions|responses\.create|generateContent/);
    assert.doesNotMatch(source, /\b(?:software|healthcare|recruiting|finance|real estate|Unity|UiPath)\b/i);
  });
});
