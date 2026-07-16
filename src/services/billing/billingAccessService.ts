import { BillingAccessStatus, UserRole } from '@prisma/client';
import { prisma } from '../../prismaClient';
import { getNumberSetting } from '../settingsService';
import { MANAGEABLE_SUBSCRIPTION_STATUSES } from '../../types/billing';

export const DEFAULT_TRIAL_DAYS = 14;

/** Active subscriptions that should block starting a new Stripe Checkout session. */
export const CHECKOUT_BLOCKING_SUBSCRIPTION_STATUSES = [
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'PAYMENT_ACTION_REQUIRED',
  'PAUSED',
] as const;

const BILLING_ONLY_STATUSES: BillingAccessStatus[] = [
  BillingAccessStatus.BILLING_REQUIRED,
  BillingAccessStatus.TRIAL_PENDING,
  BillingAccessStatus.INCOMPLETE,
  BillingAccessStatus.PAYMENT_ACTION_REQUIRED,
];

export async function getUserBillingContext(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      role: true,
      regionId: true,
      trialStartedAt: true,
      trialEndsAt: true,
      trialRedeemedAt: true,
      billingAccessStatus: true,
      stripeCustomerId: true,
      isBillingExempt: true,
    },
  });
}

export async function getManageableSubscription(userId: string) {
  return prisma.subscription.findFirst({
    where: {
      userId,
      status: { in: [...MANAGEABLE_SUBSCRIPTION_STATUSES] },
    },
    orderBy: { createdAt: 'desc' },
    include: { plan: true },
  });
}

export async function hasBlockingSubscription(userId: string): Promise<boolean> {
  const sub = await prisma.subscription.findFirst({
    where: {
      userId,
      status: { in: [...CHECKOUT_BLOCKING_SUBSCRIPTION_STATUSES] },
    },
    select: { id: true },
  });
  return !!sub;
}

export async function isTrialEligible(userId: string): Promise<boolean> {
  const user = await getUserBillingContext(userId);
  if (!user || user.role !== UserRole.USER) return false;
  if (user.trialRedeemedAt) return false;

  const priorTrial = await prisma.subscription.findFirst({
    where: {
      userId,
      OR: [
        { status: 'TRIALING' },
        { trialStart: { not: null } },
      ],
    },
    select: { id: true },
  });
  if (priorTrial) return false;

  if (await hasBlockingSubscription(userId)) return false;
  return true;
}

export async function resolveTrialDays(
  regionId: string,
  extraTrialDays = 0,
): Promise<number> {
  const base = await getNumberSetting('billing.defaultTrialDays', regionId, DEFAULT_TRIAL_DAYS);
  const legacy = await getNumberSetting('trial.days', regionId, DEFAULT_TRIAL_DAYS);
  const days = Math.max(base, legacy);
  return Math.max(0, days + extraTrialDays);
}

export function mapStripeStatusToLocal(stripeStatus: string): string {
  switch (stripeStatus) {
    case 'trialing':
      return 'TRIALING';
    case 'active':
      return 'ACTIVE';
    case 'past_due':
      return 'PAST_DUE';
    case 'unpaid':
      return 'PAST_DUE';
    case 'incomplete':
    case 'incomplete_expired':
      return 'INCOMPLETE';
    case 'paused':
      return 'PAUSED';
    case 'canceled':
      return 'CANCELED';
    default:
      return 'INCOMPLETE';
  }
}

export function mapStripeStatusToBillingAccess(
  localStatus: string,
  opts: {
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: Date | null;
    trialEnd: Date | null;
    paymentActionRequiredAt: Date | null;
  },
): BillingAccessStatus {
  const now = new Date();

  if (localStatus === 'TRIALING') return BillingAccessStatus.TRIALING;
  if (localStatus === 'ACTIVE') return BillingAccessStatus.ACTIVE;
  if (localStatus === 'PAST_DUE') return BillingAccessStatus.PAST_DUE;
  if (localStatus === 'PAUSED') return BillingAccessStatus.PAUSED;
  if (localStatus === 'INCOMPLETE') return BillingAccessStatus.INCOMPLETE;

  if (localStatus === 'CANCELED') {
    const accessEnd = opts.currentPeriodEnd ?? opts.trialEnd;
    if (accessEnd && accessEnd.getTime() > now.getTime()) {
      return opts.trialEnd && opts.trialEnd.getTime() > now.getTime()
        ? BillingAccessStatus.TRIALING
        : BillingAccessStatus.ACTIVE;
    }
    return BillingAccessStatus.CANCELED;
  }

  if (opts.paymentActionRequiredAt) {
    return BillingAccessStatus.PAYMENT_ACTION_REQUIRED;
  }

  return BillingAccessStatus.BILLING_REQUIRED;
}

