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
