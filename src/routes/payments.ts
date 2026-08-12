import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { BillingError, sanitizeExternalError } from '../services/billing/billingError';
import {
  getCheckoutStatus,
} from '../services/billing/stripeCheckoutService';
import { createProviderCheckout } from '../services/billing/providerCheckoutService';
import { prisma } from '../prismaClient';

const router = Router();

function handleBillingError(res: Response, err: unknown) {
  if (err instanceof BillingError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  console.error('[payments]', sanitizeExternalError(err));
  return res.status(500).json({
    error: 'Payment request failed',
    code: 'CHECKOUT_FAILED',
  });
}

router.post('/trial-checkout', requireAuth, async (req: Request, res: Response) => {
  const { planId, promoCode, inviteCode } = req.body as {
    planId?: string;
    promoCode?: string;
    inviteCode?: string;
  };

  if (!planId) {
    return res.status(400).json({ error: 'planId is required', code: 'PLAN_NOT_FOUND' });
  }

  try {
    const userId = (req as any).userId;
    const result = await createProviderCheckout({
      userId,
      planId,
      promoCode,
      inviteCode,
      mode: 'trial',
    });
    return res.json({ url: result.url, sessionId: result.sessionId, provider: result.provider });
  } catch (err) {
    return handleBillingError(res, err);
  }
});

router.post('/checkout', requireAuth, async (req: Request, res: Response) => {
  const { planId, promoCode, inviteCode } = req.body as {
    planId?: string;
    promoCode?: string;
    inviteCode?: string;
  };

  if (!planId) {
    return res.status(400).json({ error: 'planId is required', code: 'PLAN_NOT_FOUND' });
  }

  try {
    const userId = (req as any).userId;
    const result = await createProviderCheckout({
      userId,
      planId,
      promoCode,
      inviteCode,
      mode: 'paid',
    });
    return res.json({ url: result.url, sessionId: result.sessionId, provider: result.provider });
  } catch (err) {
    return handleBillingError(res, err);
  }
});

router.get('/checkout-status/:sessionId', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const providerSub = await prisma.subscription.findFirst({
      where: { id: req.params.sessionId, userId, provider: 'SAFEPAY' },
      select: { status: true, providerStatus: true },
    });
    if (providerSub) {
      if (providerSub.providerStatus === 'CHECKOUT_PENDING') {
        return res.json({ status: 'PROCESSING', subscriptionStatus: 'INCOMPLETE', billingStatus: 'TRIAL_PENDING' });
      }
      const settled = ['TRIALING', 'ACTIVE', 'INCOMPLETE', 'CANCELED'].includes(providerSub.status);
      return res.json({
        status: settled ? providerSub.status : 'PROCESSING',
        subscriptionStatus: providerSub.status,
        billingStatus: providerSub.status,
      });
    }
    const result = await getCheckoutStatus({
      userId,
      sessionId: req.params.sessionId,
    });
    return res.json(result);
  } catch (err) {
    return handleBillingError(res, err);
  }
});

export default router;
