import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { prisma } from '../prismaClient';
import { requireAuth } from '../middleware/auth';
import { config } from '../config';
import { decryptSecret } from '../services/secretCrypto';

const router = Router();

function getBillingInterval(billingCycle: string): 'day' | 'week' | 'month' | 'year' {
  const normalized = billingCycle.toLowerCase();

  if (normalized.includes('year')) return 'year';
  if (normalized.includes('week')) return 'week';
  if (normalized.includes('day')) return 'day';

  return 'month';
}

router.post('/checkout', requireAuth, async (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const { planId } = req.body as { planId?: string };

  if (!planId) {
    return res.status(400).json({ error: 'Missing planId' });
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      regionId: true,
    },
  });

  if (!user || !user.regionId) {
    return res.status(404).json({ error: 'User or region not found' });
  }

  const plan = await prisma.plan.findFirst({
    where: {
      id: planId,
      regionId: user.regionId,
      isActive: true,
    },
  });

  if (!plan) {
    return res.status(404).json({ error: 'Plan not found' });
  }

  const paymentConfig = await prisma.paymentConfig.findUnique({
    where: { regionId: user.regionId },
  });

  const stripeSecretKey = decryptSecret(paymentConfig?.stripeSecretKey);

  if (
    !paymentConfig ||
    paymentConfig.provider !== 'STRIPE' ||
    !paymentConfig.isActive ||
    !stripeSecretKey
  ) {
    return res.status(400).json({ error: 'Stripe is not configured for this region' });
  }

  const stripe = new Stripe(stripeSecretKey);

  const unitAmount = Math.round(plan.price * 100);

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer_email: user.email,
    success_url: `${config.frontendUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.frontendUrl}/billing/cancelled`,
    line_items: [
      {
        price_data: {
          currency: plan.currency.toLowerCase(),
          product_data: {
            name: plan.name,
          },
          unit_amount: unitAmount,
          recurring: {
            interval: getBillingInterval(plan.billingCycle),
          },
        },
        quantity: 1,
      },
    ],
    metadata: {
      userId: user.id,
      regionId: user.regionId,
      planId: plan.id,
    },
    subscription_data: {
      metadata: {
        userId: user.id,
        regionId: user.regionId,
        planId: plan.id,
      },
    },
  });

  return res.json({ url: session.url });
});

export default router;