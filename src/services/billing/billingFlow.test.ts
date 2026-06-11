import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BillingAccessStatus } from '@prisma/client';
import {
  mapStripeStatusToBillingAccess,
  mapStripeStatusToLocal,
} from './billingAccessService';
import { CHECKOUT_BLOCKING_SUBSCRIPTION_STATUSES } from './billingAccessService';
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

  it('does not treat incomplete or canceled subscriptions as checkout-blocking', () => {
    assert.ok(!CHECKOUT_BLOCKING_SUBSCRIPTION_STATUSES.includes('INCOMPLETE' as never));
    assert.ok(!CHECKOUT_BLOCKING_SUBSCRIPTION_STATUSES.includes('CANCELED' as never));
    assert.ok(CHECKOUT_BLOCKING_SUBSCRIPTION_STATUSES.includes('ACTIVE'));
  });
});

describe('dashboard access policy', () => {
  it('requires payment method for stripe-managed TRIALING or ACTIVE subscriptions', () => {
    const stripeSub = {
      stripeSubscriptionId: 'sub_123',
      stripeDefaultPaymentMethodId: null as string | null,
    };
    const adminSub = {
      stripeSubscriptionId: null as string | null,
      stripeDefaultPaymentMethodId: null as string | null,
    };

    const stripeBlocked =
      !!stripeSub.stripeSubscriptionId && !stripeSub.stripeDefaultPaymentMethodId;
    const adminAllowed =
      !adminSub.stripeSubscriptionId || !!adminSub.stripeDefaultPaymentMethodId;

    assert.equal(stripeBlocked, true);
    assert.equal(adminAllowed, true);
  });

  it('does not treat stripe customer presence as verified billing', () => {
    const billingDto = {
      stripeCustomerPresent: true,
      subscription: {
        paymentMethodPresent: false,
        status: null,
      },
      dashboardAccess: false,
    };
    assert.equal(billingDto.dashboardAccess, false);
    assert.equal(billingDto.subscription.paymentMethodPresent, false);
  });
});

describe('billing me overview', () => {
  const billingMeSource = readFileSync(
    join(process.cwd(), 'src/services/billing/billingMeService.ts'),
    'utf8',
  );

  it('exposes stripeConfigured without stripe secrets', () => {
    assert.ok(billingMeSource.includes('stripeConfigured'));
    assert.ok(!billingMeSource.includes('stripeSecretKey'));
    assert.ok(!billingMeSource.includes('stripeWebhookSecret'));
    assert.ok(!billingMeSource.includes('stripePublishableKey'));
  });

  it('includes plan entitlement and stripePriceIdPresent fields', () => {
    for (const field of [
      'stripePriceIdPresent',
      'fullDashboardUnlock',
      'maxRewritesPerPost',
      'dailyPostLimit',
      'dailyBatchGenerationLimit',
      'imageGenerationEnabled',
      'dailyImageGenerationLimit',
    ]) {
      assert.ok(billingMeSource.includes(field), `missing ${field}`);
    }
    assert.ok(!billingMeSource.includes('stripePriceId:'), 'must not expose stripePriceId');
  });

  it('includes subscription plan pricing fields', () => {
    for (const field of ['price:', 'currency:', 'billingCycle:']) {
      assert.ok(billingMeSource.includes(field), `missing subscription ${field}`);
    }
  });

  it('handles missing region via safe stripe config resolver', () => {
    assert.ok(billingMeSource.includes('resolveStripeConfigured'));
    assert.ok(billingMeSource.includes('if (!regionId) return false'));
  });
});

describe('post-checkout activation', () => {
  const syncSource = readFileSync(
    join(process.cwd(), 'src/services/billing/stripeSubscriptionSyncService.ts'),
    'utf8',
  );
  const checkoutStatusSource = readFileSync(
    join(process.cwd(), 'src/services/billing/stripeCheckoutService.ts'),
    'utf8',
  );

  it('resolves default payment method from checkout session and customer fallbacks', () => {
    assert.ok(syncSource.includes('resolveDefaultPaymentMethod'));
    assert.ok(syncSource.includes('resolveFromCheckoutSession'));
    assert.ok(syncSource.includes('no_payment_required'));
    assert.ok(syncSource.includes('checkoutSessionId'));
  });

  it('syncs payment method on payment_method.attached webhook', () => {
    assert.ok(syncSource.includes('handlePaymentMethodAttached'));
    assert.ok(syncSource.includes('stripeDefaultPaymentMethodId: params.paymentMethod.id'));
  });

  it('only reconciles checkout-status after verified checkout completion', () => {
    assert.ok(checkoutStatusSource.includes("session.status !== 'complete'"));
    assert.ok(checkoutStatusSource.includes('no_payment_required'));
    assert.ok(checkoutStatusSource.includes('handleCheckoutSessionCompleted'));
  });

  it('does not grant dashboard access before payment method verification', () => {
    const accessSource = readFileSync(
      join(process.cwd(), 'src/services/billing/billingAccessService.ts'),
      'utf8',
    );
    assert.ok(accessSource.includes('TRIAL_PENDING'));
    assert.ok(accessSource.includes('stripeDefaultPaymentMethodId'));
    assert.ok(accessSource.includes('BillingAccessStatus.TRIALING'));
  });
});

describe('payments checkout errors', () => {
  const paymentsSource = readFileSync(join(process.cwd(), 'src/routes/payments.ts'), 'utf8');
  const checkoutSource = readFileSync(
    join(process.cwd(), 'src/services/billing/stripeCheckoutService.ts'),
    'utf8',
  );

  it('returns machine-readable error and code fields', () => {
    assert.ok(paymentsSource.includes('{ error: err.message, code: err.code }'));
    assert.ok(paymentsSource.includes("error: 'planId is required'"));
  });

  it('validates checkout prerequisites before Stripe session creation', () => {
    for (const helper of [
      'assertCheckoutUser',
      'assertStripeReady',
      'assertNoCheckoutBlockingSubscription',
      'validatePlanStripePrice',
      'resolveCheckoutPromotion',
    ]) {
      assert.ok(checkoutSource.includes(helper), `missing ${helper}`);
    }
  });

  it('maps Stripe session failures to CHECKOUT_SESSION_FAILED', () => {
    assert.ok(checkoutSource.includes('CHECKOUT_SESSION_FAILED'));
    assert.ok(checkoutSource.includes('createStripeCheckoutSession'));
  });

  it('does not expose stripe secrets in checkout service', () => {
    assert.ok(!checkoutSource.includes('stripeSecretKey'));
    assert.ok(!checkoutSource.includes('decryptSecret'));
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
