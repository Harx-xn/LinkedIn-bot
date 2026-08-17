import { BillingAccessStatus } from '@prisma/client';
import { prisma } from '../../prismaClient';
import { recordPromotionRedemption } from '../promotionService';
import { resolveStripePlanItem } from '../subscriptionAdminService';
import {
  mapStripeStatusToBillingAccess,
  mapStripeStatusToLocal,
  setUserBillingAccess,
} from './billingAccessService';
import { resolvePlanByStripePriceId } from './stripePlanService';
import {
  notifyCancellationScheduled,
  notifyPaymentActionRequired,
  notifyPaymentFailed,
  notifyPaymentMethodUpdated,
  notifyPlanUpgrade,
  notifyReactivated,
  notifySubscriptionActivated,
  notifySubscriptionCanceled,
  notifyTrialActivated,
  notifyTrialEndingSoon,
} from './billingNotificationService';
import type { StripeClient } from './stripeClientService';
import type {
  StripeCheckoutSessionLike,
  StripeInvoiceLike,
  StripePaymentMethodLike,
  StripeSubscriptionFull,
} from './stripeTypes';

export interface SyncSubscriptionParams {
  stripe: StripeClient;
  stripeSubscription: StripeSubscriptionFull;
  expectedRegionId: string;
  checkoutSessionId?: string | null;
  sourceEvent?: {
    id: string;
    type: string;
    created?: number;
  };
}

function stripeTs(seconds: number | null | undefined): Date | null {
  if (!seconds) return null;
  return new Date(seconds * 1000);
}

function safeMetadata(meta: Record<string, string> | null | undefined) {
  return meta ?? {};
}

function paymentMethodId(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id ?? null;
}

function customerIdFrom(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id ?? null;
}

function invoiceIdFrom(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id ?? null;
}

const CHECKOUT_VERIFIED_PAYMENT_STATUSES = new Set(['paid', 'no_payment_required']);

async function resolveFromCheckoutSession(
  stripe: StripeClient,
  sessionId: string,
): Promise<string | null> {
  const session = (await stripe.checkout.sessions.retrieve(sessionId, {
    expand: [
      'setup_intent.payment_method',
      'payment_intent.payment_method',
      'subscription.default_payment_method',
    ],
  })) as StripeCheckoutSessionLike;

  if (session.status !== 'complete') return null;
  if (!CHECKOUT_VERIFIED_PAYMENT_STATUSES.has(session.payment_status ?? '')) return null;

  const fromSetup = paymentMethodId(
    typeof session.setup_intent === 'object' ? session.setup_intent?.payment_method : null,
  );
  if (fromSetup) return fromSetup;

  const fromPaymentIntent = paymentMethodId(
    typeof session.payment_intent === 'object' ? session.payment_intent?.payment_method : null,
  );
  if (fromPaymentIntent) return fromPaymentIntent;

  if (typeof session.subscription === 'object' && session.subscription) {
    const fromSub = paymentMethodId(session.subscription.default_payment_method);
    if (fromSub) return fromSub;
  }

  const customerId = customerIdFrom(session.customer);
  if (customerId) {
    return resolveFromCustomer(stripe, customerId);
  }

  return null;
}

async function resolveFromCustomer(stripe: StripeClient, customerId: string): Promise<string | null> {
  const customer = (await stripe.customers.retrieve(customerId, {
    expand: ['invoice_settings.default_payment_method'],
  })) as {
    invoice_settings?: { default_payment_method?: string | { id: string } | null };
  };

  const fromInvoiceSettings = paymentMethodId(customer.invoice_settings?.default_payment_method);
  if (fromInvoiceSettings) return fromInvoiceSettings;

  const methods = await stripe.paymentMethods.list({
    customer: customerId,
    type: 'card',
    limit: 1,
  });
  return methods.data[0]?.id ?? null;
}

export async function resolveDefaultPaymentMethod(
  stripe: StripeClient,
  options: {
    stripeSub: StripeSubscriptionFull;
    checkoutSessionId?: string | null;
  },
): Promise<string | null> {
  const fromSubscription = paymentMethodId(options.stripeSub.default_payment_method);
  if (fromSubscription) return fromSubscription;

  if (options.checkoutSessionId) {
    const fromCheckout = await resolveFromCheckoutSession(stripe, options.checkoutSessionId);
    if (fromCheckout) return fromCheckout;
  }

  const customerId = customerIdFrom(options.stripeSub.customer);
  if (customerId) {
    return resolveFromCustomer(stripe, customerId);
  }

  return null;
}

