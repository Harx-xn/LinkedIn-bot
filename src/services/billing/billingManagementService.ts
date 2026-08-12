import { prisma } from '../../prismaClient';
import { config } from '../../config';
import { BillingError } from './billingError';
import { getManageableSubscription } from './billingAccessService';
import {
  notifyCancellationScheduled,
  notifyReactivated,
} from './billingNotificationService';
import { assertFrontendUrl, getRegionalStripeClient } from './stripeClientService';
import { validatePlanStripePrice } from './stripePlanService';
import { syncSubscriptionFromStripe } from './stripeSubscriptionSyncService';
import type { StripeSubscriptionFull } from './stripeTypes';
import { getPaymentProvider } from './providers/providerFactory';
import { getSafepayClient } from './providers/safepay/safepayClient';
import { syncSafepaySubscription } from './providers/safepay/safepaySubscriptionSyncService';

async function loadOwnedSubscription(userId: string) {
  const sub = await getManageableSubscription(userId);
  if (!sub?.regionId || (!sub.providerSubscriptionId && !sub.stripeSubscriptionId)) {
    throw new BillingError(
      400,
      'SUBSCRIPTION_NOT_MANAGEABLE',
      'No manageable subscription found',
    );
  }
  return sub;
}

export async function createPortalSession(userId: string) {
  const owned = await getManageableSubscription(userId);
  if (owned && (owned.provider ?? 'STRIPE') !== 'STRIPE') {
    throw new BillingError(400, 'SUBSCRIPTION_NOT_MANAGEABLE', 'This provider is managed directly in Veyrais.');
  }
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { stripeCustomerId: true, regionId: true },
  });

  if (!user?.regionId) {
    throw new BillingError(404, 'PLAN_NOT_FOUND', 'User not found');
  }

  let customerId = user.stripeCustomerId;
  if (!customerId) {
    const sub = await prisma.subscription.findFirst({
      where: { userId, stripeCustomerId: { not: null } },
      select: { stripeCustomerId: true },
      orderBy: { createdAt: 'desc' },
    });
    customerId = sub?.stripeCustomerId ?? null;
  }

  if (!customerId) {
    throw new BillingError(400, 'PAYMENT_METHOD_REQUIRED', 'No billing account found yet');
  }

  const stripe = await getRegionalStripeClient(user.regionId);
  const returnUrl = `${config.frontendUrl}/billing`;
  assertFrontendUrl(returnUrl, config.frontendUrl);

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });

  return { url: session.url };
}

export async function cancelSubscription(userId: string) {
  const sub = await loadOwnedSubscription(userId);
  const provider = getPaymentProvider(sub.provider ?? 'STRIPE');
  if (!provider.capabilities.cancel) throw new BillingError(400, 'SUBSCRIPTION_NOT_MANAGEABLE', 'Cancellation is not supported for this subscription.');
  if (provider.type === 'SAFEPAY') {
    const { client } = await getSafepayClient(sub.regionId!);
    try {
      const result = await client.subscription.cancel(sub.providerSubscriptionId!);
      const synced = await syncSafepaySubscription(sub.regionId!, { ...result, reference: sub.id });
      return { cancelAtPeriodEnd: synced.cancelAtPeriodEnd, cancellationEffectiveAt: synced.currentPeriodEnd?.toISOString() ?? null, status: synced.status };
    } catch {
      throw new BillingError(502, 'SUBSCRIPTION_NOT_MANAGEABLE', "We couldn't update your subscription.");
    }
  }
  const stripe = await getRegionalStripeClient(sub.regionId!);

  const updated = await stripe.subscriptions.update(sub.stripeSubscriptionId!, {
    cancel_at_period_end: true,
  });

  const synced = await syncSubscriptionFromStripe({
    stripe,
    stripeSubscription: updated,
    expectedRegionId: sub.regionId!,
    sourceEvent: { id: `cancel:${sub.id}`, type: 'user.cancel' },
  });

  if (synced.currentPeriodEnd) {
    await notifyCancellationScheduled(
      userId,
      synced.currentPeriodEnd,
      `user-cancel:${sub.id}`,
    );
  }

  return {
    cancelAtPeriodEnd: true,
    cancellationEffectiveAt: synced.currentPeriodEnd?.toISOString() ?? null,
    status: synced.status,
  };
}

