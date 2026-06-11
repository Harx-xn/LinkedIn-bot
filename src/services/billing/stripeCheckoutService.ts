import { BillingAccessStatus } from '@prisma/client';
import { prisma } from '../../prismaClient';
import { config } from '../../config';
import { validatePromotionCode } from '../promotionService';
import { findValidInvite } from '../inviteService';
import { getBooleanSetting } from '../settingsService';
import { BillingError, sanitizeExternalError } from './billingError';
import {
  getOrCreateStripeCustomerId,
  hasBlockingSubscription,
  isTrialEligible,
  resolveTrialDays,
  setUserBillingAccess,
} from './billingAccessService';
import { assertFrontendUrl, getRegionalStripeClient, isStripeConfigured } from './stripeClientService';
import { validatePlanStripePrice } from './stripePlanService';
import type { StripeCheckoutSessionLike, StripeSubscriptionFull } from './stripeTypes';

export interface CheckoutInput {
  userId: string;
  planId: string;
  promoCode?: string;
  inviteCode?: string;
  mode: 'trial' | 'paid';
}

function buildCheckoutMetadata(params: {
  userId: string;
  regionId: string;
  planId: string;
  promo?: { id: string; code: string } | null;
  inviteCode?: string;
  checkoutKind: 'trial' | 'paid';
}) {
  return {
    userId: params.userId,
    regionId: params.regionId,
    planId: params.planId,
    promoCode: params.promo?.code ?? '',
    promotionId: params.promo?.id ?? '',
    inviteCode: params.inviteCode ?? '',
    checkoutKind: params.checkoutKind,
  };
}

async function assertCheckoutUser(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, regionId: true, billingAccessStatus: true },
  });

  if (!user) {
    throw new BillingError(404, 'BILLING_NOT_AVAILABLE', 'Account not found');
  }
  if (!user.email) {
    throw new BillingError(400, 'BILLING_NOT_AVAILABLE', 'Account email is required for billing');
  }
  if (!user.regionId) {
    throw new BillingError(400, 'USER_REGION_MISSING', 'Your account is not assigned to a billing region');
  }

  return user as typeof user & { email: string; regionId: string };
}

async function assertStripeReady(regionId: string) {
  const configured = await isStripeConfigured(regionId);
  if (!configured) {
    throw new BillingError(
      400,
      'STRIPE_NOT_CONFIGURED',
      'Stripe is not configured for this region yet.',
    );
  }
}

async function assertNoCheckoutBlockingSubscription(userId: string) {
  if (await hasBlockingSubscription(userId)) {
    throw new BillingError(
      409,
      'SUBSCRIPTION_ALREADY_EXISTS',
      'You already have an active subscription. Use plan change or the billing portal to manage it.',
    );
  }
}

async function resolveCheckoutPromotion(params: {
  promoCode?: string;
  inviteCode?: string;
  regionId: string;
  requireStripePromotionCode: boolean;
}) {
  const promoCodesEnabled = await getBooleanSetting(
    'billing.promoCodesEnabled',
    params.regionId,
    true,
  );

  if (!promoCodesEnabled) {
    if (params.promoCode?.trim()) {
      throw new BillingError(400, 'PROMO_INVALID', 'Promotion codes are not enabled for your region');
    }
    return null;
  }

  if (params.promoCode?.trim()) {
    return validatePromotionCode(params.promoCode, {
      regionId: params.regionId,
      requireStripePromotionCode: params.requireStripePromotionCode,
    });
  }

  if (params.inviteCode?.trim()) {
    const invite = await findValidInvite(params.inviteCode);
    if (invite?.promoCode) {
      return validatePromotionCode(invite.promoCode, {
        regionId: params.regionId,
        requireStripePromotionCode: params.requireStripePromotionCode,
      });
    }
  }

  return null;
}

