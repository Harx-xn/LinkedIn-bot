import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAccountPerformanceProfile,
  emptyAccountPerformanceProfile,
  loadAccountPerformanceProfileSafe,
  scoreCandidateAgainstPerformance,
  type AccountPerformanceObservation,
} from './accountPerformanceLearningService';

const NOW = new Date('2026-08-24T00:00:00.000Z');

function observation(
  id: string,
  territory: string,
  impressions: number | undefined,
  engagements: number | undefined,
  ageDays = 10,
): AccountPerformanceObservation {
  return {
    postId: id,
    publishedAt: new Date(NOW.getTime() - ageDays * 86_400_000),
    impressions,
    engagements,
    ...(impressions != null && impressions > 0 && engagements != null
      ? { engagementRate: engagements / impressions * 100 }
      : {}),
    features: {
      territory,
      pillar: territory === 'automation' ? 'operations' : 'leadership',
      ideaFamily: territory === 'automation' ? 'observation' : 'tutorial',
      hookFamily: territory === 'automation' ? 'OBSERVATION' : 'QUESTION',
      structure: territory === 'automation' ? 'OBSERVATION_MECHANISM_CONSEQUENCE' : 'FRAMEWORK_EXPLANATION_APPLICATION',
      endingType: 'NO_CTA',
      visualType: 'NONE',
      authorityMode: 'EXPERT',
    },
  };
}

function repeatedProfile() {
  return buildAccountPerformanceProfile('account-a', [
    ...Array.from({ length: 6 }, (_, index) => observation(`high-${index}`, 'automation', 2000, 180, index * 7)),
    ...Array.from({ length: 6 }, (_, index) => observation(`low-${index}`, 'leadership', 500, 8, index * 7)),
  ], { now: NOW, importCount: 2 });
}

test('no analytics leaves generation scoring unchanged', () => {
  assert.equal(scoreCandidateAgainstPerformance(emptyAccountPerformanceProfile('u'), { territory: 'new' }).adjustment, 0);
});

test('one high-performing post is only a very weak signal and cannot dominate', () => {
  const profile = buildAccountPerformanceProfile('u', [observation('one', 'automation', 10_000, 900)], { now: NOW });
  const preference = profile.preferences.find((item) => item.dimension === 'territory');
  assert.ok(!preference || preference.strength === 'VERY_WEAK' || Math.abs(preference.scoreAdjustment) < 2.5);
});

test('repeated above-baseline evidence creates a stronger soft preference', () => {
  const profile = repeatedProfile();
  const preference = profile.preferences.find((item) => item.dimension === 'territory' && item.value === 'AUTOMATION');
  assert.ok(preference);
  assert.ok(preference.sampleSize >= 6);
  assert.ok(preference.confidence > .5);
  assert.ok(preference.scoreAdjustment > 0);
});

test('poor-performing pattern receives a bounded penalty rather than a ban', () => {
  const adjustment = scoreCandidateAgainstPerformance(repeatedProfile(), { territory: 'leadership' }).adjustment;
  assert.ok(adjustment < 0);
  assert.ok(adjustment >= -6);
});

test('explicit user strategy overrides learned preference', () => {
  const scored = scoreCandidateAgainstPerformance(repeatedProfile(), { territory: 'leadership' }, { explicitUserChoice: true });
  assert.equal(scored.adjustment, 0);
  assert.deepEqual(scored.reasons, ['explicit_user_strategy_override']);
});

test('unseen territories retain an exploration bonus', () => {
  const scored = scoreCandidateAgainstPerformance(repeatedProfile(), { territory: 'patient_education' });
  assert.ok(scored.explorationAdjustment > 0);
  assert.ok(scored.adjustment > 0);
});

test('missing metrics are never invented', () => {
  const profile = buildAccountPerformanceProfile('u', [observation('missing', 'automation', undefined, undefined)], { now: NOW });
  assert.deepEqual(profile.availableMetrics, []);
  assert.equal(profile.preferences.length, 0);
  assert.deepEqual(profile.unavailableMetrics, ['PROFILE_OUTCOMES', 'ATTRIBUTABLE_FOLLOWER_CHANGE']);
});

test('performance signals remain account-specific', () => {
  const accountA = repeatedProfile();
  const accountB = buildAccountPerformanceProfile('account-b', [
    ...Array.from({ length: 6 }, (_, index) => observation(`a-low-${index}`, 'automation', 500, 8, index * 7)),
    ...Array.from({ length: 6 }, (_, index) => observation(`l-high-${index}`, 'leadership', 2000, 180, index * 7)),
  ], { now: NOW });
  assert.ok(scoreCandidateAgainstPerformance(accountA, { territory: 'automation' }).adjustment > 0);
  assert.ok(scoreCandidateAgainstPerformance(accountB, { territory: 'automation' }).adjustment < 0);
});

test('old evidence decays relative to equally repeated recent evidence', () => {
  const recent = repeatedProfile();
  const old = buildAccountPerformanceProfile('u', [
    ...Array.from({ length: 6 }, (_, index) => observation(`old-high-${index}`, 'automation', 2000, 180, 600 + index * 30)),
    ...Array.from({ length: 6 }, (_, index) => observation(`base-${index}`, 'leadership', 500, 8, index * 7)),
  ], { now: NOW });
  const recentPreference = recent.preferences.find((item) => item.dimension === 'territory' && item.value === 'AUTOMATION')!;
  const oldPreference = old.preferences.find((item) => item.dimension === 'territory' && item.value === 'AUTOMATION')!;
  assert.ok(oldPreference.effectiveSampleSize < recentPreference.effectiveSampleSize);
  assert.ok(oldPreference.confidence < recentPreference.confidence);
});

test('analytics import failure returns neutral learning and never blocks generation', async () => {
  const profile = await loadAccountPerformanceProfileSafe('u', async () => { throw new Error('import unavailable'); });
  assert.equal(profile.postCount, 0);
  assert.equal(scoreCandidateAgainstPerformance(profile, { territory: 'anything' }).adjustment, 0);
});
