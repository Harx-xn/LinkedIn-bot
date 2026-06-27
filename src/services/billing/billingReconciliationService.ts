import { prisma } from '../../prismaClient';
import { getRegionalStripeClient } from './stripeClientService';
import { reconcileSubscriptionById } from './stripeSubscriptionSyncService';

const NON_FINAL_STATUSES = [
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'PAYMENT_ACTION_REQUIRED',
  'INCOMPLETE',
  'PAUSED',
];

const STALE_ACCESS_CANDIDATE_STATUSES = [
  'TRIALING',
  'PAST_DUE',
  'PAYMENT_ACTION_REQUIRED',
  'INCOMPLETE',
  'PAUSED',
] as const;

export async function reconcileOpenSubscriptions(regionId?: string) {
  const subs = await prisma.subscription.findMany({
    where: {
      stripeSubscriptionId: { not: null },
      status: { in: NON_FINAL_STATUSES },
      ...(regionId ? { regionId } : {}),
    },
    select: { id: true, stripeSubscriptionId: true, regionId: true },
    take: 100,
  });

  const results: Array<{ subscriptionId: string; ok: boolean; error?: string }> = [];

  for (const sub of subs) {
    if (!sub.stripeSubscriptionId || !sub.regionId) continue;
    try {
      const stripe = await getRegionalStripeClient(sub.regionId);
      await reconcileSubscriptionById({
        stripe,
        stripeSubscriptionId: sub.stripeSubscriptionId,
        expectedRegionId: sub.regionId,
      });
      results.push({ subscriptionId: sub.id, ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'reconciliation failed';
      results.push({ subscriptionId: sub.id, ok: false, error: message });
    }
  }

  return results;
}

function isPast(value: Date | null | undefined): boolean {
  return !!value && value.getTime() <= Date.now();
}

export async function reconcileUserStripeSubscriptionForAccess(
  userId: string,
  reason: string,
) {
  const sub = await prisma.subscription.findFirst({
    where: {
      userId,
      stripeSubscriptionId: { not: null },
      status: { in: [...STALE_ACCESS_CANDIDATE_STATUSES] },
    },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      status: true,
      stripeSubscriptionId: true,
      regionId: true,
      planId: true,
      trialEnd: true,
      currentPeriodEnd: true,
      user: {
        select: {
          billingAccessStatus: true,
          trialEndsAt: true,
        },
      },
    },
  });

  if (!sub?.stripeSubscriptionId || !sub.regionId) return null;

  const looksStale =
    sub.status !== 'TRIALING' ||
    isPast(sub.trialEnd) ||
    isPast(sub.user.trialEndsAt);

  if (!looksStale) return null;

  try {
    const stripe = await getRegionalStripeClient(sub.regionId);
    const synced = await reconcileSubscriptionById({
      stripe,
      stripeSubscriptionId: sub.stripeSubscriptionId,
      expectedRegionId: sub.regionId,
    });

    console.info('[billing-reconcile] user subscription reconciled', {
      reason,
      userId,
      subscriptionId: sub.id,
      stripeSubscriptionId: sub.stripeSubscriptionId,
      previousStatus: sub.status,
      syncedStatus: synced.status,
      billingAccessStatus: sub.user.billingAccessStatus,
      trialEndsAt: sub.user.trialEndsAt?.toISOString() ?? null,
      planId: synced.planId,
    });

    return synced;
  } catch (err) {
    console.warn('[billing-reconcile] user subscription reconciliation failed', {
      reason,
      userId,
      subscriptionId: sub.id,
      stripeSubscriptionId: sub.stripeSubscriptionId,
      localStatus: sub.status,
      billingAccessStatus: sub.user.billingAccessStatus,
      trialEndsAt: sub.user.trialEndsAt?.toISOString() ?? null,
      planId: sub.planId,
      message: err instanceof Error ? err.message : 'reconciliation failed',
    });
    return null;
  }
}