export async function reactivateSubscription(userId: string) {
  const sub = await prisma.subscription.findFirst({
    where: {
      userId,
      OR: [
        { stripeSubscriptionId: { not: null }, cancelAtPeriodEnd: true },
        { provider: 'SAFEPAY', providerSubscriptionId: { not: null }, status: 'PAUSED' },
      ],
    },
    include: { plan: true },
    orderBy: { createdAt: 'desc' },
  });

  if (!sub?.regionId || (!sub.providerSubscriptionId && !sub.stripeSubscriptionId)) {
    throw new BillingError(
      400,
      'SUBSCRIPTION_NOT_MANAGEABLE',
      'No scheduled cancellation found to reverse',
    );
  }

  if (sub.provider === 'SAFEPAY') {
    const { client } = await getSafepayClient(sub.regionId);
    try {
      const result = await client.subscription.resume(sub.providerSubscriptionId!);
      const synced = await syncSafepaySubscription(sub.regionId, { ...result, reference: sub.id });
      return { cancelAtPeriodEnd: synced.cancelAtPeriodEnd, status: synced.status };
    } catch {
      throw new BillingError(502, 'SUBSCRIPTION_NOT_MANAGEABLE', "We couldn't update your subscription.");
    }
  }

  const stripe = await getRegionalStripeClient(sub.regionId);
  const updated = await stripe.subscriptions.update(sub.stripeSubscriptionId!, {
    cancel_at_period_end: false,
  });

  const synced = await syncSubscriptionFromStripe({
    stripe,
    stripeSubscription: updated,
    expectedRegionId: sub.regionId,
    sourceEvent: { id: `reactivate:${sub.id}`, type: 'user.reactivate' },
  });

  await notifyReactivated(userId, `user-reactivate:${sub.id}`);

  return {
    cancelAtPeriodEnd: false,
    status: synced.status,
  };
}

export async function changePlan(userId: string, targetPlanId: string) {
  const sub = await loadOwnedSubscription(userId);
  const provider = getPaymentProvider(sub.provider ?? 'STRIPE');
  if (!provider.capabilities.proratedPlanChanges) {
    throw new BillingError(400, 'SUBSCRIPTION_NOT_MANAGEABLE', 'Plan changes are not supported for this subscription provider.');
  }

  if (!sub.plan) {
    throw new BillingError(400, 'SUBSCRIPTION_NOT_MANAGEABLE', 'Current subscription plan not found');
  }

  if (!sub.plan.stripePriceId) {
    throw new BillingError(
      400,
      'CURRENT_PLAN_NOT_CONFIGURED_IN_STRIPE',
      'Current plan is not configured for Stripe billing.',
    );
  }

  const stripe = await getRegionalStripeClient(sub.regionId!);
  const { plan: targetPlan } = await validatePlanStripePrice(
    targetPlanId,
    sub.regionId!,
    stripe,
  );

  if (!targetPlan.stripePriceId) {
    throw new BillingError(
      400,
      'PLAN_NOT_CONFIGURED_IN_STRIPE',
      'This plan is not configured for Stripe billing yet.',
    );
  }

  if (sub.planId === targetPlan.id) {
    return {
      pending: false,
      planId: targetPlan.id,
      status: sub.status,
      effectiveAt: null,
    };
  }

  const stripeSub = (await stripe.subscriptions.retrieve(
    sub.stripeSubscriptionId!,
  )) as StripeSubscriptionFull;

  const item = stripeSub.items?.data?.find(
    (lineItem) => lineItem.price.id === sub.plan.stripePriceId,
  );
  if (!item) {
    throw new BillingError(
      400,
      'SUBSCRIPTION_ITEM_NOT_FOUND',
      'Could not find the current subscription item in Stripe.',
    );
  }

  const isUpgrade = targetPlan.price > sub.plan.price;

  // TODO: support scheduled downgrades at period end using Stripe subscription schedules
  // after handling existing schedules and Stripe phase rules.

  const updated = await stripe.subscriptions.update(sub.stripeSubscriptionId!, {
    items: [{ id: item.id, price: targetPlan.stripePriceId }],
    proration_behavior: isUpgrade ? 'create_prorations' : 'none',
    metadata: {
      ...stripeSub.metadata,
      planId: targetPlan.id,
      userId,
      regionId: sub.regionId!,
    },
  });

  const synced = await syncSubscriptionFromStripe({
    stripe,
    stripeSubscription: updated,
    expectedRegionId: sub.regionId!,
    sourceEvent: { id: `change-plan:${sub.id}:${targetPlan.id}`, type: 'user.change_plan' },
  });

  if (synced.planId !== targetPlan.id) {
    await prisma.subscription.update({
      where: { id: synced.id },
      data: { planId: targetPlan.id },
    });
  }

  return {
    pending: false,
    planId: targetPlan.id,
    status: synced.status,
    effectiveAt: null,
  };
}
