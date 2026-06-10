import { prisma } from '../../prismaClient';
import { config } from '../../config';
import { resolveStripePlanItem } from '../subscriptionAdminService';
import { BillingError } from './billingError';
import { getManageableSubscription } from './billingAccessService';
import {
  notifyCancellationScheduled,
  notifyDowngradeScheduled,
  notifyReactivated,
} from './billingNotificationService';
import { assertFrontendUrl, getRegionalStripeClient } from './stripeClientService';
import { validatePlanStripePrice } from './stripePlanService';
import { syncSubscriptionFromStripe } from './stripeSubscriptionSyncService';
import type { StripeSubscriptionFull } from './stripeTypes';

async function loadOwnedSubscription(userId: string) {
  const sub = await getManageableSubscription(userId);
  if (!sub?.stripeSubscriptionId || !sub.regionId) {
    throw new BillingError(
      400,
      'SUBSCRIPTION_NOT_MANAGEABLE',
      'No manageable subscription found',
    );
  }
  return sub;
}

export async function createPortalSession(userId: string) {
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
      stripeSubscriptionId: { not: null },
      cancelAtPeriodEnd: true,
      status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] },
    },
    include: { plan: true },
    orderBy: { createdAt: 'desc' },
  });

  if (!sub?.stripeSubscriptionId || !sub.regionId) {
    throw new BillingError(
      400,
      'SUBSCRIPTION_NOT_MANAGEABLE',
      'No scheduled cancellation found to reverse',
    );
  }

  const stripe = await getRegionalStripeClient(sub.regionId);
  const updated = await stripe.subscriptions.update(sub.stripeSubscriptionId, {
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
  const stripe = await getRegionalStripeClient(sub.regionId!);
  const { plan: targetPlan } = await validatePlanStripePrice(
    targetPlanId,
    sub.regionId!,
    stripe,
  );

  if (sub.planId === targetPlan.id) {
    return { pending: false, planId: targetPlan.id, status: sub.status };
  }

  const stripeSub = (await stripe.subscriptions.retrieve(
    sub.stripeSubscriptionId!,
  )) as StripeSubscriptionFull;
  const item = resolveStripePlanItem(stripeSub, sub.plan.stripePriceId);

  const isUpgrade = targetPlan.price > sub.plan.price;
  const prorationBehavior = isUpgrade ? ('create_prorations' as const) : ('none' as const);

  let updated;
  if (isUpgrade) {
    updated = await stripe.subscriptions.update(sub.stripeSubscriptionId!, {
      items: [{ id: item.id, price: targetPlan.stripePriceId }],
      proration_behavior: prorationBehavior,
      metadata: {
        ...stripeSub.metadata,
        planId: targetPlan.id,
        userId,
        regionId: sub.regionId!,
      },
    });
  } else {
    const periodEnd = stripeSub.current_period_end;
    await stripe.subscriptionSchedules.create({
      from_subscription: sub.stripeSubscriptionId!,
      end_behavior: 'release',
      phases: [
        {
          items: [{ price: sub.plan.stripePriceId!, quantity: 1 }],
          end_date: periodEnd,
        },
        {
          items: [{ price: targetPlan.stripePriceId, quantity: 1 }],
          metadata: {
            planId: targetPlan.id,
            userId,
            regionId: sub.regionId!,
          },
        },
      ],
    });
    updated = (await stripe.subscriptions.retrieve(
      sub.stripeSubscriptionId!,
    )) as StripeSubscriptionFull;
  }

  const synced = await syncSubscriptionFromStripe({
    stripe,
    stripeSubscription: updated,
    expectedRegionId: sub.regionId!,
    sourceEvent: { id: `change-plan:${sub.id}:${targetPlan.id}`, type: 'user.change_plan' },
  });

  if (!isUpgrade && synced.currentPeriodEnd) {
    await notifyDowngradeScheduled(
      userId,
      targetPlan.name,
      synced.currentPeriodEnd,
      `change-plan:${sub.id}:${targetPlan.id}`,
    );
  }

  return {
    pending: !isUpgrade,
    planId: synced.planId,
    status: synced.status,
    effectiveAt: isUpgrade ? null : synced.currentPeriodEnd?.toISOString() ?? null,
  };
}