export async function hasDashboardAccess(userId: string): Promise<boolean> {
  const user = await getUserBillingContext(userId);
  if (!user) return false;
  if (user.isBillingExempt) return true;
  if (user.role !== UserRole.USER) return true;

  const status = user.billingAccessStatus;
  const sub = await getManageableSubscription(userId);

  if (status === BillingAccessStatus.TRIALING || status === BillingAccessStatus.ACTIVE) {
    if (!sub) return false;
    if (sub.stripeSubscriptionId && !sub.stripeDefaultPaymentMethodId) {
      return false;
    }
    return true;
  }

  if (status === BillingAccessStatus.PAST_DUE && user.regionId) {
    const graceDays = await getNumberSetting('billing.pastDueGraceDays', user.regionId, 3);
    const sub = await getManageableSubscription(userId);
    if (sub?.paymentFailedAt) {
      const graceEnd = new Date(sub.paymentFailedAt.getTime() + graceDays * 86_400_000);
      return graceEnd.getTime() > Date.now();
    }
    return graceDays > 0;
  }

  if (status === BillingAccessStatus.CANCELED) {
    const sub = await prisma.subscription.findFirst({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      select: { currentPeriodEnd: true, trialEnd: true },
    });
    const accessEnd = sub?.currentPeriodEnd ?? sub?.trialEnd ?? user.trialEndsAt;
    return !!accessEnd && accessEnd.getTime() > Date.now();
  }

  return false;
}

export function requiresBillingOnlyAccess(status: BillingAccessStatus): boolean {
  return BILLING_ONLY_STATUSES.includes(status);
}

export async function setUserBillingAccess(
  userId: string,
  status: BillingAccessStatus,
  trialFields?: {
    trialStartedAt?: Date | null;
    trialEndsAt?: Date | null;
    trialRedeemedAt?: Date | null;
  },
) {
  return prisma.user.update({
    where: { id: userId },
    data: {
      billingAccessStatus: status,
      ...(trialFields?.trialStartedAt !== undefined
        ? { trialStartedAt: trialFields.trialStartedAt }
        : {}),
      ...(trialFields?.trialEndsAt !== undefined ? { trialEndsAt: trialFields.trialEndsAt } : {}),
      ...(trialFields?.trialRedeemedAt !== undefined
        ? { trialRedeemedAt: trialFields.trialRedeemedAt }
        : {}),
    },
  });
}

export async function getOrCreateStripeCustomerId(params: {
  userId: string;
  email: string;
  regionId: string;
  stripe: import('./stripeClientService').StripeClient;
}): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: params.userId },
    select: { stripeCustomerId: true },
  });

  if (user?.stripeCustomerId) {
    return user.stripeCustomerId;
  }

  const subWithCustomer = await prisma.subscription.findFirst({
    where: { userId: params.userId, stripeCustomerId: { not: null } },
    select: { stripeCustomerId: true },
    orderBy: { createdAt: 'desc' },
  });
  if (subWithCustomer?.stripeCustomerId) {
    await prisma.user.update({
      where: { id: params.userId },
      data: { stripeCustomerId: subWithCustomer.stripeCustomerId },
    });
    return subWithCustomer.stripeCustomerId;
  }

  const customer = await params.stripe.customers.create({
    email: params.email,
    metadata: { userId: params.userId, regionId: params.regionId },
  });

  await prisma.user.update({
    where: { id: params.userId },
    data: { stripeCustomerId: customer.id },
  });

  return customer.id;
}
