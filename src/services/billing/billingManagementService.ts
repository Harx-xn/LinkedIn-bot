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
import { getSafepayClient, retrieveSafepaySubscription } from './providers/safepay/safepayClient';
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

async function loadCancelableSubscription(userId: string) {
  const manageable = await getManageableSubscription(userId);
  if (manageable) return manageable;
  // A previous cancellation response may have said CANCELED before Safepay's
  // retrieval API confirmed it. Keep that row recoverable and reconcilable.
  return prisma.subscription.findFirst({
    where: {
      userId,
      provider: 'SAFEPAY',
      status: 'CANCELED',
      providerSubscriptionId: { not: null },
    },
    orderBy: { updatedAt: 'desc' },
    include: { plan: true },
  });
}

export function normalizeSafepayCancellationResource(
  result: unknown,
  subscription: { id: string; providerSubscriptionId: string; status: string },
) {
  const response = result && typeof result === 'object' ? result as Record<string, any> : {};
  const data = response.data && typeof response.data === 'object' ? response.data as Record<string, any> : response;
  const resource = data.subscription && typeof data.subscription === 'object'
    ? data.subscription as Record<string, any>
    : data;
  return {
    ...resource,
    token: resource.token ?? resource.id ?? subscription.providerSubscriptionId,
    reference: resource.reference ?? subscription.id,
    status: resource.status ?? subscription.status,
    cancel_at_period_end: resource.cancel_at_period_end ?? true,
  };
}

export function getSafepayProviderError(error: unknown) {
  const response = (error as { response?: { status?: number; data?: any } })?.response;
  const providerError = response?.data?.error;
  const rawMessage = typeof providerError === 'string'
    ? providerError
    : providerError?.message ?? response?.data?.message;
  const rawCode = typeof providerError === 'object'
    ? providerError?.code ?? providerError?.type
    : response?.data?.code;
  return {
    httpStatus: response?.status ?? null,
    providerCode: typeof rawCode === 'string' ? rawCode.slice(0, 100) : null,
    providerMessage: typeof rawMessage === 'string' ? rawMessage.slice(0, 300) : null,
  };
}

export function isSafepayCancellationConfirmed(resource: Record<string, any>) {
  const status = String(resource.status ?? '').trim().toUpperCase();
  return Boolean(resource.cancel_at_period_end) || ['CANCELED', 'CANCELLED', 'ENDED'].includes(status);
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
  const sub = await loadCancelableSubscription(userId);
  if (!sub?.regionId || (!sub.providerSubscriptionId && !sub.stripeSubscriptionId)) {
    throw new BillingError(400, 'SUBSCRIPTION_NOT_MANAGEABLE', 'No manageable subscription found');
  }
  const provider = getPaymentProvider(sub.provider ?? 'STRIPE');
  if (!provider.capabilities.cancel) throw new BillingError(400, 'SUBSCRIPTION_NOT_MANAGEABLE', 'Cancellation is not supported for this subscription.');
  if (provider.type === 'SAFEPAY') {
    const { client } = await getSafepayClient(sub.regionId!);
    let result: unknown;
    try {
      result = await client.subscription.cancel(sub.providerSubscriptionId!);
    } catch (error) {
      const providerError = getSafepayProviderError(error);
      if (providerError.httpStatus === 406) {
        try {
          const remote = await retrieveSafepaySubscription(sub.regionId!, sub.providerSubscriptionId!);
          if (isSafepayCancellationConfirmed(remote)) {
            const synced = await syncSafepaySubscription(sub.regionId!, { ...remote, reference: sub.id });
            return { cancelAtPeriodEnd: synced.cancelAtPeriodEnd, cancellationEffectiveAt: synced.currentPeriodEnd?.toISOString() ?? null, status: synced.status };
          }
        } catch (reconciliationError) {
          console.warn('[SAFEPAY-SUBSCRIPTION-CANCEL-RECONCILE-FAILED]', {
            userId,
            localSubscriptionId: sub.id,
            providerSubscriptionId: sub.providerSubscriptionId,
            message: reconciliationError instanceof Error ? reconciliationError.message.slice(0, 200) : 'Reconciliation failed',
          });
        }
      }
      console.error('[SAFEPAY-SUBSCRIPTION-CANCEL-FAILED]', {
        userId,
        regionId: sub.regionId,
        localSubscriptionId: sub.id,
        providerSubscriptionId: sub.providerSubscriptionId,
        status: sub.status,
        providerHttpStatus: providerError.httpStatus,
        providerCode: providerError.providerCode,
        providerMessage: providerError.providerMessage,
        message: error instanceof Error ? error.message.slice(0, 200) : 'Safepay cancellation failed',
      });
      throw new BillingError(502, 'SUBSCRIPTION_CANCEL_FAILED', "We couldn't cancel your subscription. Please try again.");
    }
    try {
      const mutationResource = normalizeSafepayCancellationResource(result, {
        id: sub.id,
        providerSubscriptionId: sub.providerSubscriptionId!,
        status: sub.status,
      });
      const remote = await retrieveSafepaySubscription(sub.regionId!, sub.providerSubscriptionId!);
      console.info('[SAFEPAY-SUBSCRIPTION-CANCEL-VERIFIED]', {
        userId,
        regionId: sub.regionId,
        localSubscriptionId: sub.id,
        providerSubscriptionId: sub.providerSubscriptionId,
        mutationStatus: mutationResource.status ? String(mutationResource.status) : null,
        retrievedStatus: remote.status ? String(remote.status) : null,
        retrievedCancelAtPeriodEnd: Boolean(remote.cancel_at_period_end),
        confirmed: isSafepayCancellationConfirmed(remote),
      });
      if (!isSafepayCancellationConfirmed(remote)) {
        // Restore the provider's currently retrievable truth instead of leaving
        // Veyrais canceled from a mutation response the dashboard/API cannot confirm.
        await syncSafepaySubscription(sub.regionId!, { ...remote, reference: sub.id });
        throw new BillingError(409, 'SUBSCRIPTION_CANCEL_FAILED', 'Safepay has not confirmed the cancellation yet. Please try again shortly.');
      }
      const synced = await syncSafepaySubscription(sub.regionId!, { ...remote, reference: sub.id });
      return { cancelAtPeriodEnd: synced.cancelAtPeriodEnd, cancellationEffectiveAt: synced.currentPeriodEnd?.toISOString() ?? null, status: synced.status };
    } catch (error) {
      if (error instanceof BillingError) throw error;
      console.error('[SAFEPAY-SUBSCRIPTION-CANCEL-SYNC-FAILED]', {
        userId,
        localSubscriptionId: sub.id,
        providerSubscriptionId: sub.providerSubscriptionId,
        message: error instanceof Error ? error.message.slice(0, 200) : 'Cancellation sync failed',
      });
      throw new BillingError(502, 'SUBSCRIPTION_CANCEL_FAILED', "Safepay accepted the cancellation, but Veyrais couldn't refresh it yet. Please try again.");
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
