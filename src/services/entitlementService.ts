import { BillingAccessStatus, UserRole } from '@prisma/client';
import { prisma } from '../prismaClient';
import { hasDashboardAccess } from './billing/billingAccessService';
import { getNumberSetting } from './settingsService';

export const TRIAL_DAYS = 14;
export const TRIAL_DAILY_PUBLISH_LIMIT = 1;

export type EntitlementStatus = 'ADMIN' | 'SUBSCRIBED' | 'TRIAL' | 'EXPIRED';

export interface Entitlement {
  status: EntitlementStatus;
  trialEndsAt: Date | null;
  daysLeft: number;
  dailyPublishLimit: number | null;
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
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
    return { status: 'EXPIRED', trialEndsAt: null, daysLeft: 0, dailyPublishLimit: 0 };
  }

  if (user.role !== UserRole.USER) {
    return { status: 'ADMIN', trialEndsAt: null, daysLeft: 0, dailyPublishLimit: null };
  }

  const activeSub = await prisma.subscription.findFirst({
    where: { userId, status: 'ACTIVE' },
    select: { id: true },
  });
  if (activeSub) {
    return { status: 'SUBSCRIBED', trialEndsAt: null, daysLeft: 0, dailyPublishLimit: null };
  }

  const now = new Date();
  const trialing =
    user.billingAccessStatus === BillingAccessStatus.TRIALING &&
    user.trialEndsAt &&
    user.trialEndsAt.getTime() > now.getTime();

  if (trialing) {
    const daysLeft = Math.ceil((user.trialEndsAt!.getTime() - now.getTime()) / 86_400_000);
    return {
      status: 'TRIAL',
      trialEndsAt: user.trialEndsAt,
      daysLeft,
      dailyPublishLimit: await getNumberSetting(
        'trial.dailyPublishLimit',
        user.regionId,
        TRIAL_DAILY_PUBLISH_LIMIT,
      ),
    };
  }

  return { status: 'EXPIRED', trialEndsAt: user.trialEndsAt ?? null, daysLeft: 0, dailyPublishLimit: 0 };
}

export async function publishedToday(userId: string): Promise<number> {
  return prisma.post.count({
    where: { userId, status: 'PUBLISHED', publishedAt: { gte: startOfToday() } },
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

  const count = await publishedToday(userId);
  const dailyLimit = entitlement.dailyPublishLimit ?? TRIAL_DAILY_PUBLISH_LIMIT;
  if (count >= dailyLimit) {
    return {
      allowed: false,
      reason: `Free trial allows ${dailyLimit} published post per day. Try again tomorrow or subscribe.`,
      entitlement,
    };
  }

  return { allowed: true, entitlement };
}

export async function canGenerate(userId: string): Promise<GateResult> {
  const entitlement = await getEntitlement(userId);

  if (!(await hasDashboardAccess(userId))) {
    return {
      allowed: false,
      reason: 'Complete billing setup to keep generating posts.',
      entitlement,
    };
  }

  if (entitlement.status === 'EXPIRED') {
    return {
      allowed: false,
      reason: 'Your free trial has ended. Subscribe to a plan to keep generating posts.',
      entitlement,
    };
  }

  return { allowed: true, entitlement };
}