async function resolveUserAndPlan(params: {
  stripeSub: StripeSubscriptionFull;
  expectedRegionId: string;
  currentPlanStripePriceId: string | null;
}) {
  const meta = safeMetadata(params.stripeSub.metadata);
  const userId = meta.userId;
  const regionId = meta.regionId || params.expectedRegionId;

  if (regionId !== params.expectedRegionId) {
    throw new Error('REGION_MISMATCH');
  }

  let stripePriceId: string | undefined;
  try {
    const item = resolveStripePlanItem(params.stripeSub, params.currentPlanStripePriceId);
    stripePriceId = item.price.id;
  } catch {
    stripePriceId = params.stripeSub.items?.data?.[0]?.price?.id;
  }

  let planId = meta.planId;
  if (stripePriceId) {
    const matched = await resolvePlanByStripePriceId(stripePriceId, params.expectedRegionId);
    if (matched) planId = matched.id;
  }

  if (!userId || !planId) {
    throw new Error('Missing subscription metadata');
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, regionId: true, stripeCustomerId: true },
  });

  if (!user || user.regionId !== params.expectedRegionId) {
    throw new Error('User region mismatch');
  }

  const plan = await prisma.plan.findFirst({
    where: { id: planId, regionId: params.expectedRegionId },
    select: { id: true, name: true, stripePriceId: true },
  });

  if (!plan) throw new Error('Plan not found');

  return { user, plan, regionId, stripePriceId, meta };
}

export async function syncSubscriptionFromStripe(params: SyncSubscriptionParams) {
  const {
    stripe,
    stripeSubscription: stripeSub,
    expectedRegionId,
    checkoutSessionId,
    sourceEvent,
  } = params;

  const existing = await prisma.subscription.findUnique({
    where: { stripeSubscriptionId: stripeSub.id },
    include: { plan: true },
  });

  const { user, plan, regionId, meta } = await resolveUserAndPlan({
    stripeSub,
    expectedRegionId,
    currentPlanStripePriceId: existing?.plan.stripePriceId ?? null,
  });

  const item = resolveStripePlanItem(stripeSub, plan.stripePriceId);
  const localStatus = mapStripeStatusToLocal(stripeSub.status);

  const trialStart = stripeTs(stripeSub.trial_start);
  const trialEnd = stripeTs(stripeSub.trial_end);
  const currentPeriodStart = stripeTs(stripeSub.current_period_start);
  const currentPeriodEnd = stripeTs(stripeSub.current_period_end);
  const canceledAt = stripeTs(stripeSub.canceled_at);

  const customerId =
    typeof stripeSub.customer === 'string' ? stripeSub.customer : stripeSub.customer?.id ?? null;
  const latestInvoiceId = invoiceIdFrom(stripeSub.latest_invoice);

  if (customerId && !user.stripeCustomerId) {
    await prisma.user.update({
      where: { id: user.id },
      data: { stripeCustomerId: customerId },
    });
  }

  const defaultPm = await resolveDefaultPaymentMethod(stripe, {
    stripeSub,
    checkoutSessionId,
  });

  const subscriptionData = {
    userId: user.id,
    regionId,
    planId: plan.id,
    status: localStatus,
    provider: 'STRIPE',
    providerSubscriptionId: stripeSub.id,
    providerCustomerId: customerId,
    providerStatus: stripeSub.status,
    providerPaymentMethodPresent: Boolean(defaultPm),
    stripeCustomerId: customerId,
    stripeSubscriptionId: stripeSub.id,
    stripeSubscriptionItemId: item.id,
    ...(latestInvoiceId !== null ? { stripeLatestInvoiceId: latestInvoiceId } : {}),
    stripeDefaultPaymentMethodId: defaultPm,
    cancelAtPeriodEnd: stripeSub.cancel_at_period_end ?? false,
    canceledDuringTrial: existing?.canceledDuringTrial || (existing?.status === 'TRIALING' && localStatus === 'CANCELED'),
    canceledAt,
    currentPeriodStart,
    currentPeriodEnd,
    trialStart,
    trialEnd,
    endsAt: currentPeriodEnd,
    autoRenew: !stripeSub.cancel_at_period_end,
    promotionCode: meta.promoCode || null,
    inviteCode: meta.inviteCode || null,
    lastStripeEventCreatedAt: sourceEvent?.created
      ? new Date(sourceEvent.created * 1000)
      : undefined,
  };

  const previousStatus = existing?.status;
  const previousPlanId = existing?.planId;

  const subscription = await prisma.subscription.upsert({
    where: { stripeSubscriptionId: stripeSub.id },
    create: {
      ...subscriptionData,
      startsAt: currentPeriodStart ?? new Date(),
    },
    update: subscriptionData,
    include: { plan: true },
  });

  const billingStatus = mapStripeStatusToBillingAccess(localStatus, {
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    currentPeriodEnd: subscription.currentPeriodEnd,
    trialEnd: subscription.trialEnd,
    paymentActionRequiredAt: subscription.paymentActionRequiredAt,
  });

  const trialFields =
    localStatus === 'TRIALING'
      ? {
          trialStartedAt: trialStart ?? new Date(),
          trialEndsAt: trialEnd,
          trialRedeemedAt: new Date(),
        }
      : localStatus === 'ACTIVE' && previousStatus === 'TRIALING'
        ? { trialStartedAt: trialStart, trialEndsAt: null }
        : {};

  await setUserBillingAccess(user.id, billingStatus, trialFields);

  const eventKey = sourceEvent?.id ?? `sync:${stripeSub.id}:${stripeSub.status}`;

  if (localStatus === 'TRIALING' && previousStatus !== 'TRIALING' && trialEnd) {
    await notifyTrialActivated(user.id, trialEnd, eventKey);
  }

  if (localStatus === 'ACTIVE' && previousStatus === 'TRIALING') {
    await notifySubscriptionActivated(user.id, plan.name, eventKey);
  }

  if (localStatus === 'ACTIVE' && previousPlanId && previousPlanId !== plan.id) {
    await notifyPlanUpgrade(user.id, plan.name, eventKey);
  }

  if (subscription.cancelAtPeriodEnd && !existing?.cancelAtPeriodEnd && currentPeriodEnd) {
    await notifyCancellationScheduled(user.id, currentPeriodEnd, eventKey);
  }

  if (!subscription.cancelAtPeriodEnd && existing?.cancelAtPeriodEnd) {
    await notifyReactivated(user.id, eventKey);
  }

  if (localStatus === 'CANCELED' && previousStatus !== 'CANCELED') {
    await notifySubscriptionCanceled(user.id, eventKey);
  }

  const promotionId = meta.promotionId;
  if (promotionId && (localStatus === 'TRIALING' || localStatus === 'ACTIVE')) {
    await recordPromotionRedemption({
      promotionId,
      userId: user.id,
      regionId,
      subscriptionId: subscription.id,
    });
  }

  return subscription;
}

