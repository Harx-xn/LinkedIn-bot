import Stripe from 'stripe';
import { prisma } from '../prismaClient';
import { decryptSecret } from './secretCrypto';

type StripeClient = InstanceType<typeof Stripe>;

/** Minimal Stripe subscription shape used for item resolution. */
export interface StripeSubscriptionLike {
  items: { data: Array<{ id: string; price: { id: string } }> };
  metadata?: Record<string, string> | null;
}

export const SUBSCRIPTION_STATUSES = [
  'ACTIVE',
  'PAST_DUE',
  'CANCELED',
  'INCOMPLETE',
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export type ProrationBehavior = 'create_prorations' | 'none' | 'always_invoice';

export interface UpdateSubscriptionBody {
  planId?: string;
  status?: string;
  autoRenew?: boolean;
  endsAt?: string | null;
  prorationBehavior?: ProrationBehavior;
}

export interface ValidatedSubscriptionPatch {
  planId?: string;
  status?: SubscriptionStatus;
  autoRenew?: boolean;
  endsAt?: Date | null;
  prorationBehavior: ProrationBehavior;
  hasChanges: boolean;
  planChanging: boolean;
}

export class SubscriptionAdminError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'SubscriptionAdminError';
    this.status = status;
  }
}

/** Normalize legacy British spelling for backward compatibility. */
export function normalizeSubscriptionStatus(
  raw: string,
): SubscriptionStatus | null {
  const upper = raw.trim().toUpperCase();
  if (upper === 'CANCELLED') return 'CANCELED';
  return SUBSCRIPTION_STATUSES.includes(upper as SubscriptionStatus)
    ? (upper as SubscriptionStatus)
    : null;
}

export function parseEndsAt(
  value: unknown,
): { ok: true; value: Date | null } | { ok: false; message: string } {
  if (value === null || value === undefined || value === '') {
    return { ok: true, value: null };
  }
  if (typeof value !== 'string') {
    return { ok: false, message: 'endsAt must be a date string or null' };
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { ok: false, message: 'Invalid endsAt date' };
  }
  return { ok: true, value: date };
}

export function validateSubscriptionPatchInput(
  body: UpdateSubscriptionBody,
  currentPlanId: string,
): ValidatedSubscriptionPatch {
  const result: ValidatedSubscriptionPatch = {
    prorationBehavior: 'create_prorations',
    hasChanges: false,
    planChanging: false,
  };

  if (body.planId !== undefined) {
    if (typeof body.planId !== 'string' || !body.planId.trim()) {
      throw new SubscriptionAdminError(400, 'planId must be a non-empty string');
    }
    result.planId = body.planId.trim();
    result.planChanging = result.planId !== currentPlanId;
    if (result.planChanging) result.hasChanges = true;
  }

  if (body.status !== undefined) {
    if (typeof body.status !== 'string') {
      throw new SubscriptionAdminError(400, 'status must be a string');
    }
    const normalized = normalizeSubscriptionStatus(body.status);
    if (!normalized) {
      throw new SubscriptionAdminError(
        400,
        `Invalid status. Allowed: ${SUBSCRIPTION_STATUSES.join(', ')}`,
      );
    }
    result.status = normalized;
    result.hasChanges = true;
  }

  if (body.autoRenew !== undefined) {
    if (typeof body.autoRenew !== 'boolean') {
      throw new SubscriptionAdminError(400, 'autoRenew must be a boolean');
    }
    result.autoRenew = body.autoRenew;
    result.hasChanges = true;
  }

  if (body.endsAt !== undefined) {
    const parsed = parseEndsAt(body.endsAt);
    if (!parsed.ok) {
      throw new SubscriptionAdminError(400, parsed.message);
    }
    result.endsAt = parsed.value;
    result.hasChanges = true;
  }

  if (body.prorationBehavior !== undefined) {
    const allowed: ProrationBehavior[] = [
      'create_prorations',
      'none',
      'always_invoice',
    ];
    if (!allowed.includes(body.prorationBehavior)) {
      throw new SubscriptionAdminError(
        400,
        'prorationBehavior must be create_prorations, none, or always_invoice',
      );
    }
    result.prorationBehavior = body.prorationBehavior;
  }

  if (!result.hasChanges) {
    throw new SubscriptionAdminError(400, 'No supported subscription changes provided');
  }

  return result;
}

async function getStripeClient(regionId: string): Promise<StripeClient | null> {
  const paymentConfig = await prisma.paymentConfig.findUnique({
    where: { regionId },
  });
  const stripeSecretKey = decryptSecret(paymentConfig?.stripeSecretKey);
  if (
    !paymentConfig ||
    paymentConfig.provider !== 'STRIPE' ||
    !paymentConfig.isActive ||
    !stripeSecretKey
  ) {
    return null;
  }
  return new Stripe(stripeSecretKey);
}

/** Exported for tests — picks the Stripe item that represents the app plan. */
export function resolveStripePlanItem(
  stripeSub: StripeSubscriptionLike,
  currentPlanStripePriceId: string | null,
): { id: string; price: { id: string } } {
  const items = stripeSub.items.data;
  if (!items.length) {
    throw new SubscriptionAdminError(502, 'Stripe subscription has no subscription item');
  }
  if (items.length === 1) return items[0];

  if (currentPlanStripePriceId) {
    const match = items.find((item) => item.price.id === currentPlanStripePriceId);
    if (match) return match;
  }

  return items[0];
}

