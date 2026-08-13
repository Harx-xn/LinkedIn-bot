import { BillingAccessStatus } from '@prisma/client';
import { prisma } from '../../../../prismaClient';
import { hasDashboardAccess, setUserBillingAccess } from '../../billingAccessService';
import { loadSafepayConfiguration, retrieveSafepaySubscription } from './safepayClient';

const asDate = (value: unknown): Date | null => {
  if (typeof value !== 'string' || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export function mapSafepayStatusToLocal(status: unknown): string {
  switch (String(status ?? '').trim().toUpperCase().replace(/[ -]/g, '_')) {
    case 'TRIAL':
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
  if (!providerSubscriptionId) throw new Error('Safepay subscription ID missing');

  console.info('[SAFEPAY-CORRELATION-ATTEMPT]', {
    regionId,
    localSubscriptionId: reference ? String(reference) : null,
    checkoutReference: reference ? String(reference) : null,
    providerSubscriptionId: String(providerSubscriptionId),
    planId: raw.plan_id ? String(raw.plan_id) : null,
    providerStatus: raw.status ? String(raw.status) : null,
  });

  const existing = await prisma.subscription.findFirst({
    where: {
      provider: 'SAFEPAY',
      regionId,
      OR: [
        { providerSubscriptionId: String(providerSubscriptionId) },
        ...(reference ? [{ id: String(reference) }] : []),
      ],
    },
    include: { plan: true },
  });
  if (!existing) {
    throw new Error(reference
      ? 'No local pending subscription matched provider reference'
      : 'No local subscription matched Safepay subscription ID');
  }
  if (raw.plan_id) {
    const providerConfig = await loadSafepayConfiguration(regionId);
    const mapping = await prisma.planProviderMapping.findUnique({
      where: {
        planId_provider_environment: {
          planId: existing.planId,
          provider: 'SAFEPAY',
          environment: providerConfig.environment,
        },
      },
      select: { providerPlanId: true },
    });
    if (!mapping?.providerPlanId || mapping.providerPlanId !== String(raw.plan_id)) {
      throw new Error('Safepay plan mapping not found');
    }
  }

  const mappedStatus = mapSafepayStatusToLocal(raw.status);
  if (mappedStatus === 'INCOMPLETE' && !['INCOMPLETE', 'INCOMPLETE_EXPIRED'].includes(String(raw.status ?? '').trim().toUpperCase())) {
    throw new Error(`Unknown Safepay subscription status: ${String(raw.status ?? 'missing')}`);
  }
  // Safepay timestamps and our Prisma updatedAt are different clocks and cannot
  // safely be compared. Only suppress a transient provider downgrade that would
  // move an already-confirmed subscription back to setup-incomplete.
  const staleEvent = ['TRIALING', 'ACTIVE'].includes(existing.status) && mappedStatus === 'INCOMPLETE';
  const status = staleEvent ? existing.status : mappedStatus;
  const accessBefore = await hasDashboardAccess(existing.userId);
  console.info('[SAFEPAY-CORRELATION-SUCCESS]', {
    regionId,
    userId: existing.userId,
    localSubscriptionId: existing.id,
    checkoutReference: reference ? String(reference) : null,
    providerSubscriptionId: String(providerSubscriptionId),
    planId: raw.plan_id ? String(raw.plan_id) : existing.planId,
  });
  console.info('[SAFEPAY-STATUS-MAPPED]', {
    regionId,
    userId: existing.userId,
    localSubscriptionId: existing.id,
    providerSubscriptionId: String(providerSubscriptionId),
    planId: raw.plan_id ? String(raw.plan_id) : existing.planId,
    providerStatus: raw.status ? String(raw.status) : null,
    normalizedStatus: status,
  });
  console.info('[billing-webhook-subscription-correlated]', {
    provider: 'SAFEPAY', regionId, providerSubscriptionId: String(providerSubscriptionId),
    localSubscriptionId: existing.id, userId: existing.userId,
  });
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
  const accessAfter = await hasDashboardAccess(existing.userId);
  console.info('[SAFEPAY-LOCAL-SUBSCRIPTION-UPDATED]', {
    regionId,
    userId: existing.userId,
    localSubscriptionId: existing.id,
    providerSubscriptionId: String(providerSubscriptionId),
    planId: existing.planId,
    providerStatus: raw.status ? String(raw.status) : null,
    normalizedStatus: status,
  });
  console.info('[SAFEPAY-ACCESS-RESULT]', {
    regionId,
    userId: existing.userId,
    localSubscriptionId: existing.id,
    providerSubscriptionId: String(providerSubscriptionId),
    providerStatus: raw.status ? String(raw.status) : null,
    normalizedStatus: status,
    dashboardAccess: accessAfter,
  });
  console.info('[billing-subscription-sync]', {
    provider: 'SAFEPAY', regionId, providerSubscriptionId: String(providerSubscriptionId),
    localSubscriptionId: existing.id, userId: existing.userId,
    previousStatus: existing.status, providerStatus: raw.status ? String(raw.status) : null,
    normalizedStatus: status, staleEvent, accessBefore, accessAfter,
  });
  console.info('[billing-webhook-subscription-synced]', {
    provider: 'SAFEPAY', regionId, providerSubscriptionId: String(providerSubscriptionId),
    localSubscriptionId: existing.id, userId: existing.userId,
    providerStatus: raw.status ? String(raw.status) : null, normalizedStatus: status,
    accessBefore, accessAfter,
  });
  return updated;
}

export async function reconcileSafepaySubscription(regionId: string, localSubscriptionId: string) {
  const local = await prisma.subscription.findFirst({
    where: { id: localSubscriptionId, regionId, provider: 'SAFEPAY' },
    select: { id: true, providerSubscriptionId: true },
  });
  if (!local) throw new Error('Region/provider mismatch');
  if (!local.providerSubscriptionId) return null;
  const remote = await retrieveSafepaySubscription(regionId, local.providerSubscriptionId);
  return syncSafepaySubscription(regionId, { ...remote, reference: local.id });
}

export async function recordSafepayTransaction(regionId: string, raw: Record<string, any>, outcome: 'SUCCEEDED' | 'FAILED' | 'REFUNDED' | 'DISPUTED') {
  const transactionId = raw.token ?? raw.id ?? raw.transaction_id ?? raw.tracker;
  const subscriptionId = raw.subscription_id ?? raw.subscription?.token;
  if (!transactionId || !subscriptionId) return null;
  const sub = await prisma.subscription.findFirst({ where: { provider: 'SAFEPAY', providerSubscriptionId: String(subscriptionId), regionId } });
  if (!sub) throw new Error('Safepay transaction does not belong to this region');
  const amount = Number(raw.amount ?? raw.price_amount ?? 0);
  const succeeded = outcome === 'SUCCEEDED';
  const failed = outcome === 'FAILED';
  const transactionStatus = succeeded ? 'paid' : outcome === 'REFUNDED' ? 'refunded' : outcome === 'DISPUTED' ? 'disputed' : 'open';
  await prisma.billingTransaction.upsert({
    where: { provider_providerTransactionId: { provider: 'SAFEPAY', providerTransactionId: String(transactionId) } },
    create: {
      userId: sub.userId, regionId, subscriptionId: sub.id, provider: 'SAFEPAY',
      providerTransactionId: String(transactionId), amount, amountPaid: succeeded ? amount : 0,
      currency: String(raw.currency ?? raw.price_currency ?? 'PKR').toLowerCase(),
      status: transactionStatus, paidAt: succeeded ? new Date() : null,
      failedAt: failed ? new Date() : null, metadata: raw,
    },
    update: { status: transactionStatus, amountPaid: succeeded ? amount : 0, paidAt: succeeded ? new Date() : null, failedAt: failed ? new Date() : null, metadata: raw },
  });
  if (failed) {
    await prisma.subscription.update({ where: { id: sub.id }, data: { status: 'PAST_DUE', providerStatus: 'PAST_DUE', paymentFailedAt: new Date() } });
    await setUserBillingAccess(sub.userId, BillingAccessStatus.PAST_DUE);
  }
  return { localSubscriptionId: sub.id, userId: sub.userId, providerSubscriptionId: String(subscriptionId), transactionId: String(transactionId), status: transactionStatus };
}
