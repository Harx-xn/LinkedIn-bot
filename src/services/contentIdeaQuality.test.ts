import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateCandidateSubstance, scoreContentIdea, type ContentIdeaCandidate } from './contentIdeaService';

function idea(overrides: Partial<Omit<ContentIdeaCandidate, 'score' | 'rejectedReasons'>> = {}): Omit<ContentIdeaCandidate, 'score' | 'rejectedReasons'> {
  return {
    id: 'idea', pillar: 'Software Delivery', territory: 'Build Reliability',
    coreClaim: 'Content-addressed assets prevent unchanged bundles from inflating every build.',
    mechanism: 'content hashes isolate unchanged assets before build packaging',
    perspective: 'release reliability', ideaFamily: 'artifact identity', origin: 'STRATEGY_DERIVED',
    authorityMode: 'EXPLORATORY', searchRequired: false, saturationPenalty: 0,
    audienceConsequence: 'Smaller artifacts reduce upload time and failed release retries.',
    ...overrides,
  };
}

test('generic replaceable-niche idea has insufficient substance and is rejected', () => {
  const generic = idea({
    coreClaim: 'Web developers need to keep learning because technology changes.',
    mechanism: 'technology keeps changing', audienceConsequence: undefined,
  });
  const substance = evaluateCandidateSubstance(generic);
  const result = scoreContentIdea(generic);
  assert.equal(substance.substantive, false);
  assert.equal(substance.replaceableNicheRisk, true);
  assert.ok(result.rejectedReasons.includes('insufficient_candidate_substance'));
  assert.ok(result.rejectedReasons.includes('replaceable_niche_claim'));
  assert.ok(result.score.composite <= 38);
});

test('a saturated topic remains usable when it carries a concrete novel mechanism', () => {
  const concrete = idea({ saturationPenalty: 24 });
  const result = scoreContentIdea(concrete);
  assert.equal(evaluateCandidateSubstance(concrete).substantive, true);
  assert.equal(result.rejectedReasons.includes('insufficient_candidate_substance'), false);
  assert.equal(result.rejectedReasons.includes('replaceable_niche_claim'), false);
});

test('a strong niche-specific technical candidate passes the substance gate', () => {
  const result = evaluateCandidateSubstance(idea());
  assert.equal(result.substantive, true);
  assert.ok(result.dimensions.includes('concrete_detail'));
  assert.ok(result.dimensions.includes('consequence'));
});
