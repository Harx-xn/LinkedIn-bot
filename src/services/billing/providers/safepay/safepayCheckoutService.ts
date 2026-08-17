import { BillingAccessStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { prisma } from '../../../../prismaClient';
import { config } from '../../../../config';
import { BillingError, sanitizeExternalError } from '../../billingError';
import { hasBlockingSubscription, isTrialEligible, setUserBillingAccess } from '../../billingAccessService';
import type { ProviderCheckoutInput, ProviderCheckoutResult } from '../types';
import { getSafepayClient } from './safepayClient';
import { resolveSafepayCheckoutPlanId, resolveSafepayPlanMapping } from './safepayPlanService';
import { reconcileSafepaySubscription } from './safepaySubscriptionSyncService';

export async function createSafepayCheckout(input: ProviderCheckoutInput): Promise<ProviderCheckoutResult> {
  const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { id: true, email: true, regionId: true } });
  if (!user?.regionId || !user.email) throw new BillingError(400, 'BILLING_NOT_AVAILABLE', 'Billing is not available for this account.');
  if (await hasBlockingSubscription(user.id)) throw new BillingError(409, 'SUBSCRIPTION_ALREADY_EXISTS', 'You already have an active subscription.');
  const pending = await prisma.subscription.findFirst({
    where: {
      userId: user.id,
      provider: 'SAFEPAY',
      providerStatus: 'CHECKOUT_PENDING',
      createdAt: { gt: new Date(Date.now() - 60 * 60 * 1000) },
    },
    select: { id: true, planId: true, providerSubscriptionId: true },
  });
  if (pending?.providerSubscriptionId) {
    try {
      const reconciled = await reconcileSafepaySubscription(user.regionId, pending.id);
      if (reconciled && ['TRIALING', 'ACTIVE'].includes(reconciled.status)) {
        return {
          url: `${config.frontendUrl}/billing?checkout=success&provider=SAFEPAY&session_id=${encodeURIComponent(pending.id)}`,
          sessionId: pending.id,
          provider: 'SAFEPAY',
        };
      }
    } catch (error) {
      console.warn('[SAFEPAY-CHECKOUT-RECOVERY]', {
        regionId: user.regionId, userId: user.id, localSubscriptionId: pending.id,
        result: 'not-confirmed', message: sanitizeExternalError(error),
      });
    }
  }
  if (pending && !input.retryIncomplete) throw new BillingError(409, 'SUBSCRIPTION_ALREADY_EXISTS', 'A subscription checkout is already in progress.');
  if (pending && (pending.planId !== input.planId || pending.providerSubscriptionId)) {
    throw new BillingError(409, 'SUBSCRIPTION_ALREADY_EXISTS', 'Your existing subscription is still being confirmed. Refresh billing before retrying.');
  }
  if (input.mode === 'trial' && !(await isTrialEligible(user.id))) throw new BillingError(403, 'TRIAL_ALREADY_USED', 'You are not eligible for a free trial');

  const { client, config: providerConfig } = await getSafepayClient(user.regionId);
  const { plan, mapping } = await resolveSafepayPlanMapping(input.planId, user.regionId, providerConfig.environment);
  const checkoutProviderPlanId = resolveSafepayCheckoutPlanId(mapping, input.mode);
  if (!checkoutProviderPlanId) {
    throw new BillingError(400, 'PLAN_NOT_ACTIVE', input.mode === 'paid'
      ? 'This plan needs a separate Safepay plan with zero trial days before paid checkout can start.'
      : 'This plan is not configured for trial checkout.');
  }
  const pendingId = pending?.id ?? randomUUID();
  if (pending) {
    await prisma.subscription.update({
      where: { id: pending.id },
      data: { providerStatus: 'CHECKOUT_PENDING', status: 'INCOMPLETE', checkoutMode: input.mode.toUpperCase() },
    });
  } else {
    await prisma.subscription.create({
      data: {
      id: pendingId,
      userId: user.id,
      regionId: user.regionId,
      planId: plan.id,
      provider: 'SAFEPAY',
      providerStatus: 'CHECKOUT_PENDING',
      checkoutMode: input.mode.toUpperCase(),
      status: 'INCOMPLETE',
      autoRenew: true,
      },
    });
  }

  const cancelUrl = `${config.frontendUrl}/billing?checkout=cancelled&provider=SAFEPAY`;
  const redirectUrl = `${config.frontendUrl}/billing?checkout=success&provider=SAFEPAY&session_id=${encodeURIComponent(pendingId)}`;
  try {
    const url = await client.checkout.createSubscription({
      cancelUrl,
      redirectUrl,
      planId: checkoutProviderPlanId,
      reference: pendingId,
    });
    if (typeof url !== 'string') throw new Error('Safepay did not return a checkout URL');
    console.info('[SAFEPAY-CHECKOUT-CREATED]', {
      regionId: user.regionId,
      userId: user.id,
      localSubscriptionId: pendingId,
      checkoutReference: pendingId,
      planId: checkoutProviderPlanId,
      checkoutMode: input.mode,
      environment: providerConfig.environment,
      apiBaseUrl: providerConfig.environment === 'SANDBOX'
        ? 'https://sandbox.api.getsafepay.com'
        : 'https://api.getsafepay.com',
    });
    if (input.mode === 'trial') await setUserBillingAccess(user.id, BillingAccessStatus.TRIAL_PENDING);
    return { url, sessionId: pendingId, provider: 'SAFEPAY' };
  } catch (error) {
    if (!pending) await prisma.subscription.delete({ where: { id: pendingId } }).catch(() => undefined);
    console.error('[billing-provider]', { provider: 'SAFEPAY', regionId: user.regionId, userId: user.id, message: sanitizeExternalError(error) });
    throw new BillingError(502, 'CHECKOUT_SESSION_FAILED', 'Unable to start checkout. Please try again.');
  }
}
