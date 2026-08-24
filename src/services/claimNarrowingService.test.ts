import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assessSelectedClaim,
  deriveNarrowCentralClaim,
  evaluateClaimSemanticFidelity,
  isAlreadySpecificClaim,
  isObviouslyGenericClaim,
} from './claimNarrowingService';
import { scoreSpecificity } from './ghostwriterValidationService';
import { buildExpandSpecificityPrompt, buildPlanBlock, buildRepairPrompt } from './ghostwriterPrompts';
import type { AuthorContext, BatchPostPlan, GeneratedPostContent, TrendCandidate } from './generationTypes';
import { buildDeterministicBatchPlan } from './ghostwriterBatchPlanner';
import { ContentService } from './contentService';
import { postDepthPlanSchema } from './ghostwriterSchemas';

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

  it('hands the selected central claim to drafting and both repair paths', () => {
    const centralClaim = 'Increasing lead volume can lower pipeline efficiency when qualification criteria stay unchanged.';
    const plan: BatchPostPlan = { trendIndex: 0, sourceTopic: 'Lead generation', centralClaim, angle: 'defensible_opinion', hookStyle: 'observation', endingStyle: 'natural', layout: 'opinion_with_reasoning', rationale: 'test', expressionMode: 'analytical' };
    const author: AuthorContext = { description: 'B2B marketer', tone: 'conversational', niches: ['marketing'] };
    const post: GeneratedPostContent = { headline: '', subheadline: '', bulletPoints: [], body: centralClaim, hashtags: '' };
    assert.match(buildPlanBlock(plan), new RegExp(centralClaim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(buildPlanBlock(plan), /SELECTED CENTRAL CLAIM — PRESERVE THIS MEANING/);
    assert.match(buildRepairPrompt(post, ['generic'], author, plan), /Preserve the SELECTED CENTRAL CLAIM and its meaning/);
    assert.match(buildExpandSpecificityPrompt(post, undefined, author, plan), /without changing the SELECTED CENTRAL CLAIM/);
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

describe('claim provenance and planner fidelity', () => {
  const author: AuthorContext = { description: 'Operations writer', tone: 'Direct', niches: ['Operations'] };
  const selectedClaim = 'Server-side entitlement checks prevent clients from granting access when subscription state is stale.';

  function strategyTrend(topic = selectedClaim): TrendCandidate {
    return {
      topic,
      sourceType: 'strategy_derived',
      ideaOrigin: 'STRATEGY_DERIVED',
      territory: 'Access decisions',
      fingerprint: {
        normalizedTopic: 'access decisions',
        topicCluster: 'access_decisions',
        coreClaim: topic,
        entities: ['access'],
        mechanisms: ['server-side entitlement'],
      },
    };
  }

  function modelResponse(centralClaim: string, depthPlan: Record<string, unknown> = {}): string {
    return JSON.stringify({ claims: [{
      index: 0,
      centralClaim,
      depthPlan: { centralClaim, ...depthPlan },
    }] });
  }

  it('preserves a strong strategy-selected claim when the planner proposes a broad summary', async () => {
    const trend = strategyTrend();
    const [base] = buildDeterministicBatchPlan([trend], 1);
    assert.equal(base.claimSource, 'STRATEGY_SELECTED');
    const service = new ContentService({});
    (service as any).generateWithFallback = async () => modelResponse('Entitlement management is important for successful digital products.');

    const [planned] = await service.narrowBatchClaims([base], [trend], author);
    assert.equal(planned.centralClaim, selectedClaim);
    assert.equal(planned.depthPlan?.underlyingCauseOrMechanism, null);
    assert.equal(planned.depthPlan?.centralClaim, selectedClaim);
  });

  it('does not let planning replace the selected mechanism', async () => {
    const trend = strategyTrend();
    const [base] = buildDeterministicBatchPlan([trend], 1);
    const changedMechanism = 'Client-side visual hierarchy improves conversion when navigation choices remain unclear.';
    const service = new ContentService({});
    (service as any).generateWithFallback = async () => modelResponse(changedMechanism, {
      underlyingCauseOrMechanism: 'Client-side visual hierarchy',
    });

    const [planned] = await service.narrowBatchClaims([base], [trend], author);
    assert.equal(planned.centralClaim, selectedClaim);
    assert.equal(planned.depthPlan?.underlyingCauseOrMechanism, null);
    assert.ok(evaluateClaimSemanticFidelity(
      selectedClaim,
      changedMechanism,
      ['server-side entitlement'],
    ).reasons.includes('different_mechanism'));
  });

  it('still narrows a search-discovered headline', async () => {
    const trend: TrendCandidate = {
      topic: 'New workflow approval report finds recovery gaps',
      sourceType: 'searched',
      summary: 'The report distinguishes approval state from execution state.',
      keyPoints: ['Approval state persists', 'Retries inspect execution state'],
    };
    const [base] = buildDeterministicBatchPlan([trend], 1);
    const narrowed = 'Workflow recovery becomes safer when approval state is stored separately from execution state.';
    const service = new ContentService({});
    (service as any).generateWithFallback = async () => modelResponse(narrowed);

    const [planned] = await service.narrowBatchClaims([base], [trend], author);
    assert.equal(base.claimSource, 'SEARCH_DISCOVERED');
    assert.equal(planned.centralClaim, narrowed);
  });

  it('allows a malformed strategy-selected claim to be faithfully corrected', async () => {
    const trend = strategyTrend('Automation workflows fail because.');
    const [base] = buildDeterministicBatchPlan([trend], 1);
    const corrected = 'Automation workflows fail when approval state and execution state share one ambiguous transition.';
    const service = new ContentService({});
    (service as any).generateWithFallback = async () => modelResponse(corrected);

    const [planned] = await service.narrowBatchClaims([base], [trend], author);
    assert.equal(assessSelectedClaim(trend.topic).usable, false);
    assert.equal(planned.centralClaim, corrected);
  });

  it('accepts a compact depth plan with omitted optional fields', () => {
    const parsed = postDepthPlanSchema.safeParse({
      centralClaim: selectedClaim,
      underlyingCauseOrMechanism: 'The server owns the entitlement decision.',
      meaningfulConsequence: 'The client cannot grant itself access.',
    });
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.success ? parsed.data.strongestObservations : null, []);
    assert.equal(parsed.success ? parsed.data.deeperInterpretation : 'unexpected', null);
  });

  it('preserves a usable original claim when the planner call fails', async () => {
    const trend = strategyTrend();
    const [base] = buildDeterministicBatchPlan([trend], 1);
    const service = new ContentService({});
    (service as any).generateWithFallback = async () => { throw new Error('planner unavailable'); };

    const [planned] = await service.narrowBatchClaims([base], [trend], author);
    assert.equal(planned.centralClaim, selectedClaim);
  });

  it('recognizes strategy template relationships and preserves them in fallback', () => {
    const claim = 'AI Automation looks flexible until approval ownership starts dictating the surrounding workflow.';
    assert.equal(assessSelectedClaim(claim).usable, true);
    assert.equal(deriveNarrowCentralClaim({ topic: claim, candidateClaim: claim, expressionMode: 'diagnostic' }), claim);
  });

  it('does not concatenate a malformed sentence into fallback grammar', async () => {
    const trend = strategyTrend('Automation workflows fail because.');
    const [base] = buildDeterministicBatchPlan([trend], 1);
    const service = new ContentService({});
    (service as any).generateWithFallback = async () => { throw new Error('planner unavailable'); };

    const [planned] = await service.narrowBatchClaims([base], [trend], author);
    assert.equal(assessSelectedClaim(planned.centralClaim ?? '').usable, true);
    assert.doesNotMatch(planned.centralClaim ?? '', /fail because/i);
    assert.doesNotMatch(planned.centralClaim ?? '', /Recurring problems in Automation workflows/i);
  });

  it('keeps legacy topic plans generatable through the existing narrowing call', async () => {
    const trend: TrendCandidate = { topic: 'Approval workflows' };
    const [base] = buildDeterministicBatchPlan([trend], 1);
    const narrowed = 'Approval workflows fail when ownership of the release decision remains implicit.';
    const service = new ContentService({});
    (service as any).generateWithFallback = async () => modelResponse(narrowed);

    const [planned] = await service.narrowBatchClaims([base], [trend], author);
    assert.equal(base.claimSource, 'LEGACY_TOPIC');
    assert.equal(planned.centralClaim, narrowed);
    assert.equal(assessSelectedClaim(planned.centralClaim ?? '').usable, true);
  });
});
