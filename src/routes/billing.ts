import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { BillingError, sanitizeExternalError } from '../services/billing/billingError';
import { getBillingMe } from '../services/billing/billingMeService';
import {
  cancelSubscription,
  changePlan,
  createPortalSession,
  reactivateSubscription,
} from '../services/billing/billingManagementService';

const router = Router();

function handleBillingError(res: Response, err: unknown) {
  if (err instanceof BillingError) {
    return res.status(err.status).json({ code: err.code, message: err.message });
  }
  console.error('[billing]', sanitizeExternalError(err));
  return res.status(500).json({ code: 'CHECKOUT_FAILED', message: 'Billing request failed' });
}

router.get('/me', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const data = await getBillingMe(userId);
    return res.json(data);
  } catch (err) {
    return handleBillingError(res, err);
  }
});

router.post('/portal-session', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const result = await createPortalSession(userId);
    return res.json(result);
  } catch (err) {
    return handleBillingError(res, err);
  }
});

router.post('/change-plan', requireAuth, async (req: Request, res: Response) => {
  const { planId } = req.body as { planId?: string };
  if (!planId) {
    return res.status(400).json({ code: 'PLAN_NOT_FOUND', message: 'planId is required' });
  }
  try {
    const userId = (req as any).userId;
    const result = await changePlan(userId, planId);
    return res.json(result);
  } catch (err) {
    return handleBillingError(res, err);
  }
});

router.post('/cancel', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const result = await cancelSubscription(userId);
    return res.json(result);
  } catch (err) {
    return handleBillingError(res, err);
  }
});

router.post('/reactivate', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const result = await reactivateSubscription(userId);
    return res.json(result);
  } catch (err) {
    return handleBillingError(res, err);
  }
});

export default router;
