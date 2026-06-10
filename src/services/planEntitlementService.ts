import { UserRole } from '@prisma/client';
import { prisma } from '../prismaClient';
import { hasDashboardAccess } from './billing/billingAccessService';
import { getEntitlement } from './entitlementService';

/**
 * Plan entitlement service.
 *
 * Resolves what an individual USER is allowed to do based on their active
 * subscription's Plan feature toggles / usage limits, and enforces those limits
 * server-side (frontend locks are only UX).
 *
 * Privileged roles (SUPER_ADMIN / REGIONAL_ADMIN) are never throttled here so
 * admin/sub-admin management flows are not blocked by user plan limits.
 *
 * Daily usage uses UTC day boundaries (the app does not store per-user timezone
 * reliably). `postsToday` counts LinkedIn publishes (`publishedAt`); other
 * counters use `createdAt >= startOfUtcDay()`.
 */

export type PlanLimitCode =
  | 'REWRITE_LIMIT_REACHED'
  | 'DAILY_POST_LIMIT_REACHED'
  | 'DAILY_BATCH_GENERATION_LIMIT_REACHED'
  | 'IMAGE_GENERATION_LOCKED'
  | 'DAILY_IMAGE_LIMIT_REACHED'
  | 'DASHBOARD_LOCKED';

// Thrown by the enforcement helpers; carries an HTTP status + machine code so
// route layers can return the exact { error, code } shape the spec requires.
export class PlanLimitError extends Error {
  status: number;
  code: PlanLimitCode;
  constructor(code: PlanLimitCode, message: string, status = 403) {
    super(message);
    this.name = 'PlanLimitError';
    this.code = code;
    this.status = status;
  }
}

export interface PlanEntitlements {
  hasActiveSubscription: boolean;
  planId: string | null;
  planName: string | null;
  fullDashboardUnlock: boolean;
  maxRewritesPerPost: number;
  dailyPostLimit: number;
  dailyBatchGenerationLimit: number;
  imageGenerationEnabled: boolean;
  dailyImageGenerationLimit: number;
  usage: {
    postsToday: number;
    batchGenerationsToday: number;
    imagesGeneratedToday: number;
  };
  remaining: {
    postsToday: number;
    batchGenerationsToday: number;
    imagesToday: number;
  };
}

// Large sentinel used to represent "effectively unlimited" for privileged roles
// (admins are never throttled), while keeping the response shape numeric.
const UNLIMITED = 999_999;

// Locked/free fallback for users with no active subscription.
const LOCKED_LIMITS = {
  fullDashboardUnlock: false,
  maxRewritesPerPost: 0,
  dailyPostLimit: 0,
  dailyBatchGenerationLimit: 0,
  imageGenerationEnabled: false,
  dailyImageGenerationLimit: 0,
};

function startOfUtcDay(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
}

type ActiveSubscriptionWithPlan = Awaited<ReturnType<typeof getActiveSubscriptionWithPlan>>;

/**
 * Most recent ACTIVE subscription for a user, with its Plan included.
 * Active = status ACTIVE and (endsAt is null OR endsAt > now).
 */
export async function getActiveSubscriptionWithPlan(userId: string) {
  const now = new Date();
  return prisma.subscription.findFirst({
    where: {
      userId,
      status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] },
      OR: [{ endsAt: null }, { endsAt: { gt: now } }, { currentPeriodEnd: { gt: now } }],
    },
    orderBy: { startsAt: 'desc' },
    include: { plan: true },
  });
}

// ---------------------------------------------------------------------------
// Daily usage counters (UTC day)
// ---------------------------------------------------------------------------

/**
 * Posts actually published to LinkedIn today.
 *
 * Counts `Post` rows with status PUBLISHED and `publishedAt` within the current
 * UTC day. Drafts, queued/review posts, and scheduling do NOT count — only a
 * successful LinkedIn publish increments this metric.
 */
async function countPostsToday(userId: string): Promise<number> {
  return prisma.post.count({
    where: {
      userId,
      status: 'PUBLISHED',
      publishedAt: { gte: startOfUtcDay() },
    },
  });
}

// Batch generation jobs started today.
async function countBatchGenerationsToday(userId: string): Promise<number> {
  return prisma.botGenerationJob.count({
    where: { userId, createdAt: { gte: startOfUtcDay() } },
  });
}

// Successfully generated images today.
async function countImagesToday(userId: string): Promise<number> {
  return prisma.imageGenerationUsage.count({
    where: { userId, createdAt: { gte: startOfUtcDay() } },
  });
}

// ---------------------------------------------------------------------------
// Entitlement resolution
// ---------------------------------------------------------------------------

async function isPrivileged(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  return !!user && user.role !== UserRole.USER;
}

