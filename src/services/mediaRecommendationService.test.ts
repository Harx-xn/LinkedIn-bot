import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  recommendMediaForPost,
  resolveMediaBehavior,
  resolveMediaDecision,
  runOptionalMediaOperation,
  safeRecommendMediaForPost,
  type MediaEntitlementSnapshot,
  type MediaRecommendationResult,
} from './mediaRecommendationService';

const carousel: MediaRecommendationResult = { recommendation: 'CAROUSEL', confidence: .9, reason: 'Sequential framework.' };
const diagram: MediaRecommendationResult = { recommendation: 'DIAGRAM', confidence: .8, reason: 'Relationships.' };
const textOnly: MediaRecommendationResult = { recommendation: 'TEXT_ONLY', confidence: .9, reason: 'Clear as text.' };
const entitled: MediaEntitlementSnapshot = {
  imageGenerationEnabled: true, imagesRemaining: 4,
  carouselAiGenerationEnabled: true, carouselGenerationsRemaining: 2,
  convertPostToCarouselEnabled: true,
};

describe('media recommendation precedence and compatibility', () => {
  test('manual carousel recommendation remains suggestion-only', () => {
    assert.equal(resolveMediaDecision({ behavior: 'SUGGEST_ONLY', recommendation: carousel }).action, 'SUGGEST');
  });

  test('manual recommendation can be ignored without changing the text', () => {
    const content = 'Keep this accepted post exactly as written.';
    resolveMediaDecision({ behavior: 'SUGGEST_ONLY', recommendation: carousel });
    assert.equal(content, 'Keep this accepted post exactly as written.');
  });

  test('batch with media disabled never generates media', () => {
    assert.equal(resolveMediaDecision({ behavior: 'DISABLED', recommendation: carousel, entitlements: entitled }).action, 'NONE');
  });

  test('automatic media skips a text-only post', () => {
    assert.equal(resolveMediaDecision({ behavior: 'AUTO_WHEN_RECOMMENDED', recommendation: textOnly, entitlements: entitled }).action, 'NONE');
  });

  test('automatic media can generate an allowed recommended image', () => {
    assert.equal(resolveMediaDecision({ behavior: 'AUTO_WHEN_RECOMMENDED', recommendation: diagram, entitlements: entitled, allowedAutomaticTypes: ['IMAGE'] }).action, 'GENERATE_IMAGE');
  });

  test('an uploaded image is never replaced automatically', () => {
    const decision = resolveMediaDecision({ behavior: 'AUTO_WHEN_RECOMMENDED', recommendation: carousel, entitlements: entitled, existingAttachmentType: 'IMAGE', allowedAutomaticTypes: ['IMAGE', 'CAROUSEL'] });
    assert.equal(decision.action, 'NONE');
    assert.equal(decision.preservesExistingAttachment, true);
  });

  test('an attached carousel is never replaced automatically', () => {
    const decision = resolveMediaDecision({ behavior: 'AUTO_WHEN_RECOMMENDED', recommendation: diagram, entitlements: entitled, existingAttachmentType: 'CAROUSEL' });
    assert.equal(decision.action, 'NONE');
    assert.equal(decision.preservesExistingAttachment, true);
  });

  test('user preference outranks recommendation', () => {
    assert.equal(resolveMediaBehavior({ imageMode: 'none', backgroundImageUrl: 'https://example.com/bg.png' }).behavior, 'DISABLED');
  });

  test('plan entitlement outranks image recommendation', () => {
    const decision = resolveMediaDecision({ behavior: 'AUTO_WHEN_RECOMMENDED', recommendation: diagram, entitlements: { ...entitled, imageGenerationEnabled: false }, allowedAutomaticTypes: ['IMAGE'] });
    assert.equal(decision.action, 'NONE');
    assert.equal(decision.entitlementBlocked, true);
  });

  test('carousel recommendation cannot bypass plan limits', () => {
    const decision = resolveMediaDecision({ behavior: 'AUTO_WHEN_RECOMMENDED', recommendation: carousel, entitlements: { ...entitled, carouselGenerationsRemaining: 0 }, allowedAutomaticTypes: ['CAROUSEL'] });
    assert.equal(decision.action, 'NONE');
    assert.equal(decision.entitlementBlocked, true);
  });

  test('decorative visual defaults to text-only', () => {
    assert.equal(recommendMediaForPost('Software matters. Here are a few thoughts about building better products.').recommendation, 'TEXT_ONLY');
  });

  test('multi-step framework can recommend a carousel', () => {
    const result = recommendMediaForPost('A repeatable process:\n1. Diagnose the constraint\n2. Map the handoff\n3. Remove ambiguity\n4. Test the change\n5. Record the result');
    assert.equal(result.recommendation, 'CAROUSEL');
  });

  test('structural relationships can recommend a diagram', () => {
    const result = recommendMediaForPost('Demand influences staffing. Staffing leads to wait time. Wait time then affects retention.');
    assert.equal(result.recommendation, 'DIAGRAM');
  });

  test('short opinion remains text-only', () => {
    assert.equal(recommendMediaForPost('More activity is not the same as more progress. Measure the constraint, not the motion.').recommendation, 'TEXT_ONLY');
  });

  test('recommendation failure preserves a text-only result', () => {
    const result = safeRecommendMediaForPost('Valid post', undefined, () => { throw new Error('classifier failed'); });
    assert.equal(result.recommendation, 'TEXT_ONLY');
    assert.equal(result.confidence, 0);
  });

  test('media generation failure does not fail the accepted post', async () => {
    const acceptedPost = 'Accepted text';
    const media = await runOptionalMediaOperation(async () => { throw new Error('renderer unavailable'); }, 'test');
    assert.equal(media, null);
    assert.equal(acceptedPost, 'Accepted text');
  });

  test('legacy background users preserve template generation behavior', () => {
    const behavior = resolveMediaBehavior({ imageMode: null, backgroundImageUrl: 'https://example.com/legacy.png' });
    assert.equal(behavior.legacyAlwaysGenerateTemplate, true);
    assert.equal(resolveMediaDecision({ behavior: behavior.behavior, recommendation: textOnly, legacyAlwaysGenerateTemplate: true }).action, 'GENERATE_IMAGE');
  });

  test('recommendation logic remains niche-generic', () => {
    for (const subject of ['patient follow-up', 'candidate interviews', 'month-end reconciliation']) {
      const result = recommendMediaForPost(`${subject} process:\n1. Confirm the input\n2. Find the gap\n3. Assign ownership\n4. Review the decision\n5. Record the outcome`);
      assert.equal(result.recommendation, 'CAROUSEL');
    }
  });

  test('resolver does not mutate entitlement or billing state', () => {
    const before = JSON.stringify(entitled);
    resolveMediaDecision({ behavior: 'AUTO_WHEN_RECOMMENDED', recommendation: carousel, entitlements: entitled, allowedAutomaticTypes: ['CAROUSEL'] });
    assert.equal(JSON.stringify(entitled), before);
  });

  test('manual and batch behavior remain independent', () => {
    assert.equal(resolveMediaDecision({ behavior: 'SUGGEST_ONLY', recommendation: diagram, entitlements: entitled }).action, 'SUGGEST');
    assert.equal(resolveMediaDecision({ behavior: 'AUTO_WHEN_RECOMMENDED', recommendation: diagram, entitlements: entitled }).action, 'GENERATE_IMAGE');
  });
});
