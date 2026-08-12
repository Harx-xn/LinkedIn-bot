import { BillingAccessStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { prisma } from '../../../../prismaClient';
import { config } from '../../../../config';
import { BillingError, sanitizeExternalError } from '../../billingError';
import { hasBlockingSubscription, isTrialEligible, setUserBillingAccess } from '../../billingAccessService';
import type { ProviderCheckoutInput, ProviderCheckoutResult } from '../types';
import { getSafepayClient } from './safepayClient';
import { resolveSafepayPlanMapping } from './safepayPlanService';

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
    select: { id: true },
  });
  if (pending) throw new BillingError(409, 'SUBSCRIPTION_ALREADY_EXISTS', 'A subscription checkout is already in progress.');
  if (input.mode === 'trial' && !(await isTrialEligible(user.id))) throw new BillingError(403, 'TRIAL_ALREADY_USED', 'You are not eligible for a free trial');

  const { client, config: providerConfig } = await getSafepayClient(user.regionId);
  const { plan, mapping } = await resolveSafepayPlanMapping(input.planId, user.regionId, providerConfig.environment);
  const pendingId = randomUUID();
  await prisma.subscription.create({
    data: {
      id: pendingId,
      userId: user.id,
      regionId: user.regionId,
      planId: plan.id,
      provider: 'SAFEPAY',
      providerStatus: 'CHECKOUT_PENDING',
      status: 'INCOMPLETE',
      autoRenew: true,
    },
  });

  const cancelUrl = `${config.frontendUrl}/billing?checkout=cancelled`;
  const redirectUrl = `${config.frontendUrl}/billing?checkout=success&session_id=${encodeURIComponent(pendingId)}`;
  try {
    const url = await client.checkout.createSubscription({
      cancelUrl,
      redirectUrl,
      planId: mapping.providerPlanId!,
      reference: pendingId,
    });
    if (typeof url !== 'string') throw new Error('Safepay did not return a checkout URL');
    if (input.mode === 'trial') await setUserBillingAccess(user.id, BillingAccessStatus.TRIAL_PENDING);
    return { url, sessionId: pendingId, provider: 'SAFEPAY' };
  } catch (error) {
    await prisma.subscription.delete({ where: { id: pendingId } }).catch(() => undefined);
    console.error('[billing-provider]', { provider: 'SAFEPAY', regionId: user.regionId, userId: user.id, message: sanitizeExternalError(error) });
    throw new BillingError(502, 'CHECKOUT_SESSION_FAILED', 'Unable to start checkout. Please try again.');
  }
}
