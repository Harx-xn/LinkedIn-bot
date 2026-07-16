import { UserRole } from '@prisma/client';
import { prisma } from '../../prismaClient';
import type {
  PlanRelationship,
  RecommendedBillingAction,
  SubscriptionDisplayStatus,
} from '../../types/billing';
import {
  getManageableSubscription,
  hasDashboardAccess,
  isTrialEligible,
} from './billingAccessService';
import { reconcileUserStripeSubscriptionForAccess } from './billingReconciliationService';
import { isStripeConfigured } from './stripeClientService';

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function daysRemaining(endsAt: Date | null | undefined): number | null {
  if (!endsAt) return null;
  const ms = endsAt.getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

function mapSubStatus(status: string | null): SubscriptionDisplayStatus {
  if (!status) return null;
  const allowed = [
    'TRIALING',
    'ACTIVE',
    'PAST_DUE',
    'PAYMENT_ACTION_REQUIRED',
    'INCOMPLETE',
    'PAUSED',
    'CANCELED',
  ];
  return allowed.includes(status) ? (status as SubscriptionDisplayStatus) : null;
}

function planRelationship(
  currentPrice: number,
  targetPrice: number,
  isCurrent: boolean,
): PlanRelationship {
  if (isCurrent) return 'CURRENT';
  if (targetPrice > currentPrice) return 'UPGRADE';
  if (targetPrice < currentPrice) return 'DOWNGRADE';
  return 'AVAILABLE';
}

async function resolveStripeConfigured(regionId: string | null): Promise<boolean> {
  if (!regionId) return false;
  try {
    return await isStripeConfigured(regionId);
  } catch {
    return false;
  }
}

function resolveRecommendedAction(params: {
  trialEligible: boolean;
  billingRequired: boolean;
  subscriptionStatus: SubscriptionDisplayStatus;
  cancelAtPeriodEnd: boolean;
  paymentActionRequired: boolean;
}): RecommendedBillingAction {
  if (params.paymentActionRequired) return 'COMPLETE_AUTHENTICATION';
  if (params.billingRequired && params.trialEligible) return 'START_TRIAL';
  if (params.billingRequired) return 'SUBSCRIBE';
  if (params.subscriptionStatus === 'PAST_DUE') return 'UPDATE_PAYMENT_METHOD';
  if (params.cancelAtPeriodEnd) return 'REACTIVATE';
  if (params.subscriptionStatus) return 'MANAGE';
  return null;
}

export async function getBillingMe(userId: string) {
  const userSelect = {
    role: true,
    regionId: true,
    billingAccessStatus: true,
    trialStartedAt: true,
    trialEndsAt: true,
    trialRedeemedAt: true,
    stripeCustomerId: true,
    isBillingExempt: true,
  } as const;

  let user = await prisma.user.findUnique({
    where: { id: userId },
    select: userSelect,
  });

  if (!user) {
    throw new Error('User not found');
  }

  if (user.role !== UserRole.USER || user.isBillingExempt) {
    return {
      billingExempt: user.isBillingExempt,
      unlimited: true,
      billingRequired: false,
      dashboardAccess: true,
      trialEligible: false,
      stripeConfigured: false,
      trial: { active: false, startedAt: null, endsAt: null, daysRemaining: null },
      subscription: {
        id: null,
        planId: null,
        planName: null,
        planCode: null,
        price: null,
        currency: null,
        billingCycle: null,
        status: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        cancellationEffectiveAt: null,
        paymentMethodPresent: false,
      },
      availablePlans: [],
      recommendedAction: null,
    };
  }

  const reconciled = await reconcileUserStripeSubscriptionForAccess(userId, 'billing-me');
  if (reconciled) {
    user = await prisma.user.findUnique({
      where: { id: userId },
      select: userSelect,
    });
    if (!user) {
      throw new Error('User not found');
    }
  }

  const [dashboardAccess, trialEligible, sub, stripeConfigured] = await Promise.all([
    hasDashboardAccess(userId),
    isTrialEligible(userId),
    getManageableSubscription(userId),
    resolveStripeConfigured(user.regionId),
  ]);

  const billingRequired =
    user.billingAccessStatus === 'BILLING_REQUIRED' ||
    user.billingAccessStatus === 'TRIAL_PENDING' ||
    user.billingAccessStatus === 'INCOMPLETE';

  const trialActive =
    user.billingAccessStatus === 'TRIALING' &&
    !!user.trialEndsAt &&
    user.trialEndsAt.getTime() > Date.now();

  const plans = user.regionId
    ? await prisma.plan.findMany({
        where: { regionId: user.regionId, isActive: true },
        orderBy: { price: 'asc' },
      })
    : [];

  const currentPrice = sub?.plan?.price ?? 0;
  const availablePlans = plans.map((p) => ({
    id: p.id,
    name: p.name,
    code: p.code,
    price: p.price,
    currency: p.currency,
    billingCycle: p.billingCycle,
    relationship: planRelationship(currentPrice, p.price, sub?.planId === p.id),
    stripePriceIdPresent: Boolean(p.stripePriceId),
    fullDashboardUnlock: p.fullDashboardUnlock,
    maxRewritesPerPost: p.maxRewritesPerPost,
    dailyPostLimit: p.dailyPostLimit,
    dailyBatchGenerationLimit: p.dailyBatchGenerationLimit,
    imageGenerationEnabled: p.imageGenerationEnabled,
    dailyImageGenerationLimit: p.dailyImageGenerationLimit,
    monthlyPostLimit: p.monthlyPostLimit,
    monthlyBatchGenerationLimit: p.monthlyBatchGenerationLimit,
    monthlyImageGenerationLimit: p.monthlyImageGenerationLimit,
    monthlyManualAiOperationLimit: p.monthlyManualAiOperationLimit,
  }));

  const subStatus = mapSubStatus(sub?.status ?? null);
  const cancelAtPeriodEnd = sub?.cancelAtPeriodEnd ?? false;

  return {
    billingExempt: false,
    unlimited: false,
    billingRequired,
    dashboardAccess,
    trialEligible,
    stripeConfigured,
    stripeCustomerPresent: Boolean(user.stripeCustomerId || sub?.stripeCustomerId),
    portalAvailable: Boolean(user.stripeCustomerId || sub?.stripeCustomerId),
    trial: {
      active: trialActive,
      startedAt: iso(user.trialStartedAt),
      endsAt: iso(user.trialEndsAt),
      daysRemaining: trialActive ? daysRemaining(user.trialEndsAt) : null,
    },
    subscription: {
      id: sub?.id ?? null,
      planId: sub?.planId ?? null,
      planName: sub?.plan?.name ?? null,
      planCode: sub?.plan?.code ?? null,
      price: sub?.plan?.price ?? null,
      currency: sub?.plan?.currency ?? null,
      billingCycle: sub?.plan?.billingCycle ?? null,
      status: subStatus,
      currentPeriodStart: iso(sub?.currentPeriodStart),
      currentPeriodEnd: iso(sub?.currentPeriodEnd),
      cancelAtPeriodEnd,
      cancellationEffectiveAt: cancelAtPeriodEnd ? iso(sub?.currentPeriodEnd) : null,
      paymentMethodPresent: !!sub?.stripeDefaultPaymentMethodId,
    },
    availablePlans,
    recommendedAction: resolveRecommendedAction({
      trialEligible,
      billingRequired,
      subscriptionStatus: subStatus,
      cancelAtPeriodEnd,
      paymentActionRequired: user.billingAccessStatus === 'PAYMENT_ACTION_REQUIRED',
    }),
  };
}
