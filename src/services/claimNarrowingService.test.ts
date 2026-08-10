import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deriveNarrowCentralClaim, isAlreadySpecificClaim, isObviouslyGenericClaim } from './claimNarrowingService';
import { scoreSpecificity } from './ghostwriterValidationService';
import { buildExpandSpecificityPrompt, buildPlanBlock, buildRepairPrompt } from './ghostwriterPrompts';
import type { AuthorContext, BatchPostPlan, GeneratedPostContent } from './generationTypes';

describe('domain-agnostic claim narrowing', () => {
  it('rejects topic-level benefit statements', () => {
    assert.equal(isObviouslyGenericClaim('Data quality is important for long-term success.'), true);
    assert.equal(isObviouslyGenericClaim('Good onboarding improves customer experience.'), true);
  });

  it('rewrites generic claims across professional domains', () => {
    const cases = [
      ['API scalability', 'API design is important for scalability.'],
      ['Denial management', 'Denial management is essential for healthcare organizations.'],
      ['Lead generation', 'Marketing is critical for business growth.'],
      ['Team performance', 'Leadership plays an important role in team success.'],
      ['Discovery calls', 'Good sales processes improve revenue.'],
    ];
    for (const [topic, generic] of cases) {
      const narrowed = deriveNarrowCentralClaim({ topic, candidateClaim: generic, expressionMode: 'analytical' });
      assert.notEqual(narrowed, generic);
      assert.equal(isObviouslyGenericClaim(narrowed), false);
    }
  });

  it('produces different claims for one topic when the angle changes', () => {
    const angles = ['technical_mistake', 'architecture_tradeoff', 'defensible_opinion', 'product_lesson', 'reflection'] as const;
    const claims = angles.map((angle) => deriveNarrowCentralClaim({ topic: 'Denial management', angle }));
    assert.equal(new Set(claims).size, angles.length);
  });

  it('hands the fixed central claim to drafting and both repair paths', () => {
    const centralClaim = 'Increasing lead volume can lower pipeline efficiency when qualification criteria stay unchanged.';
    const plan: BatchPostPlan = { trendIndex: 0, sourceTopic: 'Lead generation', centralClaim, angle: 'defensible_opinion', hookStyle: 'observation', endingStyle: 'natural', layout: 'opinion_with_reasoning', rationale: 'test', expressionMode: 'analytical' };
    const author: AuthorContext = { description: 'B2B marketer', tone: 'conversational', niches: ['marketing'] };
    const post: GeneratedPostContent = { headline: '', subheadline: '', bulletPoints: [], body: centralClaim, hashtags: '' };
    assert.match(buildPlanBlock(plan), new RegExp(centralClaim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(buildRepairPrompt(post, ['generic'], author, plan), /Preserve the fixed CENTRAL CLAIM/);
    assert.match(buildExpandSpecificityPrompt(post, undefined, author, plan), /without changing the fixed CENTRAL CLAIM/);
  });

  it('preserves an already-specific user claim exactly', () => {
    const claim = 'Lowering a listing price too early can weaken buyer confidence when demand is temporarily seasonal.';
    assert.equal(isAlreadySpecificClaim(claim), true);
    assert.equal(deriveNarrowCentralClaim({ topic: claim, expressionMode: 'direct' }), claim);
  });

  const domains = [
    { topic: 'API authorization', mode: 'diagnostic' as const },
    { topic: 'post-surgery follow-up', mode: 'analytical' as const },
    { topic: 'home listing price cuts', mode: 'reflective' as const },
    { topic: 'sales qualification', mode: 'opinionated' as const },
    { topic: 'filing an administrative appeal', mode: 'walkthrough' as const },
  ];

  for (const example of domains) {
    it(`creates a narrow relationship for ${example.topic}`, () => {
      const claim = deriveNarrowCentralClaim({ topic: example.topic, expressionMode: example.mode });
      assert.equal(isObviouslyGenericClaim(claim), false);
      assert.equal(isAlreadySpecificClaim(claim), true);
      assert.ok(scoreSpecificity(claim).score >= 50, `${claim} should pass domain-neutral specificity`);
    });
  }
});
