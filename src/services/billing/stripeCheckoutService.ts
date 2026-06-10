import { BillingAccessStatus } from '@prisma/client';
import { prisma } from '../../prismaClient';
import { config } from '../../config';
import { findValidPromotion } from '../promotionService';
import { findValidInvite } from '../inviteService';
import { getBooleanSetting } from '../settingsService';
import { BillingError } from './billingError';
import {
  getOrCreateStripeCustomerId,
  hasBlockingSubscription,
  isTrialEligible,
  resolveTrialDays,
  setUserBillingAccess,
} from './billingAccessService';
import { assertFrontendUrl, getRegionalStripeClient } from './stripeClientService';
import { validatePlanStripePrice } from './stripePlanService';

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

export async function createTrialCheckoutSession(input: CheckoutInput) {
  if (input.mode !== 'trial') {
    throw new BillingError(400, 'CHECKOUT_FAILED', 'Invalid checkout mode');
  }

  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { id: true, email: true, regionId: true, billingAccessStatus: true },
  });

  if (!user?.regionId || !user.email) {
    throw new BillingError(404, 'PLAN_NOT_FOUND', 'User or region not found');
  }

  const eligible = await isTrialEligible(input.userId);
  if (!eligible) {
    throw new BillingError(403, 'TRIAL_ALREADY_USED', 'You are not eligible for a free trial');
  }

  if (await hasBlockingSubscription(input.userId)) {
    throw new BillingError(409, 'SUBSCRIPTION_ALREADY_EXISTS', 'You already have a subscription');
  }

  const stripe = await getRegionalStripeClient(user.regionId);
  const { plan } = await validatePlanStripePrice(input.planId, user.regionId, stripe);

  const promoCodesEnabled = await getBooleanSetting('billing.promoCodesEnabled', user.regionId, true);
  let promo = promoCodesEnabled
    ? await findValidPromotion(input.promoCode, {
        regionId: user.regionId,
        requireStripePromotionCode: false,
      })
    : null;

  if (input.inviteCode && !promo) {
    const invite = await findValidInvite(input.inviteCode);
    if (invite?.promoCode) {
      promo = await findValidPromotion(invite.promoCode, { regionId: user.regionId });
    }
  }

  if (input.promoCode && promoCodesEnabled && !promo) {
    throw new BillingError(400, 'PROMO_INVALID', 'Promotion code is not valid');
  }

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

  const session = await stripe.checkout.sessions.create(
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
    { idempotencyKey },
  );

  await setUserBillingAccess(user.id, BillingAccessStatus.TRIAL_PENDING);

  return { url: session.url, sessionId: session.id };
}

export async function createPaidCheckoutSession(input: CheckoutInput) {
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { id: true, email: true, regionId: true },
  });

  if (!user?.regionId || !user.email) {
    throw new BillingError(404, 'PLAN_NOT_FOUND', 'User or region not found');
  }

  if (await hasBlockingSubscription(input.userId)) {
    throw new BillingError(
      409,
      'SUBSCRIPTION_ALREADY_EXISTS',
      'Use plan change or the billing portal to manage your existing subscription',
    );
  }

  const stripe = await getRegionalStripeClient(user.regionId);
  const { plan } = await validatePlanStripePrice(input.planId, user.regionId, stripe);

  const promoCodesEnabled = await getBooleanSetting('billing.promoCodesEnabled', user.regionId, true);
  const promo = promoCodesEnabled
    ? await findValidPromotion(input.promoCode, {
        regionId: user.regionId,
        requireStripePromotionCode: true,
      })
    : null;

  if (input.promoCode && promoCodesEnabled && !promo) {
    throw new BillingError(400, 'PROMO_INVALID', 'Promotion code is not valid');
  }

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

  const session = await stripe.checkout.sessions.create(
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
    { idempotencyKey },
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
  if (!user?.regionId) {
    throw new BillingError(404, 'PLAN_NOT_FOUND', 'User not found');
  }

  const stripe = await getRegionalStripeClient(user.regionId);
  const session = await stripe.checkout.sessions.retrieve(params.sessionId, {
    expand: ['subscription'],
  });

  const meta = session.metadata ?? {};
  if (meta.userId !== params.userId || meta.regionId !== user.regionId) {
    throw new BillingError(403, 'REGION_MISMATCH', 'Checkout session does not belong to this user');
  }

  if (session.payment_status === 'unpaid' && session.status === 'expired') {
    return { status: 'FAILED' as const, subscriptionStatus: null };
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
  } catch {
    // Reconciliation is best-effort; webhook remains authoritative.
  }

  const stripeSub =
    typeof session.subscription === 'object' && session.subscription
      ? session.subscription
      : await stripe.subscriptions.retrieve(subscriptionId);

  const subStatus = stripeSub.status;
  if (subStatus === 'trialing') return { status: 'TRIALING' as const, subscriptionStatus: 'TRIALING' };
  if (subStatus === 'active') return { status: 'ACTIVE' as const, subscriptionStatus: 'ACTIVE' };
  if (subStatus === 'incomplete' || subStatus === 'incomplete_expired') {
    return { status: 'INCOMPLETE' as const, subscriptionStatus: 'INCOMPLETE' };
  }

  return { status: 'PROCESSING' as const, subscriptionStatus: null };
}
