import { BillingAccessStatus, UserRole } from '@prisma/client';
import { prisma } from '../prismaClient';
import { hasDashboardAccess } from './billing/billingAccessService';
import { reconcileUserStripeSubscriptionForAccess } from './billing/billingReconciliationService';
import { getNumberSetting } from './settingsService';
import { getUtcMonthWindow } from '../utils/monthlyLimitWindow';

export const TRIAL_DAYS = 14;
export const TRIAL_MONTHLY_PUBLISH_LIMIT = 30;
export const TRIAL_MONTHLY_PUBLISH_SETTING_KEY = 'trial.monthlyPublishLimit';

export type EntitlementStatus = 'ADMIN' | 'SUBSCRIBED' | 'TRIAL' | 'EXPIRED';

export interface Entitlement {
  status: EntitlementStatus;
  trialEndsAt: Date | null;
  daysLeft: number;
  monthlyPublishLimit: number | null;
}

export function getTrialMonthlyPublishLimit(
  regionId: string | null,
  loader = getNumberSetting,
): Promise<number> {
  return loader(
    TRIAL_MONTHLY_PUBLISH_SETTING_KEY,
    regionId,
    TRIAL_MONTHLY_PUBLISH_LIMIT,
  );
}

export async function getEntitlement(userId: string): Promise<Entitlement> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      role: true,
      regionId: true,
      trialEndsAt: true,
      billingAccessStatus: true,
    },
  });

  if (!user) {
    return { status: 'EXPIRED', trialEndsAt: null, daysLeft: 0, monthlyPublishLimit: 0 };
  }

  if (user.role !== UserRole.USER) {
    return { status: 'ADMIN', trialEndsAt: null, daysLeft: 0, monthlyPublishLimit: null };
  }

  const activeSub = await prisma.subscription.findFirst({
    where: { userId, status: 'ACTIVE' },
    select: { id: true },
  });
  if (activeSub) {
    return { status: 'SUBSCRIBED', trialEndsAt: null, daysLeft: 0, monthlyPublishLimit: null };
  }

  const now = new Date();
  const trialing =
    user.billingAccessStatus === BillingAccessStatus.TRIALING &&
    user.trialEndsAt &&
    user.trialEndsAt.getTime() > now.getTime();

  if (!trialing) {
    const reconciled = await reconcileUserStripeSubscriptionForAccess(userId, 'entitlement');
    if (reconciled?.status === 'ACTIVE') {
      return { status: 'SUBSCRIBED', trialEndsAt: null, daysLeft: 0, monthlyPublishLimit: null };
    }
  }

  if (trialing) {
    const daysLeft = Math.ceil((user.trialEndsAt!.getTime() - now.getTime()) / 86_400_000);
    return {
      status: 'TRIAL',
      trialEndsAt: user.trialEndsAt,
      daysLeft,
      monthlyPublishLimit: await getTrialMonthlyPublishLimit(user.regionId),
    };
  }

  return { status: 'EXPIRED', trialEndsAt: user.trialEndsAt ?? null, daysLeft: 0, monthlyPublishLimit: 0 };
}

export async function publishedThisMonth(
  userId: string,
  now: Date = new Date(),
  db: Pick<typeof prisma, 'post'> = prisma,
): Promise<number> {
  const { start, end } = getUtcMonthWindow(now);
  return db.post.count({
    where: { userId, status: 'PUBLISHED', publishedAt: { gte: start, lt: end } },
  });
}

export interface GateResult {
  allowed: boolean;
  reason?: string;
  entitlement: Entitlement;
}

export async function canPublish(userId: string): Promise<GateResult> {
  const entitlement = await getEntitlement(userId);

  if (entitlement.status === 'ADMIN' || entitlement.status === 'SUBSCRIBED') {
    return { allowed: true, entitlement };
  }

  if (!(await hasDashboardAccess(userId))) {
    return {
      allowed: false,
      reason: 'Complete billing setup to keep publishing.',
      entitlement,
    };
  }

  if (entitlement.status === 'EXPIRED') {
    return {
      allowed: false,
      reason: 'Your free trial has ended. Subscribe to a plan to keep publishing.',
      entitlement,
    };
  }

  const count = await publishedThisMonth(userId);
  const monthlyLimit = entitlement.monthlyPublishLimit ?? TRIAL_MONTHLY_PUBLISH_LIMIT;
  // TODO: Concurrent publishes can pass this check before either external
  // LinkedIn operation succeeds and updates Post; do not transact over that call.
  if (count >= monthlyLimit) {
    return {
      allowed: false,
      reason: `Free trial allows ${monthlyLimit} published posts per month. Subscribe to continue publishing.`,
      entitlement,
    };
  }

  return { allowed: true, entitlement };
}

export async function canGenerate(userId: string): Promise<GateResult> {
  const entitlement = await getEntitlement(userId);

  if (!(await hasDashboardAccess(userId))) {
    await logGenerationDenied(userId, 'dashboard_access_missing');
    return {
      allowed: false,
      reason: 'Complete billing setup to keep generating posts.',
      entitlement,
    };
  }

  if (entitlement.status === 'EXPIRED') {
    await logGenerationDenied(userId, 'trial_expired');
    return {
      allowed: false,
      reason: 'Your free trial has ended. Subscribe to a plan to keep generating posts.',
      entitlement,
    };
  }

  return { allowed: true, entitlement };
}

async function logGenerationDenied(userId: string, reason: string) {
  try {
    const [user, sub] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { billingAccessStatus: true, trialEndsAt: true },
      }),
      prisma.subscription.findFirst({
        where: { userId },
        orderBy: { updatedAt: 'desc' },
        select: { status: true, planId: true, plan: { select: { name: true, code: true } } },
      }),
    ]);

    console.warn('[entitlement] generation denied', {
      userId,
      reason,
      localSubscriptionStatus: sub?.status ?? null,
      billingAccessStatus: user?.billingAccessStatus ?? null,
      trialEndsAt: user?.trialEndsAt?.toISOString() ?? null,
      planId: sub?.planId ?? null,
      planName: sub?.plan?.name ?? null,
      planCode: sub?.plan?.code ?? null,
    });
  } catch (err) {
    console.warn('[entitlement] generation denied; failed to load context', {
      userId,
      reason,
      message: err instanceof Error ? err.message : 'context load failed',
    });
  }
}