/**
 * Full entitlement object for the user, including usage + remaining limits.
 * Shape matches the GET /entitlements/me contract.
 */
export async function getUserPlanEntitlements(userId: string): Promise<PlanEntitlements> {
  const [postsToday, batchGenerationsToday, imagesGeneratedToday] = await Promise.all([
    countPostsToday(userId),
    countBatchGenerationsToday(userId),
    countImagesToday(userId),
  ]);

  const usage = { postsToday, batchGenerationsToday, imagesGeneratedToday };

  // Privileged roles are never throttled -> report unlocked + unlimited.
  if (await isPrivileged(userId)) {
    return {
      hasActiveSubscription: false,
      planId: null,
      planName: null,
      fullDashboardUnlock: true,
      maxRewritesPerPost: UNLIMITED,
      dailyPostLimit: UNLIMITED,
      dailyBatchGenerationLimit: UNLIMITED,
      imageGenerationEnabled: true,
      dailyImageGenerationLimit: UNLIMITED,
      usage,
      remaining: {
        postsToday: UNLIMITED,
        batchGenerationsToday: UNLIMITED,
        imagesToday: UNLIMITED,
      },
    };
  }

  const sub = await getActiveSubscriptionWithPlan(userId);

  if (!sub || !sub.plan) {
    // Locked/free fallback: no active subscription.
    return {
      hasActiveSubscription: false,
      planId: null,
      planName: null,
      ...LOCKED_LIMITS,
      usage,
      remaining: { postsToday: 0, batchGenerationsToday: 0, imagesToday: 0 },
    };
  }

  const plan = sub.plan;
  const imageGenerationEnabled = plan.imageGenerationEnabled;
  // If image generation is disabled, effective daily limit is locked to 0.
  const effectiveImageLimit = imageGenerationEnabled ? plan.dailyImageGenerationLimit : 0;

  return {
    hasActiveSubscription: true,
    planId: plan.id,
    planName: plan.name,
    fullDashboardUnlock: plan.fullDashboardUnlock,
    maxRewritesPerPost: plan.maxRewritesPerPost,
    dailyPostLimit: plan.dailyPostLimit,
    dailyBatchGenerationLimit: plan.dailyBatchGenerationLimit,
    imageGenerationEnabled,
    dailyImageGenerationLimit: plan.dailyImageGenerationLimit,
    usage,
    remaining: {
      postsToday: Math.max(0, plan.dailyPostLimit - postsToday),
      batchGenerationsToday: Math.max(0, plan.dailyBatchGenerationLimit - batchGenerationsToday),
      imagesToday: Math.max(0, effectiveImageLimit - imagesGeneratedToday),
    },
  };
}

// ---------------------------------------------------------------------------
// Enforcement helpers (throw PlanLimitError when blocked)
// ---------------------------------------------------------------------------

/**
 * Full dashboard gate. Preserves the existing free-trial behaviour: trial users
 * (no subscription but inside the trial window) keep access. Only users with an
 * active plan that has fullDashboardUnlock=false, or fully expired users with no
 * subscription, are blocked.
 */
export async function requireFullDashboardAccess(userId: string): Promise<void> {
  if (await isPrivileged(userId)) return;

  const sub = await getActiveSubscriptionWithPlan(userId);
  if (sub && sub.plan) {
    if (!sub.plan.fullDashboardUnlock) {
      throw new PlanLimitError(
        'DASHBOARD_LOCKED',
        'Your current plan does not unlock the full dashboard.',
      );
    }
    return;
  }

  if (!(await hasDashboardAccess(userId))) {
    throw new PlanLimitError(
      'DASHBOARD_LOCKED',
      'Complete billing setup to unlock the full dashboard.',
    );
  }

  const entitlement = await getEntitlement(userId);
  if (entitlement.status === 'EXPIRED') {
    throw new PlanLimitError(
      'DASHBOARD_LOCKED',
      'Your current plan does not unlock the full dashboard.',
    );
  }
}

/**
 * Rewrite gate: post must belong to the user and its rewriteCount must be below
 * the plan's maxRewritesPerPost.
 */
export async function canRewritePost(
  userId: string,
  postId: string,
): Promise<{ rewriteCount: number; maxRewritesPerPost: number }> {
  const post = await prisma.post.findUnique({
    where: { id: postId },
    select: { userId: true, rewriteCount: true },
  });
  if (!post || post.userId !== userId) {
    // Ownership is validated by the caller; surface a not-found-style 404.
    throw new PlanLimitError('REWRITE_LIMIT_REACHED', 'Post not found', 404);
  }

  if (await isPrivileged(userId)) {
    return { rewriteCount: post.rewriteCount, maxRewritesPerPost: UNLIMITED };
  }

  const ent = await getUserPlanEntitlements(userId);
  if (post.rewriteCount >= ent.maxRewritesPerPost) {
    throw new PlanLimitError(
      'REWRITE_LIMIT_REACHED',
      'Rewrite limit reached for your current plan.',
    );
  }
  return { rewriteCount: post.rewriteCount, maxRewritesPerPost: ent.maxRewritesPerPost };
}

