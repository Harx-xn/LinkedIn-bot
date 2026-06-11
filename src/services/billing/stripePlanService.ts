import { prisma } from '../../prismaClient';
import { BillingError } from './billingError';
import { getRegionalStripeClient, type StripeClient } from './stripeClientService';

export interface StripePriceLike {
  id: string;
  active: boolean;
  type: string;
  currency: string;
  recurring?: { interval: string } | null;
}

export interface ValidatedStripePlan {
  plan: {
    id: string;
    name: string;
    code: string;
    price: number;
    currency: string;
    billingCycle: string;
    stripePriceId: string;
    regionId: string | null;
  };
  stripePrice: StripePriceLike;
}

export async function validatePlanStripePrice(
  planId: string,
  regionId: string,
  stripe?: StripeClient,
): Promise<ValidatedStripePlan> {
  const plan = await prisma.plan.findFirst({
    where: { id: planId, regionId },
  });

  if (!plan) {
    throw new BillingError(404, 'PLAN_NOT_FOUND', 'Plan not found');
  }

  if (!plan.isActive) {
    throw new BillingError(400, 'PLAN_NOT_ACTIVE', 'This plan is not available');
  }

  if (!plan.stripePriceId) {
    throw new BillingError(
      400,
      'PLAN_NOT_CONFIGURED_IN_STRIPE',
      'This plan is not configured for Stripe billing yet',
    );
  }

  const client = stripe ?? (await getRegionalStripeClient(regionId));
  let stripePrice: StripePriceLike;

  try {
    stripePrice = (await client.prices.retrieve(plan.stripePriceId)) as StripePriceLike;
  } catch {
    throw new BillingError(
      400,
      'PLAN_NOT_CONFIGURED_IN_STRIPE',
      'Stripe price for this plan could not be found',
    );
  }

  if (!stripePrice.active) {
    throw new BillingError(400, 'PLAN_NOT_CONFIGURED_IN_STRIPE', 'Stripe price is inactive');
  }

  if (stripePrice.type !== 'recurring' || !stripePrice.recurring) {
    throw new BillingError(400, 'PLAN_NOT_CONFIGURED_IN_STRIPE', 'Plan price must be recurring');
  }

  const planCurrency = plan.currency.toLowerCase();
  const priceCurrency = (stripePrice.currency || '').toLowerCase();
  if (planCurrency !== priceCurrency) {
    throw new BillingError(
      400,
      'PLAN_NOT_CONFIGURED_IN_STRIPE',
      'Plan currency does not match Stripe price currency',
    );
  }

  return {
    plan: {
      id: plan.id,
      name: plan.name,
      code: plan.code,
      price: plan.price,
      currency: plan.currency,
      billingCycle: plan.billingCycle,
      stripePriceId: plan.stripePriceId,
      regionId: plan.regionId,
    },
    stripePrice,
  };
}

export async function resolvePlanByStripePriceId(
  stripePriceId: string,
  regionId: string,
): Promise<{ id: string } | null> {
  return prisma.plan.findFirst({
    where: { regionId, stripePriceId, isActive: true },
    select: { id: true },
  });
}

function billingIntervalFromCycle(billingCycle: string): 'day' | 'week' | 'month' | 'year' {
  const normalized = billingCycle.toLowerCase();
  if (normalized.includes('year')) return 'year';
  if (normalized.includes('week')) return 'week';
  if (normalized.includes('day')) return 'day';
  return 'month';
}

/**
 * Create or rotate Stripe Product/Price for a regional plan.
 * When price/currency changes, creates a new Price and deactivates the old one.
 */
export async function syncPlanToStripe(params: {
  regionId: string;
  planId: string;
  name: string;
  code: string;
  price: number;
  currency: string;
  billingCycle: string;
  previousStripePriceId?: string | null;
}): Promise<string> {
  const stripe = await getRegionalStripeClient(params.regionId);
  const unitAmount = Math.round(params.price * 100);
  const currency = params.currency.toLowerCase();

  const product = await stripe.products.create({
    name: params.name,
    metadata: {
      planId: params.planId,
      planCode: params.code,
      regionId: params.regionId,
    },
  });

  const newPrice = await stripe.prices.create({
    product: product.id,
    unit_amount: unitAmount,
    currency,
    recurring: { interval: billingIntervalFromCycle(params.billingCycle) },
    metadata: {
      planId: params.planId,
      planCode: params.code,
      regionId: params.regionId,
    },
  });

  if (params.previousStripePriceId && params.previousStripePriceId !== newPrice.id) {
    try {
      await stripe.prices.update(params.previousStripePriceId, { active: false });
    } catch {
      // Old price may already be inactive or deleted in Stripe.
    }
  }

  await prisma.plan.update({
    where: { id: params.planId },
    data: { stripePriceId: newPrice.id },
  });

  return newPrice.id;
}
