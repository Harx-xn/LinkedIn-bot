import { UserRole } from '@prisma/client';
import type { Plan } from '@prisma/client';
import { prisma } from '../prismaClient';
import { hasDashboardAccess } from './billing/billingAccessService';
import { getEntitlement } from './entitlementService';
import { getUtcMonthWindow } from '../utils/monthlyLimitWindow';
import { getEffectiveAccess } from './billing/billingExemptionService';

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
 * Monthly usage uses UTC calendar-month boundaries. Published-post usage is
 * derived from `publishedAt`; the other quotas use their usage row's
 * `createdAt` timestamp.
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
  usagePeriod: 'MONTHLY';
  periodStart: Date;
  periodEnd: Date;
  hasActiveSubscription: boolean;
  unlimited: boolean;
  billingExempt: boolean;
  accessSource: 'BILLING_EXEMPT' | 'PRIVILEGED_ROLE' | 'STANDARD';
  planId: string | null;
  planName: string | null;
  fullDashboardUnlock: boolean;
  maxRewritesPerPost: number;
  monthlyPostLimit: number;
  monthlyBatchGenerationLimit: number;
  imageGenerationEnabled: boolean;
  monthlyImageGenerationLimit: number;
  monthlyManualAiOperationLimit: number;
  /** @deprecated Temporary response aliases for older frontend clients. */
  dailyPostLimit: number;
  dailyBatchGenerationLimit: number;
  dailyImageGenerationLimit: number;
  usage: {
    postsThisMonth: number;
    batchGenerationsThisMonth: number;
    imagesGeneratedThisMonth: number;
    manualAiOperationsThisMonth: number;
    /** @deprecated Temporary aliases containing monthly usage. */
    postsToday: number;
    batchGenerationsToday: number;
    imagesGeneratedToday: number;
  };
  limits: {
    posts: number;
    batchGenerations: number;
    images: number;
    manualAiOperations: number;
  };
  remaining: {
    posts: number;
    batchGenerations: number;
    images: number;
    manualAiOperations: number;
    /** @deprecated Temporary aliases containing monthly remaining usage. */
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
  monthlyPostLimit: 0,
  monthlyBatchGenerationLimit: 0,
  monthlyImageGenerationLimit: 0,
  monthlyManualAiOperationLimit: 0,
  // Temporary frontend compatibility aliases.
  dailyPostLimit: 0,
  dailyBatchGenerationLimit: 0,
  imageGenerationEnabled: false,
  dailyImageGenerationLimit: 0,
};

type ActiveSubscriptionWithPlan = Awaited<ReturnType<typeof getActiveSubscriptionWithPlan>>;
type SubscriptionPlan = NonNullable<ActiveSubscriptionWithPlan>['plan'];

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

async function getHighestActivePlanForRegion(regionId: string | null): Promise<Plan | null> {
  if (!regionId) return null;
  return prisma.plan.findFirst({
    where: { regionId, isActive: true },
    orderBy: [{ price: 'desc' }, { name: 'asc' }],
  });
}

async function getEffectiveEntitlementPlan(
  sub: ActiveSubscriptionWithPlan,
): Promise<SubscriptionPlan | Plan | null> {
  if (!sub?.plan) return null;
  if (sub.status !== 'TRIALING') return sub.plan;
  return (await getHighestActivePlanForRegion(sub.regionId)) ?? sub.plan;
}

// ---------------------------------------------------------------------------
// Monthly usage counters (UTC calendar month)
// ---------------------------------------------------------------------------

/**
 * Posts actually published to LinkedIn during the current UTC month.
 *
 * Counts `Post` rows with status PUBLISHED and `publishedAt` within the current
 * UTC month. Drafts, queued/review posts, and scheduling do NOT count; only a
 * successful LinkedIn publish increments this metric.
 */
async function countPostsThisMonth(userId: string, start: Date, end: Date, db = prisma): Promise<number> {
  return db.post.count({
    where: {
      userId,
      status: 'PUBLISHED',
      publishedAt: { gte: start, lt: end },
    },
  });
}

// Batch jobs count when their row is created, including jobs that later fail.
async function countBatchGenerationsThisMonth(userId: string, start: Date, end: Date, db = prisma): Promise<number> {
  return db.botGenerationJob.count({
    where: { userId, createdAt: { gte: start, lt: end } },
  });
}

// Successfully generated images this month.
async function countImagesThisMonth(userId: string, start: Date, end: Date, db = prisma): Promise<number> {
  return db.imageGenerationUsage.count({
    where: { userId, createdAt: { gte: start, lt: end } },
  });
}

async function countManualAiOpsThisMonth(userId: string, start: Date, end: Date, db = prisma): Promise<number> {
  return db.manualAiRewriteUsage.count({
    where: { userId, createdAt: { gte: start, lt: end } },
  });
}