export async function handleCheckoutSessionCompleted(params: {
  stripe: StripeClient;
  session: StripeCheckoutSessionLike;
  expectedRegionId: string;
  sourceEvent?: { id: string; type: string; created?: number };
}) {
  const meta = safeMetadata(params.session.metadata);
  if (meta.regionId && meta.regionId !== params.expectedRegionId) {
    throw new Error('REGION_MISMATCH');
  }

  const userId = meta.userId;
  if (!userId) {
    throw new Error('Missing checkout session user');
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, regionId: true },
  });

  if (!user || user.regionId !== params.expectedRegionId) {
    throw new Error('User region mismatch');
  }

  const subscriptionId =
    typeof params.session.subscription === 'string'
      ? params.session.subscription
      : params.session.subscription?.id;

  if (!subscriptionId) return null;

  if (params.session.status && params.session.status !== 'complete') {
    return null;
  }

  const stripeSub = (await params.stripe.subscriptions.retrieve(subscriptionId, {
    expand: ['default_payment_method'],
  })) as StripeSubscriptionFull;

  if (params.session.id) {
    await prisma.subscription.updateMany({
      where: { stripeSubscriptionId: subscriptionId },
      data: { stripeCheckoutSessionId: params.session.id },
    });
  }

  return syncSubscriptionFromStripe({
    stripe: params.stripe,
    stripeSubscription: stripeSub,
    expectedRegionId: params.expectedRegionId,
    checkoutSessionId: params.session.id,
    sourceEvent: params.sourceEvent,
  });
}