/**
 * LinkedIn publish gate for subscribed users.
 *
 * `additionalCount` is how many posts this action will publish to LinkedIn
 * (almost always 1). Only enforced when the user has an active subscription
 * with a plan; trial/expired users are gated separately by `canPublish()`.
 */
export async function canPublishToLinkedIn(
  userId: string,
  additionalCount = 1,
): Promise<void> {
  if (await isPrivileged(userId)) return;

  const sub = await getActiveSubscriptionWithPlan(userId);
  if (!sub?.plan) return; // trial/expired: handled by entitlementService.canPublish

  const published = await countPostsToday(userId);
  if (published + additionalCount > sub.plan.dailyPostLimit) {
    throw new PlanLimitError(
      'DAILY_POST_LIMIT_REACHED',
      'Daily post limit reached for your current plan.',
    );
  }
}

/** @deprecated Use canPublishToLinkedIn — daily limit is LinkedIn publishes only. */
export const canCreateOrSchedulePost = canPublishToLinkedIn;

// Daily batch generation gate.
export async function canStartBatchGeneration(userId: string): Promise<void> {
  if (await isPrivileged(userId)) return;

  const ent = await getUserPlanEntitlements(userId);
  if (ent.usage.batchGenerationsToday + 1 > ent.dailyBatchGenerationLimit) {
    throw new PlanLimitError(
      'DAILY_BATCH_GENERATION_LIMIT_REACHED',
      'Daily batch generation limit reached for your current plan.',
    );
  }
}

/**
 * Image generation gate: plan must enable image generation and the user must be
 * under their daily image limit.
 */
export async function canUseImageGeneration(userId: string): Promise<void> {
  if (await isPrivileged(userId)) return;

  const ent = await getUserPlanEntitlements(userId);
  if (!ent.imageGenerationEnabled) {
    throw new PlanLimitError(
      'IMAGE_GENERATION_LOCKED',
      'Image generation is not included in your current plan.',
    );
  }
  if (ent.usage.imagesGeneratedToday >= ent.dailyImageGenerationLimit) {
    throw new PlanLimitError(
      'DAILY_IMAGE_LIMIT_REACHED',
      'Daily image generation limit reached for your current plan.',
    );
  }
}

/**
 * Non-throwing variant for batch/secondary flows that should skip image
 * generation gracefully rather than fail the whole operation.
 */
export async function isImageGenerationAllowed(userId: string): Promise<boolean> {
  try {
    await canUseImageGeneration(userId);
    return true;
  } catch {
    return false;
  }
}

const MANUAL_AI_OPS_DAILY_MULTIPLIER = 5;

async function countManualAiOpsToday(userId: string): Promise<number> {
  return prisma.manualAiRewriteUsage.count({
    where: { userId, createdAt: { gte: startOfUtcDay() } },
  });
}

/**
 * Daily gate for unsaved manual-composer AI generate/rewrite operations.
 * Saved posts use per-post rewriteCount via canRewritePost().
 */
export async function canUseManualAiOperation(userId: string): Promise<{
  usedToday: number;
  dailyLimit: number;
}> {
  if (await isPrivileged(userId)) {
    return { usedToday: 0, dailyLimit: UNLIMITED };
  }

  const ent = await getUserPlanEntitlements(userId);
  const dailyLimit = Math.max(1, ent.maxRewritesPerPost * MANUAL_AI_OPS_DAILY_MULTIPLIER);
  const usedToday = await countManualAiOpsToday(userId);
  if (usedToday >= dailyLimit) {
    throw new PlanLimitError(
      'REWRITE_LIMIT_REACHED',
      'Daily AI assistant limit reached for your current plan.',
    );
  }
  return { usedToday, dailyLimit };
}

/** Record a successful manual-composer AI operation (generate or unsaved rewrite). */
export async function recordManualAiOperation(
  userId: string,
  kind: 'generate' | 'rewrite_unsaved',
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { regionId: true },
  });
  await prisma.manualAiRewriteUsage.create({
    data: { userId, regionId: user?.regionId ?? null, kind },
  });
}

/** Record one successful image generation (drives the daily image counter). */
export async function recordImageGeneration(userId: string): Promise<void> {
  // Privileged roles' usage is recorded too (harmless) but never enforced.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { regionId: true },
  });
  await prisma.imageGenerationUsage.create({
    data: { userId, regionId: user?.regionId ?? null },
  });
}

export type { ActiveSubscriptionWithPlan };