export async function getMonthlyEntitlementUsage(
  userId: string,
  now: Date = new Date(),
  db: Pick<
    typeof prisma,
    'post' | 'botGenerationJob' | 'imageGenerationUsage' | 'manualAiRewriteUsage'
  > = prisma,
) {
  const { start: periodStart, end: periodEnd } = getUtcMonthWindow(now);
  const [postsThisMonth, batchGenerationsThisMonth, imagesGeneratedThisMonth, manualAiOperationsThisMonth] =
    await Promise.all([
      countPostsThisMonth(userId, periodStart, periodEnd, db as typeof prisma),
      countBatchGenerationsThisMonth(userId, periodStart, periodEnd, db as typeof prisma),
      countImagesThisMonth(userId, periodStart, periodEnd, db as typeof prisma),
      countManualAiOpsThisMonth(userId, periodStart, periodEnd, db as typeof prisma),
    ]);

  return {
    periodStart,
    periodEnd,
    postsThisMonth,
    batchGenerationsThisMonth,
    imagesGeneratedThisMonth,
    manualAiOperationsThisMonth,
  };
}

export function getMonthlyLimits(plan: SubscriptionPlan | Plan) {
  return {
    posts: plan.monthlyPostLimit ?? plan.dailyPostLimit * 30,
    batchGenerations:
      plan.monthlyBatchGenerationLimit ?? plan.dailyBatchGenerationLimit * 30,
    images: plan.monthlyImageGenerationLimit ?? plan.dailyImageGenerationLimit * 30,
    manualAiOperations:
      plan.monthlyManualAiOperationLimit ?? Math.max(1, plan.maxRewritesPerPost * 150),
  };
}

// ---------------------------------------------------------------------------
// Entitlement resolution
// ---------------------------------------------------------------------------

async function isPrivileged(userId: string): Promise<boolean> {
  return (await getEffectiveAccess(userId)).unlimited;
}

/**
 * Full entitlement object for the user, including usage + remaining limits.
 * Shape matches the GET /entitlements/me contract.
 */