export async function handleInvoiceEvent(params: {
  stripe: StripeClient;
  invoice: StripeInvoiceLike;
  expectedRegionId: string;
  eventType: string;
  sourceEvent?: { id: string; type: string; created?: number };
}) {
  const subscriptionId =
    typeof params.invoice.subscription === 'string'
      ? params.invoice.subscription
      : params.invoice.subscription?.id;

  if (!subscriptionId) return null;

  const stripeSub = (await params.stripe.subscriptions.retrieve(
    subscriptionId,
  )) as StripeSubscriptionFull;
  const sub = await syncSubscriptionFromStripe({
    stripe: params.stripe,
    stripeSubscription: stripeSub,
    expectedRegionId: params.expectedRegionId,
    sourceEvent: params.sourceEvent,
  });

  const eventKey = params.sourceEvent?.id ?? params.eventType;
  const stripeStatus = stripeSub.status;

  console.info('[stripe-webhook] invoice subscription synced', {
    eventType: params.eventType,
    invoiceId: params.invoice.id,
    subscriptionId,
    customerId:
      typeof params.invoice.customer === 'string'
        ? params.invoice.customer
        : params.invoice.customer?.id ?? null,
    stripeStatus,
    localStatus: sub.status,
    userId: sub.userId,
  });

  if (params.eventType === 'invoice.payment_failed') {
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { paymentFailedAt: new Date(), status: 'PAST_DUE' },
    });
    await setUserBillingAccess(sub.userId, BillingAccessStatus.PAST_DUE);
    await notifyPaymentFailed(sub.userId, eventKey);
  }

  if (params.eventType === 'invoice.payment_action_required') {
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { paymentActionRequiredAt: new Date(), status: 'PAYMENT_ACTION_REQUIRED' },
    });
    await setUserBillingAccess(sub.userId, BillingAccessStatus.PAYMENT_ACTION_REQUIRED);
    await notifyPaymentActionRequired(sub.userId, eventKey);
  }

  if (
    (params.eventType === 'invoice.paid' ||
      params.eventType === 'invoice.payment_succeeded') &&
    sub.status === 'ACTIVE'
  ) {
    await prisma.subscription.update({
      where: { id: sub.id },
      data: {
        paymentFailedAt: null,
        paymentActionRequiredAt: null,
        stripeLatestInvoiceId: params.invoice.id,
      },
    });
    await setUserBillingAccess(sub.userId, BillingAccessStatus.ACTIVE);
  }

  return sub;
}

export async function handleTrialWillEnd(params: {
  stripeSub: StripeSubscriptionFull;
  expectedRegionId: string;
  sourceEvent?: { id: string; type: string; created?: number };
}) {
  const meta = safeMetadata(params.stripeSub.metadata);
  const userId = meta.userId;
  const trialEnd = stripeTs(params.stripeSub.trial_end);
  if (!userId || !trialEnd) return;

  await notifyTrialEndingSoon(userId, trialEnd, params.stripeSub.id);
}

export async function handlePaymentMethodAttached(params: {
  paymentMethod: StripePaymentMethodLike;
  expectedRegionId: string;
  sourceEvent?: { id: string; type: string; created?: number };
}) {
  const customerId =
    typeof params.paymentMethod.customer === 'string'
      ? params.paymentMethod.customer
      : params.paymentMethod.customer?.id;

  if (!customerId) return;

  const user = await prisma.user.findFirst({
    where: { stripeCustomerId: customerId, regionId: params.expectedRegionId },
    select: { id: true },
  });

  if (!user) return;

  await prisma.subscription.updateMany({
    where: {
      userId: user.id,
      stripeCustomerId: customerId,
      status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE', 'PAYMENT_ACTION_REQUIRED', 'PAUSED'] },
      OR: [
        { stripeDefaultPaymentMethodId: null },
        { stripeDefaultPaymentMethodId: { not: params.paymentMethod.id } },
      ],
    },
    data: { stripeDefaultPaymentMethodId: params.paymentMethod.id },
  });

  const eventKey = params.sourceEvent?.id ?? `pm:${params.paymentMethod.id}`;
  await notifyPaymentMethodUpdated(user.id, eventKey);
}

export async function reconcileSubscriptionById(params: {
  stripe: StripeClient;
  stripeSubscriptionId: string;
  expectedRegionId: string;
}) {
  const stripeSub = (await params.stripe.subscriptions.retrieve(
    params.stripeSubscriptionId,
  )) as StripeSubscriptionFull;
  return syncSubscriptionFromStripe({
    stripe: params.stripe,
    stripeSubscription: stripeSub,
    expectedRegionId: params.expectedRegionId,
  });
}
