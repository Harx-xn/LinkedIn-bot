import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { BillingError, sanitizeExternalError } from '../services/billing/billingError';
import {
  getCheckoutStatus,
} from '../services/billing/stripeCheckoutService';
import { createProviderCheckout } from '../services/billing/providerCheckoutService';
import { prisma } from '../prismaClient';
import { reconcileSafepaySubscription } from '../services/billing/providers/safepay/safepaySubscriptionSyncService';

const router = Router();

const UUID_REFERENCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeCheckoutReference(rawReference: string) {
  const [candidate, suffix = ''] = rawReference.split('?', 2);
  const legacyQuery = new URLSearchParams(suffix);
  return {
    reference: UUID_REFERENCE.test(candidate) ? candidate : rawReference,
    legacyPlanId: legacyQuery.get('plan_id'),
  };
}

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
  const { planId, promoCode, inviteCode, retryIncomplete } = req.body as {
    planId?: string;
    promoCode?: string;
    inviteCode?: string;
    retryIncomplete?: boolean;
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
      retryIncomplete: retryIncomplete === true,
      mode: 'trial',
    });
    return res.json({ url: result.url, sessionId: result.sessionId, provider: result.provider });
  } catch (err) {
    return handleBillingError(res, err);
  }
});

router.post('/checkout', requireAuth, async (req: Request, res: Response) => {
  const { planId, promoCode, inviteCode, retryIncomplete } = req.body as {
    planId?: string;
    promoCode?: string;
    inviteCode?: string;
    retryIncomplete?: boolean;
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
      retryIncomplete: retryIncomplete === true,
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
    const rawReference = req.params.sessionId;
    const normalized = normalizeCheckoutReference(rawReference);
    const planId = typeof req.query.plan_id === 'string' ? req.query.plan_id : normalized.legacyPlanId;
    console.info('[SAFEPAY-RETURN-PARSED]', {
      userId,
      localSubscriptionId: normalized.reference,
      checkoutReference: normalized.reference,
      planId,
    });
    const providerSub = await prisma.subscription.findFirst({
      where: { id: normalized.reference, userId, provider: 'SAFEPAY' },
      select: { id: true, regionId: true, status: true, providerStatus: true, providerSubscriptionId: true },
    });
    if (providerSub) {
      let reconciliationResult = 'not-required';
      if (providerSub.providerSubscriptionId && providerSub.regionId &&
          (providerSub.providerStatus === 'CHECKOUT_PENDING' || providerSub.status === 'INCOMPLETE')) {
        await reconcileSafepaySubscription(providerSub.regionId, providerSub.id);
        reconciliationResult = 'synchronized';
        const reconciled = await prisma.subscription.findUnique({
          where: { id: providerSub.id },
          select: { status: true, providerStatus: true },
        });
        if (reconciled) Object.assign(providerSub, reconciled);
      }
      console.info('[checkout-reconciliation]', {
        rawReference, normalizedReference: normalized.reference, planId,
        localSubscriptionId: providerSub.id,
        providerSubscriptionId: providerSub.providerSubscriptionId,
        providerStatus: providerSub.providerStatus,
        normalizedStatus: providerSub.status,
        reconciliationResult,
      });
      console.info('[SAFEPAY-CHECKOUT-STATUS]', {
        regionId: providerSub.regionId,
        userId,
        localSubscriptionId: providerSub.id,
        checkoutReference: normalized.reference,
        providerSubscriptionId: providerSub.providerSubscriptionId,
        planId,
        providerStatus: providerSub.providerStatus,
        normalizedStatus: providerSub.status,
      });
      if (providerSub.providerStatus === 'CHECKOUT_PENDING') {
        return res.json({ status: 'PROCESSING', subscriptionStatus: 'INCOMPLETE', billingStatus: 'TRIAL_PENDING' });
      }
      const settled = ['TRIALING', 'ACTIVE', 'PAST_DUE', 'PAUSED', 'INCOMPLETE', 'CANCELED'].includes(providerSub.status);
      return res.json({
        status: settled ? providerSub.status : 'PROCESSING',
        subscriptionStatus: providerSub.status,
        billingStatus: providerSub.status,
      });
    }
    const result = await getCheckoutStatus({
      userId,
      sessionId: rawReference,
    });
    return res.json(result);
  } catch (err) {
    return handleBillingError(res, err);
  }
});

export default router;