export async function getUserPlanEntitlements(userId: string): Promise<PlanEntitlements> {
  const effectiveAccess = await getEffectiveAccess(userId);
  const {
    periodStart,
    periodEnd,
    postsThisMonth,
    batchGenerationsThisMonth,
    imagesGeneratedThisMonth,
    manualAiOperationsThisMonth,
  } = await getMonthlyEntitlementUsage(userId);

  const usage = {
    postsThisMonth,
    batchGenerationsThisMonth,
    imagesGeneratedThisMonth,
    manualAiOperationsThisMonth,
    postsToday: postsThisMonth,
    batchGenerationsToday: batchGenerationsThisMonth,
    imagesGeneratedToday: imagesGeneratedThisMonth,
  };
  const responseBase = {
    usagePeriod: 'MONTHLY' as const,
    periodStart,
    periodEnd,
    unlimited: effectiveAccess.unlimited,
    billingExempt: effectiveAccess.billingExempt,
    accessSource: effectiveAccess.accessSource,
  };
  const makeRemaining = (limits: { posts: number; batchGenerations: number; images: number; manualAiOperations: number }) => ({
    posts: Math.max(0, limits.posts - postsThisMonth),
    batchGenerations: Math.max(0, limits.batchGenerations - batchGenerationsThisMonth),
    images: Math.max(0, limits.images - imagesGeneratedThisMonth),
    manualAiOperations: Math.max(0, limits.manualAiOperations - manualAiOperationsThisMonth),
    postsToday: Math.max(0, limits.posts - postsThisMonth),
    batchGenerationsToday: Math.max(0, limits.batchGenerations - batchGenerationsThisMonth),
    imagesToday: Math.max(0, limits.images - imagesGeneratedThisMonth),
  });

  // Privileged roles are never throttled -> report unlocked + unlimited.
  if (effectiveAccess.unlimited) {
    const limits = {
      posts: UNLIMITED,
      batchGenerations: UNLIMITED,
      images: UNLIMITED,
      manualAiOperations: UNLIMITED,
    };
    return {
      ...responseBase,
      hasActiveSubscription: false,
      planId: null,
      planName: null,
      fullDashboardUnlock: true,
      maxRewritesPerPost: UNLIMITED,
      monthlyPostLimit: UNLIMITED,
      monthlyBatchGenerationLimit: UNLIMITED,
      monthlyImageGenerationLimit: UNLIMITED,
      monthlyManualAiOperationLimit: UNLIMITED,
      dailyPostLimit: UNLIMITED,
      dailyBatchGenerationLimit: UNLIMITED,
      imageGenerationEnabled: true,
      dailyImageGenerationLimit: UNLIMITED,
      usage,
      limits,
      remaining: makeRemaining(limits),
    };
  }

  const sub = await getActiveSubscriptionWithPlan(userId);

  if (!sub || !sub.plan) {
    const limits = { posts: 0, batchGenerations: 0, images: 0, manualAiOperations: 0 };
    // Locked/free fallback: no active subscription.
    return {
      ...responseBase,
      hasActiveSubscription: false,
      planId: null,
      planName: null,
      ...LOCKED_LIMITS,
      usage,
      limits,
      remaining: makeRemaining(limits),
    };
  }

  const plan = await getEffectiveEntitlementPlan(sub);
  if (!plan) {
    const limits = { posts: 0, batchGenerations: 0, images: 0, manualAiOperations: 0 };
    return {
      ...responseBase,
      hasActiveSubscription: false,
      planId: null,
      planName: null,
      ...LOCKED_LIMITS,
      usage,
      limits,
      remaining: makeRemaining(limits),
    };
  }
  const imageGenerationEnabled = plan.imageGenerationEnabled;
  const resolvedLimits = getMonthlyLimits(plan);
  const limits = {
    ...resolvedLimits,
    images: imageGenerationEnabled ? resolvedLimits.images : 0,
  };

  return {
    ...responseBase,
    hasActiveSubscription: true,
    planId: plan.id,
    planName: plan.name,
    fullDashboardUnlock: plan.fullDashboardUnlock,
    maxRewritesPerPost: plan.maxRewritesPerPost,
    monthlyPostLimit: limits.posts,
    monthlyBatchGenerationLimit: limits.batchGenerations,
    monthlyImageGenerationLimit: limits.images,
    monthlyManualAiOperationLimit: limits.manualAiOperations,
    dailyPostLimit: limits.posts,
    dailyBatchGenerationLimit: limits.batchGenerations,
    imageGenerationEnabled,
    dailyImageGenerationLimit: limits.images,
    usage,
    limits,
    remaining: makeRemaining(limits),
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
    const plan = await getEffectiveEntitlementPlan(sub);
    if (!plan?.fullDashboardUnlock) {
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

  const plan = await getEffectiveEntitlementPlan(sub);
  if (!plan) return;

  const { start, end } = getUtcMonthWindow();
  const published = await countPostsThisMonth(userId, start, end);
  const monthlyLimit = getMonthlyLimits(plan).posts;
  // TODO: Concurrent requests can both pass before either successful LinkedIn
  // publish updates Post. Do not hold a transaction over the external API.
  if (published + additionalCount > monthlyLimit) {
    throw new PlanLimitError(
      'DAILY_POST_LIMIT_REACHED',
      'Monthly post limit reached for your current plan.',
    );
  }
}

/** @deprecated Use canPublishToLinkedIn; quota applies only to LinkedIn publishes. */
export const canCreateOrSchedulePost = canPublishToLinkedIn;

// Monthly batch generation gate.
export async function canStartBatchGeneration(userId: string): Promise<void> {
  if (await isPrivileged(userId)) return;

  const ent = await getUserPlanEntitlements(userId);
  // TODO: The check and BotGenerationJob create should eventually reserve usage
  // atomically so concurrent starts cannot exceed the monthly quota.
  if (ent.usage.batchGenerationsThisMonth + 1 > ent.monthlyBatchGenerationLimit) {
    throw new PlanLimitError(
      'DAILY_BATCH_GENERATION_LIMIT_REACHED',
      'Monthly batch generation limit reached for your current plan.',
    );
  }
}

/**
 * Image generation gate: plan must enable image generation and the user must be
 * under their monthly image limit.
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
  // TODO: Concurrent generations can both pass before success usage is recorded.
  if (ent.usage.imagesGeneratedThisMonth >= ent.monthlyImageGenerationLimit) {
    throw new PlanLimitError(
      'DAILY_IMAGE_LIMIT_REACHED',
      'Monthly image generation limit reached for your current plan.',
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

/**
 * Monthly gate for unsaved manual-composer AI generate/rewrite operations.
 * Saved posts use per-post rewriteCount via canRewritePost().
 */
export async function canUseManualAiOperation(userId: string): Promise<{
  usedThisMonth: number;
  monthlyLimit: number;
}> {
  if (await isPrivileged(userId)) {
    return { usedThisMonth: 0, monthlyLimit: UNLIMITED };
  }

  const ent = await getUserPlanEntitlements(userId);
  const monthlyLimit = ent.monthlyManualAiOperationLimit;
  const usedThisMonth = ent.usage.manualAiOperationsThisMonth;
  // TODO: Concurrent operations can both pass before their success rows are recorded.
  if (usedThisMonth >= monthlyLimit) {
    throw new PlanLimitError(
      'REWRITE_LIMIT_REACHED',
      'Monthly AI assistant limit reached for your current plan.',
    );
  }
  return { usedThisMonth, monthlyLimit };
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