async function changeStripePlan(
  stripe: StripeClient,
  stripeSubscriptionId: string,
  currentPlanStripePriceId: string | null,
  targetStripePriceId: string,
  targetPlanId: string,
  prorationBehavior: ProrationBehavior,
): Promise<void> {
  let stripeSub: StripeSubscriptionLike;
  try {
    stripeSub = (await stripe.subscriptions.retrieve(
      stripeSubscriptionId,
    )) as StripeSubscriptionLike;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to retrieve Stripe subscription';
    throw new SubscriptionAdminError(502, message);
  }

  const item = resolveStripePlanItem(stripeSub, currentPlanStripePriceId);

  try {
    await stripe.subscriptions.update(stripeSubscriptionId, {
      items: [{ id: item.id, price: targetStripePriceId }],
      proration_behavior: prorationBehavior,
      metadata: {
        ...stripeSub.metadata,
        planId: targetPlanId,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Stripe plan change failed';
    throw new SubscriptionAdminError(400, message);
  }
}

async function applyStripeCancellation(
  stripe: StripeClient,
  stripeSubscriptionId: string,
  cancelAtPeriodEnd: boolean,
): Promise<void> {
  try {
    if (cancelAtPeriodEnd) {
      await stripe.subscriptions.update(stripeSubscriptionId, {
        cancel_at_period_end: true,
      });
    } else {
      await stripe.subscriptions.update(stripeSubscriptionId, {
        cancel_at_period_end: false,
      });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Stripe cancellation update failed';
    throw new SubscriptionAdminError(400, message);
  }
}

const subscriptionInclude = {
  plan: true,
  user: { select: { id: true, email: true, username: true } },
} as const;

/**
 * Admin subscription update: change plan, status, autoRenew, endsAt on an
 * existing row (never creates a duplicate Subscription).
 */
export async function updateAdminSubscription(params: {
  regionId: string;
  subscriptionId: string;
  body: UpdateSubscriptionBody;
}) {
  const { regionId, subscriptionId, body } = params;

  const existing = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
    include: { plan: true },
  });

  if (!existing || existing.regionId !== regionId) {
    throw new SubscriptionAdminError(404, 'Subscription not found in your region');
  }

  // Idempotent no-op: same planId with no other fields.
  const isSamePlanOnly =
    body.planId !== undefined &&
    body.planId.trim() === existing.planId &&
    body.status === undefined &&
    body.autoRenew === undefined &&
    body.endsAt === undefined;

  if (isSamePlanOnly) {
    return prisma.subscription.findUniqueOrThrow({
      where: { id: subscriptionId },
      include: subscriptionInclude,
    });
  }

  const patch = validateSubscriptionPatchInput(body, existing.planId);

  // Idempotent: same plan, only metadata fields changing.
  if (!patch.planChanging && patch.planId !== undefined) {
    delete patch.planId;
  }

  let targetPlan = existing.plan;

  if (patch.planChanging && patch.planId) {
    const plan = await prisma.plan.findUnique({ where: { id: patch.planId } });
    if (!plan || plan.regionId !== regionId) {
      throw new SubscriptionAdminError(404, 'Plan not found in your region');
    }
    if (!plan.isActive && plan.id !== existing.planId) {
      throw new SubscriptionAdminError(400, 'Target plan is inactive');
    }
    targetPlan = plan;
  }

  // Management operations are routed by immutable subscription ownership,
  // never by the region's provider selected for new checkouts.
  const provider = existing.provider ?? (existing.stripeSubscriptionId ? 'STRIPE' : 'MANUAL');

  if (patch.planChanging && targetPlan) {
    if (existing.stripeSubscriptionId && provider === 'PAYPAL') {
      throw new SubscriptionAdminError(
        400,
        'Recurring PayPal subscription plan changes are not implemented.',
      );
    }

    if (existing.stripeSubscriptionId && provider === 'STRIPE') {
      if (!targetPlan.stripePriceId) {
        throw new SubscriptionAdminError(
          400,
          'Target plan has no stripePriceId. Cannot change a Stripe-backed subscription to this plan.',
        );
      }

      const stripe = await getStripeClient(regionId);
      if (!stripe) {
        throw new SubscriptionAdminError(400, 'Stripe is not configured for this region');
      }

      await changeStripePlan(
        stripe,
        existing.stripeSubscriptionId,
        existing.plan.stripePriceId,
        targetPlan.stripePriceId,
        targetPlan.id,
        patch.prorationBehavior,
      );
    }
  }

  const stripe =
    existing.stripeSubscriptionId && provider === 'STRIPE'
      ? await getStripeClient(regionId)
      : null;

  if (patch.status === 'CANCELED' && existing.stripeSubscriptionId && stripe) {
    await applyStripeCancellation(stripe, existing.stripeSubscriptionId, true);
  } else if (
    patch.status === 'ACTIVE' &&
    existing.stripeSubscriptionId &&
    stripe &&
    existing.status === 'CANCELED'
  ) {
    await applyStripeCancellation(stripe, existing.stripeSubscriptionId, false);
  }

  const data: {
    planId?: string;
    status?: SubscriptionStatus;
    autoRenew?: boolean;
    endsAt?: Date | null;
  } = {};

  if (patch.planChanging && targetPlan) data.planId = targetPlan.id;
  if (patch.status !== undefined) {
    data.status = patch.status;
    if (patch.status === 'CANCELED' && patch.autoRenew === undefined) {
      data.autoRenew = false;
    }
  }
  if (patch.autoRenew !== undefined) data.autoRenew = patch.autoRenew;
  if (patch.endsAt !== undefined) data.endsAt = patch.endsAt;

  return prisma.subscription.update({
    where: { id: subscriptionId },
    data,
    include: subscriptionInclude,
  });
}