async function createStripeCheckoutSession(
  stripe: Awaited<ReturnType<typeof getRegionalStripeClient>>,
  params: Parameters<typeof stripe.checkout.sessions.create>[0],
  idempotencyKey: string,
) {
  try {
    return await stripe.checkout.sessions.create(params, { idempotencyKey });
  } catch (err) {
    console.error('[checkout]', sanitizeExternalError(err));
    throw new BillingError(
      502,
      'CHECKOUT_SESSION_FAILED',
      'Could not start checkout. Please try again.',
    );
  }
}

export async function createTrialCheckoutSession(input: CheckoutInput) {
  if (input.mode !== 'trial') {
    throw new BillingError(400, 'CHECKOUT_FAILED', 'Invalid checkout mode');
  }

  const user = await assertCheckoutUser(input.userId);
  await assertStripeReady(user.regionId);

  const eligible = await isTrialEligible(input.userId);
  if (!eligible) {
    throw new BillingError(403, 'TRIAL_ALREADY_USED', 'You are not eligible for a free trial');
  }

  await assertNoCheckoutBlockingSubscription(input.userId);

  const stripe = await getRegionalStripeClient(user.regionId);
  const { plan } = await validatePlanStripePrice(input.planId, user.regionId, stripe);

  const promo = await resolveCheckoutPromotion({
    promoCode: input.promoCode,
    inviteCode: input.inviteCode,
    regionId: user.regionId,
    requireStripePromotionCode: false,
  });

  const extraTrialDays =
    promo?.type === 'INTERNAL_TRIAL' ? promo.extraTrialDays ?? 0 : 0;
  const trialDays = await resolveTrialDays(user.regionId, extraTrialDays);

  const stripeCustomerId = await getOrCreateStripeCustomerId({
    userId: user.id,
    email: user.email,
    regionId: user.regionId,
    stripe,
  });

  const metadata = buildCheckoutMetadata({
    userId: user.id,
    regionId: user.regionId,
    planId: plan.id,
    promo: promo ? { id: promo.id, code: promo.code } : null,
    inviteCode: input.inviteCode,
    checkoutKind: 'trial',
  });

  const successUrl = `${config.frontendUrl}/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${config.frontendUrl}/billing?checkout=cancelled`;
  assertFrontendUrl(successUrl, config.frontendUrl);
  assertFrontendUrl(cancelUrl, config.frontendUrl);

  const idempotencyKey = `trial-checkout:${user.id}:${plan.id}:${trialDays}`;
  const promoCodesEnabled = await getBooleanSetting('billing.promoCodesEnabled', user.regionId, true);

  const session = await createStripeCheckoutSession(
    stripe,
    {
      mode: 'subscription',
      customer: stripeCustomerId,
      payment_method_collection: 'always',
      line_items: [{ price: plan.stripePriceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: trialDays,
        trial_settings: {
          end_behavior: { missing_payment_method: 'cancel' },
        },
        metadata,
      },
      metadata,
      discounts:
        promo?.type === 'STRIPE_PROMO' && promo.stripePromotionCodeId
          ? [{ promotion_code: promo.stripePromotionCodeId }]
          : undefined,
      allow_promotion_codes:
        promo?.type === 'STRIPE_PROMO' && promo.stripePromotionCodeId
          ? undefined
          : promoCodesEnabled,
      success_url: successUrl,
      cancel_url: cancelUrl,
    },
    idempotencyKey,
  );

  await setUserBillingAccess(user.id, BillingAccessStatus.TRIAL_PENDING);

  return { url: session.url, sessionId: session.id };
}

export async function createPaidCheckoutSession(input: CheckoutInput) {
  const user = await assertCheckoutUser(input.userId);
  await assertStripeReady(user.regionId);
  await assertNoCheckoutBlockingSubscription(input.userId);

  const stripe = await getRegionalStripeClient(user.regionId);
  const { plan } = await validatePlanStripePrice(input.planId, user.regionId, stripe);

  const promo = await resolveCheckoutPromotion({
    promoCode: input.promoCode,
    inviteCode: input.inviteCode,
    regionId: user.regionId,
    requireStripePromotionCode: true,
  });

  const stripeCustomerId = await getOrCreateStripeCustomerId({
    userId: user.id,
    email: user.email,
    regionId: user.regionId,
    stripe,
  });

  const metadata = buildCheckoutMetadata({
    userId: user.id,
    regionId: user.regionId,
    planId: plan.id,
    promo: promo ? { id: promo.id, code: promo.code } : null,
    inviteCode: input.inviteCode,
    checkoutKind: 'paid',
  });

  const successUrl = `${config.frontendUrl}/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${config.frontendUrl}/billing?checkout=cancelled`;
  assertFrontendUrl(successUrl, config.frontendUrl);
  assertFrontendUrl(cancelUrl, config.frontendUrl);

  const idempotencyKey = `paid-checkout:${user.id}:${plan.id}`;
  const promoCodesEnabled = await getBooleanSetting('billing.promoCodesEnabled', user.regionId, true);

  const session = await createStripeCheckoutSession(
    stripe,
    {
      mode: 'subscription',
      customer: stripeCustomerId,
      payment_method_collection: 'always',
      line_items: [{ price: plan.stripePriceId, quantity: 1 }],
      subscription_data: { metadata },
      metadata,
      discounts: promo?.stripePromotionCodeId
        ? [{ promotion_code: promo.stripePromotionCodeId }]
        : undefined,
      allow_promotion_codes: promo ? undefined : promoCodesEnabled,
      success_url: successUrl,
      cancel_url: cancelUrl,
    },
    idempotencyKey,
  );

  return { url: session.url, sessionId: session.id };
}

export async function getCheckoutStatus(params: {
  userId: string;
  sessionId: string;
}) {
  const user = await prisma.user.findUnique({
    where: { id: params.userId },
    select: { regionId: true },
  });
  if (!user) {
    throw new BillingError(404, 'BILLING_NOT_AVAILABLE', 'Account not found');
  }
  if (!user.regionId) {
    throw new BillingError(400, 'USER_REGION_MISSING', 'Your account is not assigned to a billing region');
  }

  const stripe = await getRegionalStripeClient(user.regionId);
  const session = (await stripe.checkout.sessions.retrieve(params.sessionId, {
    expand: ['subscription.default_payment_method'],
  })) as StripeCheckoutSessionLike;

  const meta = session.metadata ?? {};
  if (meta.userId !== params.userId || meta.regionId !== user.regionId) {
    throw new BillingError(403, 'REGION_MISMATCH', 'Checkout session does not belong to this user');
  }

  if (session.status === 'expired') {
    return { status: 'FAILED' as const, subscriptionStatus: null };
  }

  if (session.status !== 'complete') {
    return { status: 'PROCESSING' as const, subscriptionStatus: null };
  }

  const verifiedPayment =
    session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
  if (!verifiedPayment) {
    return { status: 'INCOMPLETE' as const, subscriptionStatus: 'INCOMPLETE' };
  }

  const subscriptionId =
    typeof session.subscription === 'string'
      ? session.subscription
      : session.subscription?.id;

  if (!subscriptionId) {
    return { status: 'PROCESSING' as const, subscriptionStatus: null };
  }

  const { handleCheckoutSessionCompleted } = await import('./stripeSubscriptionSyncService');
  try {
    await handleCheckoutSessionCompleted({
      stripe,
      session,
      expectedRegionId: user.regionId,
    });
  } catch (err) {
    console.error('[checkout-status]', sanitizeExternalError(err));
  }

  const stripeSub = (await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ['default_payment_method'],
  })) as StripeSubscriptionFull;

  const subStatus = stripeSub.status;
  if (subStatus === 'trialing') return { status: 'TRIALING' as const, subscriptionStatus: 'TRIALING' };
  if (subStatus === 'active') return { status: 'ACTIVE' as const, subscriptionStatus: 'ACTIVE' };
  if (subStatus === 'incomplete' || subStatus === 'incomplete_expired') {
    return { status: 'INCOMPLETE' as const, subscriptionStatus: 'INCOMPLETE' };
  }

  return { status: 'PROCESSING' as const, subscriptionStatus: null };
}
