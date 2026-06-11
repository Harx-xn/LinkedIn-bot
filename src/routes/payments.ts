import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { BillingError, sanitizeExternalError } from '../services/billing/billingError';
import {
  createPaidCheckoutSession,
  createTrialCheckoutSession,
  getCheckoutStatus,
} from '../services/billing/stripeCheckoutService';

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
    const result = await createTrialCheckoutSession({
      userId,
      planId,
      promoCode,
      inviteCode,
      mode: 'trial',
    });
    return res.json({ url: result.url, sessionId: result.sessionId });
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
    const result = await createPaidCheckoutSession({
      userId,
      planId,
      promoCode,
      inviteCode,
      mode: 'paid',
    });
    return res.json({ url: result.url });
  } catch (err) {
    return handleBillingError(res, err);
  }
});

router.get('/checkout-status/:sessionId', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
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
