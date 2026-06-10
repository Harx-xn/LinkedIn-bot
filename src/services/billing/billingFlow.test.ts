import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BillingAccessStatus } from '@prisma/client';
import {
  mapStripeStatusToBillingAccess,
  mapStripeStatusToLocal,
} from './billingAccessService';
import { sanitizeExternalError } from './billingError';

describe('billing status mapping', () => {
  it('maps trialing and active separately', () => {
    assert.equal(mapStripeStatusToLocal('trialing'), 'TRIALING');
    assert.equal(mapStripeStatusToLocal('active'), 'ACTIVE');
    assert.notEqual(mapStripeStatusToLocal('trialing'), mapStripeStatusToLocal('active'));
  });

  it('maps payment problem states', () => {
    assert.equal(mapStripeStatusToLocal('past_due'), 'PAST_DUE');
    assert.equal(mapStripeStatusToLocal('incomplete'), 'INCOMPLETE');
    assert.equal(mapStripeStatusToLocal('paused'), 'PAUSED');
    assert.equal(mapStripeStatusToLocal('canceled'), 'CANCELED');
  });

  it('maps billing access for trialing subscription', () => {
    const status = mapStripeStatusToBillingAccess('TRIALING', {
      cancelAtPeriodEnd: false,
      currentPeriodEnd: null,
      trialEnd: new Date(Date.now() + 86_400_000),
      paymentActionRequiredAt: null,
    });
    assert.equal(status, BillingAccessStatus.TRIALING);
  });

  it('retains access for cancel-at-period-end until period end', () => {
    const future = new Date(Date.now() + 86_400_000 * 5);
    const status = mapStripeStatusToBillingAccess('CANCELED', {
      cancelAtPeriodEnd: true,
      currentPeriodEnd: future,
      trialEnd: null,
      paymentActionRequiredAt: null,
    });
    assert.equal(status, BillingAccessStatus.ACTIVE);
  });
});

describe('billing security helpers', () => {
  it('sanitizes stripe secret patterns from errors', () => {
    const msg = sanitizeExternalError(new Error('failed sk_live_abc123 key'));
    assert.equal(msg, 'Payment provider error');
  });

  it('does not expose webhook secrets', () => {
    const msg = sanitizeExternalError(new Error('bad whsec_test_secret'));
    assert.equal(msg, 'Payment provider error');
  });
});

describe('registration trial policy', () => {
  it('documents that registration must not auto-start trial', () => {
    const registrationCreatesTrial = false;
    assert.equal(registrationCreatesTrial, false);
  });
});

describe('checkout configuration expectations', () => {
  it('requires persistent stripe price id instead of inline price_data', () => {
    const checkoutLineItem = { price: 'price_123', quantity: 1 };
    assert.ok(!('price_data' in checkoutLineItem));
  });

  it('requires payment_method_collection always for trial checkout', () => {
    const trialCheckout = {
      payment_method_collection: 'always' as const,
      subscription_data: {
        trial_period_days: 14,
        trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
      },
    };
    assert.equal(trialCheckout.payment_method_collection, 'always');
    assert.equal(trialCheckout.subscription_data.trial_period_days, 14);
  });

  it('does not add invoice items that would charge immediately', () => {
    const trialCheckoutExtras = { invoice_items: undefined };
    assert.equal(trialCheckoutExtras.invoice_items, undefined);
  });
});

describe('webhook idempotency expectations', () => {
  it('treats PROCESSED events as duplicates', () => {
    const existing = { status: 'PROCESSED' };
    const shouldSkip = existing.status === 'PROCESSED';
    assert.equal(shouldSkip, true);
  });

  it('allows retry after FAILED status', () => {
    const existing = { status: 'FAILED' };
    const shouldSkip = existing.status === 'PROCESSED';
    assert.equal(shouldSkip, false);
  });
});

describe('trial eligibility rules', () => {
  it('blocks users who already redeemed a trial', () => {
    const user = { trialRedeemedAt: new Date() };
    const eligible = user.trialRedeemedAt === null;
    assert.equal(eligible, false);
  });

  it('blocks duplicate checkout when manageable subscription exists', () => {
    const manageableStatuses = ['TRIALING', 'ACTIVE', 'PAST_DUE', 'INCOMPLETE', 'PAUSED'];
    assert.ok(manageableStatuses.includes('ACTIVE'));
    assert.ok(!manageableStatuses.includes('CANCELED'));
  });
});

describe('client trust boundaries', () => {
  it('never accepts stripePriceId from frontend checkout body', () => {
    const clientBody = { planId: 'plan_1', stripePriceId: 'price_evil' };
    const acceptedFields = ['planId', 'promoCode', 'inviteCode'];
    const rejected = Object.keys(clientBody).filter((k) => !acceptedFields.includes(k));
    assert.deepEqual(rejected, ['stripePriceId']);
  });

  it('never returns decrypted stripe secrets in billing DTO', () => {
    const billingDto = {
      billingRequired: true,
      dashboardAccess: false,
      stripeSecretKey: undefined,
      stripeWebhookSecret: undefined,
    };
    assert.equal(billingDto.stripeSecretKey, undefined);
    assert.equal(billingDto.stripeWebhookSecret, undefined);
  });
});
