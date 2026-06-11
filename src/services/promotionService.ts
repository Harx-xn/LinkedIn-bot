import { prisma } from '../prismaClient';
import { BillingError } from './billing/billingError';

export type PromotionContext = {
  regionId?: string | null;
  requireStripePromotionCode?: boolean;
};

export function normalizeCode(code?: string | null) {
  return code?.trim().toUpperCase() || '';
}

export async function validatePromotionCode(
  rawCode: string | undefined | null,
  ctx: PromotionContext = {},
) {
  const code = normalizeCode(rawCode);
  if (!code) return null;

  const now = new Date();
  const promo = await prisma.promotion.findFirst({
    where: {
      code,
      OR: [{ regionId: ctx.regionId || null }, { regionId: null }],
    },
    orderBy: [{ regionId: 'desc' }, { createdAt: 'desc' }],
  });

  if (!promo || !promo.isActive) {
    throw new BillingError(400, 'PROMO_INVALID', 'Promotion code is not valid');
  }
  if (promo.startsAt && promo.startsAt > now) {
    throw new BillingError(400, 'PROMO_INVALID', 'Promotion code is not active yet');
  }
  if (promo.endsAt && promo.endsAt < now) {
    throw new BillingError(400, 'PROMO_EXPIRED', 'Promotion code has expired');
  }
  if (promo.maxRedemptions !== null && promo.redemptionCount >= promo.maxRedemptions) {
    throw new BillingError(400, 'PROMO_INVALID', 'Promotion code is no longer available');
  }
  if (ctx.requireStripePromotionCode && promo.type === 'STRIPE_PROMO' && !promo.stripePromotionCodeId) {
    throw new BillingError(400, 'PROMO_INVALID', 'Promotion code is not valid for checkout');
  }

  return promo;
}

export async function findValidPromotion(rawCode: string | undefined | null, ctx: PromotionContext = {}) {
  const code = normalizeCode(rawCode);
  if (!code) return null;

  const now = new Date();
  const promo = await prisma.promotion.findFirst({
    where: {
      code,
      isActive: true,
      OR: [{ regionId: ctx.regionId || null }, { regionId: null }],
    },
    orderBy: [{ regionId: 'desc' }, { createdAt: 'desc' }],
  });

  if (!promo) return null;
  if (promo.startsAt && promo.startsAt > now) return null;
  if (promo.endsAt && promo.endsAt < now) return null;
  if (promo.maxRedemptions !== null && promo.redemptionCount >= promo.maxRedemptions) return null;
  if (ctx.requireStripePromotionCode && promo.type === 'STRIPE_PROMO' && !promo.stripePromotionCodeId) return null;

  return promo;
}

export async function recordPromotionRedemption(args: {
  promotionId: string;
  userId: string;
  regionId?: string | null;
  subscriptionId?: string | null;
}) {
  const existing = await prisma.promotionRedemption.findUnique({
    where: { promotionId_userId: { promotionId: args.promotionId, userId: args.userId } },
  });

  if (existing) {
    return prisma.promotionRedemption.update({
      where: { id: existing.id },
      data: args.subscriptionId ? { subscriptionId: args.subscriptionId } : {},
    });
  }

  const redemption = await prisma.promotionRedemption.create({
    data: {
      promotionId: args.promotionId,
      userId: args.userId,
      regionId: args.regionId || null,
      subscriptionId: args.subscriptionId || null,
    },
  });

  await prisma.promotion.update({
    where: { id: args.promotionId },
    data: { redemptionCount: { increment: 1 } },
  });

  return redemption;
}
