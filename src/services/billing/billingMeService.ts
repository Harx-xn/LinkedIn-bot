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
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      role: true,
      regionId: true,
      billingAccessStatus: true,
      trialStartedAt: true,
      trialEndsAt: true,
      trialRedeemedAt: true,
    },
  });

  if (!user) {
    throw new Error('User not found');
  }

  if (user.role !== UserRole.USER) {
    return {
      billingRequired: false,
      dashboardAccess: true,
      trialEligible: false,
      trial: { active: false, startedAt: null, endsAt: null, daysRemaining: null },
      subscription: {
        id: null,
        planId: null,
        planName: null,
        planCode: null,
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

  const [dashboardAccess, trialEligible, sub] = await Promise.all([
    hasDashboardAccess(userId),
    isTrialEligible(userId),
    getManageableSubscription(userId),
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
  }));

  const subStatus = mapSubStatus(sub?.status ?? null);
  const cancelAtPeriodEnd = sub?.cancelAtPeriodEnd ?? false;

  return {
    billingRequired,
    dashboardAccess,
    trialEligible,
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
