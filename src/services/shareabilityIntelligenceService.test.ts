import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { buildAccountPerformanceProfile } from './accountPerformanceLearningService';
import { assessShareability } from './shareabilityIntelligenceService';

describe('content shareability intelligence', () => {
  test('one sharp insight can score high without becoming a list', () => {
    const profile = assessShareability({
      centralClaim: 'A faster decision is useful only when it removes uncertainty rather than hiding it.',
      mechanism: 'Speed without an explicit decision owner moves uncertainty into the next handoff.',
      audienceConsequence: 'Teams can distinguish quick resolution from deferred ambiguity.',
    });
    assert.ok(profile.overallPotential >= 60);
    assert.ok(!['FRAMEWORK', 'CAROUSEL_CANDIDATE'].includes(profile.recommendedPresentation));
  });

  test('generic long repetition has lower value density', () => {
    const generic = assessShareability({
      centralClaim: 'Communication is important.',
      supportingText: Array.from({ length: 45 }, () => 'Communication is important and helps improve success.').join(' '),
    });
    const focused = assessShareability({
      centralClaim: 'A handoff fails when responsibility is transferred without transferring the decision context.',
      mechanism: 'The receiver inherits a task but not the constraint that shaped it.',
    });
    assert.ok(generic.valueDensity < focused.valueDensity);
  });

  test('a genuine framework has high save and reference potential', () => {
    const profile = assessShareability({
      centralClaim: 'A useful decision framework separates urgency from reversibility.',
      supportingText: 'Stage one identifies urgency. Stage two tests reversibility. The matrix then guides the decision.',
      ideaFamily: 'decision framework',
      contentObjective: 'CREATE_REFERENCE_VALUE',
    });
    assert.ok(profile.saveValue >= 65);
    assert.ok(profile.referenceValue >= 70);
    assert.equal(profile.recommendedPresentation, 'FRAMEWORK');
  });

  test('artificially numbered repetition is penalized', () => {
    const profile = assessShareability({
      centralClaim: 'Clarity matters.',
      supportingText: '1. Clarity matters\n2. Clarity matters\n3. Clarity matters\n4. Clarity matters',
    });
    assert.ok(profile.artificialTacticPenalty >= 20);
    assert.ok(profile.improvementOpportunities.some((item) => /artificial numbering/i.test(item)));
  });

  test('authentic personal experience can increase specificity without being required', () => {
    const base = { centralClaim: 'Removing one approval step made the handoff easier to diagnose.', mechanism: 'Ownership became visible at the decision point.' };
    const general = assessShareability(base);
    const personal = assessShareability({ ...base, personalEvidenceAvailable: true });
    assert.ok(personal.sendValue >= general.sendValue);
    assert.equal(personal.valueType, 'EXPERIENCE');
  });

  test('clickbait reduces rather than increases shareability', () => {
    const useful = assessShareability({ centralClaim: 'A useful warning reveals which decision becomes unsafe when context is missing.', mechanism: 'Missing context leads to a wrong default.' });
    const clickbait = assessShareability({ centralClaim: "The shocking secret nobody tells you will change everything before it's too late.", mechanism: 'You will not believe it.' });
    assert.ok(clickbait.artificialTacticPenalty > 0);
    assert.ok(clickbait.overallPotential < useful.overallPotential);
  });

  test('engagement-bait CTA is not counted as discussion value', () => {
    const natural = assessShareability({ centralClaim: 'The trade-off is whether speed matters more than reversibility.', audienceConsequence: 'Different teams will make a different defensible decision.' });
    const bait = assessShareability({ centralClaim: 'This is important. Agree? Comment below and tag someone. Share this with your team.' });
    assert.ok(bait.discussionValue < natural.discussionValue);
  });

  test('highly useful content can remain plain text', () => {
    const profile = assessShareability({
      centralClaim: 'I learned that the best debrief question is not what went wrong, but which assumption stayed invisible.',
      mechanism: 'The question exposes the decision context that the timeline cannot show.',
      personalEvidenceAvailable: true,
    });
    assert.equal(profile.recommendedPresentation, 'PLAIN_TEXT');
  });

  test('genuinely multi-step content may become a carousel candidate', () => {
    const profile = assessShareability({
      centralClaim: 'The review process has five distinct stages.',
      supportingText: '1. Capture the signal\n2. Verify the source\n3. Compare the options\n4. Assign the decision\n5. Record the outcome',
      ideaFamily: 'repeatable process',
    });
    assert.equal(profile.recommendedPresentation, 'CAROUSEL_CANDIDATE');
  });

  test('shareability recommends presentation but never generates media', () => {
    const profile = assessShareability({ centralClaim: 'A model connects inputs to decisions.', mechanism: 'Input A leads to choice B, which changes outcome C.' });
    assert.equal('mediaAction' in profile, false);
    assert.equal('generatedMedia' in profile, false);
  });

  test('user media preferences remain outside the shareability layer', () => {
    const profile = assessShareability({ centralClaim: 'A five-stage framework can be reused.', supportingText: '1. A\n2. B\n3. C\n4. D\n5. E' });
    assert.equal('imageMode' in profile, false);
    assert.equal('mediaBehavior' in profile, false);
  });

  test('shareability preserves authority and factual safety restrictions', () => {
    const profile = assessShareability({
      centralClaim: 'An unsupported claim could sound memorable.',
      authorityEligible: false,
      factualSafetyEligible: false,
    });
    assert.deepEqual(profile.safetyBoundary, { authorityEligible: false, factualSafetyEligible: false });
  });

  test('a compact useful post can outperform a repetitive deep post on density', () => {
    const compact = assessShareability({ centralClaim: 'A metric becomes useful when it changes a decision, not when it fills a dashboard.', mechanism: 'Decision linkage separates signal from reporting inventory.' });
    const deep = assessShareability({ centralClaim: 'Metrics are important.', supportingText: Array.from({ length: 80 }, () => 'Metrics provide useful information for better decisions.').join(' ') });
    assert.ok(compact.valueDensity > deep.valueDensity);
  });

  test('the same abstract signals work across unrelated niches', () => {
    for (const claim of [
      'A patient handoff fails when responsibility moves without the treatment context.',
      'A candidate handoff fails when responsibility moves without the interview context.',
      'A tax handoff fails when responsibility moves without the filing context.',
    ]) {
      const profile = assessShareability({ centralClaim: claim, mechanism: 'Missing context leads to the wrong next decision.' });
      assert.ok(profile.sendValue >= 45);
    }
  });

  test('no analytics means no account-specific presentation bias', () => {
    const profile = assessShareability({ centralClaim: 'A process has five stages.', supportingText: '1. A\n2. B\n3. C\n4. D\n5. E' });
    assert.equal(profile.accountPreferenceAdjustment, 0);
  });

  test('account performance can contribute only a soft presentation preference', () => {
    const now = new Date('2026-08-24T00:00:00Z');
    const observations = [
      ...Array.from({ length: 6 }, (_, index) => ({ postId: `carousel-${index}`, publishedAt: now, impressions: 2000, engagements: 180, engagementRate: 9, features: { visualType: 'CAROUSEL', structure: 'FRAMEWORK_EXPLANATION_APPLICATION' } })),
      ...Array.from({ length: 6 }, (_, index) => ({ postId: `text-${index}`, publishedAt: now, impressions: 500, engagements: 8, engagementRate: 1.6, features: { visualType: 'NONE', structure: 'COMPACT_INSIGHT' } })),
    ];
    const performanceProfile = buildAccountPerformanceProfile('user-a', observations, { now });
    const profile = assessShareability({
      centralClaim: 'A process has five distinct stages.',
      supportingText: '1. Capture\n2. Verify\n3. Compare\n4. Decide\n5. Record',
      performanceProfile,
    });
    assert.ok(profile.accountPreferenceAdjustment > 0);
    assert.ok(profile.accountPreferenceAdjustment <= 6);
  });
});
