import { UserRole } from '@prisma/client';
import { prisma } from '../prismaClient';

// 14-day free trial, capped at 1 published post per calendar day.
export const TRIAL_DAYS = 14;
export const TRIAL_DAILY_PUBLISH_LIMIT = 1;

export type EntitlementStatus = 'ADMIN' | 'SUBSCRIBED' | 'TRIAL' | 'EXPIRED';

export interface Entitlement {
  status: EntitlementStatus;
  trialEndsAt: Date | null;
  daysLeft: number; // whole days remaining in trial (0 unless TRIAL)
  dailyPublishLimit: number | null; // null = unlimited
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// Determine what a user is currently entitled to:
//  - ADMIN: privileged roles are never throttled
//  - SUBSCRIBED: has an ACTIVE subscription -> unlimited
//  - TRIAL: no active sub but still inside the trial window -> 1 post/day
//  - EXPIRED: no active sub and the trial window has passed -> blocked
export async function getEntitlement(userId: string): Promise<Entitlement> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, trialEndsAt: true },
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
  if (user.trialEndsAt && user.trialEndsAt.getTime() > now.getTime()) {
    const daysLeft = Math.ceil((user.trialEndsAt.getTime() - now.getTime()) / 86_400_000);
    return {
      status: 'TRIAL',
      trialEndsAt: user.trialEndsAt,
      daysLeft,
      dailyPublishLimit: TRIAL_DAILY_PUBLISH_LIMIT,
    };
  }

  return { status: 'EXPIRED', trialEndsAt: user.trialEndsAt ?? null, daysLeft: 0, dailyPublishLimit: 0 };
}

// Posts already published today (used to enforce the trial daily cap).
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

// Can this user publish another post right now?
export async function canPublish(userId: string): Promise<GateResult> {
  const entitlement = await getEntitlement(userId);

  if (entitlement.status === 'ADMIN' || entitlement.status === 'SUBSCRIBED') {
    return { allowed: true, entitlement };
  }

  if (entitlement.status === 'EXPIRED') {
    return {
      allowed: false,
      reason: 'Your free trial has ended. Subscribe to a plan to keep publishing.',
      entitlement,
    };
  }

  // TRIAL: enforce the daily publish cap.
  const count = await publishedToday(userId);
  if (count >= TRIAL_DAILY_PUBLISH_LIMIT) {
    return {
      allowed: false,
      reason: `Free trial allows ${TRIAL_DAILY_PUBLISH_LIMIT} published post per day. Try again tomorrow or subscribe.`,
      entitlement,
    };
  }

  return { allowed: true, entitlement };
}

// Can this user generate/queue content? Allowed on trial; blocked once expired.
export async function canGenerate(userId: string): Promise<GateResult> {
  const entitlement = await getEntitlement(userId);

  if (entitlement.status === 'EXPIRED') {
    return {
      allowed: false,
      reason: 'Your free trial has ended. Subscribe to a plan to keep generating posts.',
      entitlement,
    };
  }

  return { allowed: true, entitlement };
}
