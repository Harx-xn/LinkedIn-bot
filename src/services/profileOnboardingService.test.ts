import assert from 'node:assert/strict';
import test from 'node:test';
import { ProfileOnboardingError, validateProfileOnboarding } from './profileOnboardingService';

const valid = { description: 'I help SaaS companies ship reliable software products.', goals: ['Build authority'], customGoal: '', targetAudience: ['SaaS founders', 'Product teams'], niches: ['SaaS Development'] };

test('valid onboarding input is trimmed and accepted', () => {
  const result = validateProfileOnboarding({ ...valid, description: `  ${valid.description}  ` });
  assert.equal(result.description, valid.description);
});

test('more than three niches is rejected', () => {
  assert.throws(() => validateProfileOnboarding({ ...valid, niches: ['A', 'B', 'C', 'D'] }), (error: unknown) => error instanceof ProfileOnboardingError && error.fields.niches.includes('maximum'));
});

test('duplicate niches are rejected case-insensitively', () => {
  assert.throws(() => validateProfileOnboarding({ ...valid, niches: ['SaaS', 'saas'] }), (error: unknown) => error instanceof ProfileOnboardingError && error.fields.niches.includes('duplicate'));
});

test('audiences remain separate and are limited to three', () => {
  const result = validateProfileOnboarding(valid);
  assert.deepEqual(result.targetAudience, ['SaaS founders', 'Product teams']);
  assert.throws(
    () => validateProfileOnboarding({ ...valid, targetAudience: ['One', 'Two', 'Three', 'Four'] }),
    (error: unknown) => error instanceof ProfileOnboardingError && error.fields.targetAudience.includes('maximum'),
  );
});

test('legacy comma-separated audiences are normalized separately', () => {
  const result = validateProfileOnboarding({ ...valid, targetAudience: 'SaaS founders, Product teams, Startup leaders' });
  assert.deepEqual(result.targetAudience, ['SaaS founders', 'Product teams', 'Startup leaders']);
});

for (const [name, patch, field] of [
  ['description', { description: 'I create porn content for software businesses.' }, 'description'],
  ['audience', { targetAudience: ['porn creators and agencies'] }, 'targetAudience'],
  ['custom goal', { customGoal: 'Promote porn', goals: [] }, 'goals'],
  ['niche', { niches: ['porn'] }, 'niches'],
] as const) {
  test(`unsafe ${name} is rejected`, () => {
    assert.throws(() => validateProfileOnboarding({ ...valid, ...patch }), (error: unknown) => error instanceof ProfileOnboardingError && error.status === 422 && Boolean(error.fields[field]));
  });
}
