import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveSafepayCheckoutPlanId } from './safepayPlanService';

describe('Safepay one-time trial plan selection', () => {
  const mapping = { providerPlanId: 'plan_with_trial', providerPaidPlanId: 'plan_without_trial' };

  it('uses the trial-enabled plan only for eligible trial checkout', () => {
    assert.equal(resolveSafepayCheckoutPlanId(mapping, 'trial'), 'plan_with_trial');
  });

  it('uses a separate zero-trial plan for paid checkout', () => {
    assert.equal(resolveSafepayCheckoutPlanId(mapping, 'paid'), 'plan_without_trial');
  });

  it('never falls back to the trial plan when paid mapping is missing', () => {
    assert.equal(resolveSafepayCheckoutPlanId({ ...mapping, providerPaidPlanId: null }, 'paid'), null);
  });

  it('documents that paid checkout must not accept provider trial activation', () => {
    const syncSource = require('node:fs').readFileSync(
      require('node:path').join(process.cwd(), 'src/services/billing/providers/safepay/safepaySubscriptionSyncService.ts'),
      'utf8',
    );
    assert.match(syncSource, /existing\.checkoutMode === 'PAID' && mappedStatus === 'TRIALING'/);
  });
});
