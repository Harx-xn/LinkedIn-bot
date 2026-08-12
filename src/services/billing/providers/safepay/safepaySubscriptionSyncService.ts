import { BillingAccessStatus } from '@prisma/client';
import { prisma } from '../../../../prismaClient';
import { setUserBillingAccess } from '../../billingAccessService';

const asDate = (value: unknown): Date | null => {
  if (typeof value !== 'string' || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export function mapSafepayStatusToLocal(status: unknown): string {
  switch (String(status ?? '').toUpperCase()) {
    case 'TRAILING': // spelling used by the official SDK
    case 'TRIALING': return 'TRIALING';
    case 'ACTIVE': return 'ACTIVE';
    case 'PAST_DUE':
    case 'UNPAID': return 'PAST_DUE';
    case 'PAUSED': return 'PAUSED';
    case 'CANCELED':
    case 'CANCELLED':
    case 'ENDED': return 'CANCELED';
    case 'INCOMPLETE':
    case 'INCOMPLETE_EXPIRED': return 'INCOMPLETE';
    default: return 'INCOMPLETE';
  }
}

function billingAccessFor(status: string): BillingAccessStatus {
  if (status === 'TRIALING') return BillingAccessStatus.TRIALING;
  if (status === 'ACTIVE') return BillingAccessStatus.ACTIVE;
  if (status === 'PAST_DUE') return BillingAccessStatus.PAST_DUE;
  if (status === 'PAUSED') return BillingAccessStatus.PAUSED;
  if (status === 'CANCELED') return BillingAccessStatus.CANCELED;
  return BillingAccessStatus.INCOMPLETE;
}

export async function syncSafepaySubscription(regionId: string, raw: Record<string, any>) {
  const providerSubscriptionId = raw.token ?? raw.id ?? raw.subscription_id;
  const reference = raw.reference ?? raw.metadata?.reference;
  if (!providerSubscriptionId || !reference) throw new Error('Safepay subscription correlation is missing');

  const existing = await prisma.subscription.findFirst({
    where: { OR: [{ id: String(reference) }, { provider: 'SAFEPAY', providerSubscriptionId: String(providerSubscriptionId) }] },
    include: { plan: true },
  });
  if (!existing || existing.regionId !== regionId || existing.provider !== 'SAFEPAY') {
    throw new Error('Safepay subscription does not belong to this region');
  }

  const status = mapSafepayStatusToLocal(raw.status);
  const trialStart = asDate(raw.trial_start_date);
  const trialEnd = asDate(raw.trial_end_date);
  const periodStart = asDate(raw.current_period_start_date);
  const periodEnd = asDate(raw.current_period_end_date);
  const paymentMethodPresent = Boolean(raw.instrument_id);
  const updated = await prisma.subscription.update({
    where: { id: existing.id },
    data: {
      providerSubscriptionId: String(providerSubscriptionId),
      providerCustomerId: raw.user_id ? String(raw.user_id) : null,
      providerStatus: raw.status ? String(raw.status) : null,
      providerPaymentMethodPresent: paymentMethodPresent,
      status,
      trialStart,
      trialEnd,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      endsAt: periodEnd,
      cancelAtPeriodEnd: Boolean(raw.cancel_at_period_end),
      canceledAt: asDate(raw.canceled_at),
      autoRenew: !raw.cancel_at_period_end && status !== 'CANCELED',
      paymentFailedAt: status === 'PAST_DUE' ? new Date() : null,
    },
  });

  await setUserBillingAccess(existing.userId, billingAccessFor(status), status === 'TRIALING'
    ? { trialStartedAt: trialStart ?? new Date(), trialEndsAt: trialEnd, trialRedeemedAt: new Date() }
    : undefined);
  return updated;
}

export async function recordSafepayTransaction(regionId: string, raw: Record<string, any>, succeeded: boolean) {
  const transactionId = raw.token ?? raw.id ?? raw.transaction_id ?? raw.tracker;
  const subscriptionId = raw.subscription_id ?? raw.subscription?.token;
  if (!transactionId || !subscriptionId) return;
  const sub = await prisma.subscription.findFirst({ where: { provider: 'SAFEPAY', providerSubscriptionId: String(subscriptionId), regionId } });
  if (!sub) throw new Error('Safepay transaction does not belong to this region');
  const amount = Number(raw.amount ?? raw.price_amount ?? 0);
  await prisma.billingTransaction.upsert({
    where: { provider_providerTransactionId: { provider: 'SAFEPAY', providerTransactionId: String(transactionId) } },
    create: {
      userId: sub.userId, regionId, subscriptionId: sub.id, provider: 'SAFEPAY',
      providerTransactionId: String(transactionId), amount, amountPaid: succeeded ? amount : 0,
      currency: String(raw.currency ?? raw.price_currency ?? 'PKR').toLowerCase(),
      status: succeeded ? 'paid' : 'open', paidAt: succeeded ? new Date() : null,
      failedAt: succeeded ? null : new Date(), metadata: raw,
    },
    update: { status: succeeded ? 'paid' : 'open', amountPaid: succeeded ? amount : 0, paidAt: succeeded ? new Date() : null, failedAt: succeeded ? null : new Date(), metadata: raw },
  });
  if (!succeeded) {
    await prisma.subscription.update({ where: { id: sub.id }, data: { status: 'PAST_DUE', providerStatus: 'PAST_DUE', paymentFailedAt: new Date() } });
    await setUserBillingAccess(sub.userId, BillingAccessStatus.PAST_DUE);
  }
}

