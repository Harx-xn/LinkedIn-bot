import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateManualStripePriceId, formatSubAdminPlanResponse } from './stripePlanService';

describe('sub-admin plan Stripe sync', () => {
  const subadminSource = readFileSync(join(process.cwd(), 'src/routes/subadmin.ts'), 'utf8');
  const planServiceSource = readFileSync(
    join(process.cwd(), 'src/services/billing/stripePlanService.ts'),
    'utf8',
  );
  const checkoutSource = readFileSync(
    join(process.cwd(), 'src/services/billing/stripeCheckoutService.ts'),
    'utf8',
  );
  const billingMeSource = readFileSync(
    join(process.cwd(), 'src/services/billing/billingMeService.ts'),
    'utf8',
  );

  it('saves manual stripePriceId when it starts with price_', () => {
    assert.equal(validateManualStripePriceId(' price_123 '), 'price_123');
    assert.throws(() => validateManualStripePriceId('prod_123'), /price_/);
  });

  it('creates plan with syncStripe and returns stripePriceIdPresent', () => {
    assert.ok(subadminSource.includes('syncStripe === true'));
    assert.ok(subadminSource.includes('syncPlanToStripe'));
    assert.ok(subadminSource.includes('formatSubAdminPlanResponse'));
    const formatted = formatSubAdminPlanResponse({ id: 'p1', stripePriceId: 'price_abc' });
    assert.equal(formatted.stripePriceIdPresent, true);
    assert.equal(formatted.stripePriceId, 'price_abc');
  });

  it('returns STRIPE_PLAN_SYNC_FAILED when Stripe sync fails', () => {
    assert.ok(subadminSource.includes('STRIPE_PLAN_SYNC_FAILED'));
    assert.ok(subadminSource.includes('Could not sync plan to Stripe. Check payment settings.'));
  });

  it('patch with syncStripe updates stripePriceId via syncPlanToStripe', () => {
    assert.ok(subadminSource.includes('previousStripePriceId: existing.stripePriceId'));
    assert.ok(planServiceSource.includes('planHasActiveStripeSubscriptions'));
  });

  it('trial checkout without stripePriceId returns PLAN_NOT_CONFIGURED_IN_STRIPE', () => {
    assert.ok(planServiceSource.includes('PLAN_NOT_CONFIGURED_IN_STRIPE'));
    assert.ok(
      planServiceSource.includes('This plan is not configured for Stripe billing yet.'),
    );
    assert.ok(checkoutSource.includes('validatePlanStripePrice'));
  });

  it('checkout returns STRIPE_NOT_CONFIGURED when region billing is missing', () => {
    assert.ok(checkoutSource.includes('STRIPE_NOT_CONFIGURED'));
    assert.ok(checkoutSource.includes('Stripe is not configured for this region yet.'));
  });

  it('billing me exposes stripePriceIdPresent on available plans', () => {
    assert.ok(billingMeSource.includes('stripePriceIdPresent'));
    const missing = formatSubAdminPlanResponse({ id: 'p2', stripePriceId: null });
    const present = formatSubAdminPlanResponse({ id: 'p3', stripePriceId: 'price_xyz' });
    assert.equal(missing.stripePriceIdPresent, false);
    assert.equal(present.stripePriceIdPresent, true);
  });

  it('syncPlanToStripe uses regional Stripe client', () => {
    assert.ok(planServiceSource.includes('getRegionalStripeClient(params.regionId)'));
    assert.ok(!planServiceSource.includes('sk_live_'));
    assert.ok(!planServiceSource.includes('decryptSecret'));
  });
});
