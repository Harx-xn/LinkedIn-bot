import Stripe from 'stripe';
import { prisma } from '../../prismaClient';
import { decryptSecret } from '../secretCrypto';
import { BillingError } from './billingError';

export type StripeClient = InstanceType<typeof Stripe>;

export async function getRegionalStripeClient(regionId: string): Promise<StripeClient> {
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
    throw new BillingError(400, 'STRIPE_NOT_CONFIGURED', 'Stripe is not configured for this region');
  }

  return new Stripe(stripeSecretKey);
}

export async function isStripeConfigured(regionId: string): Promise<boolean> {
  const paymentConfig = await prisma.paymentConfig.findUnique({
    where: { regionId },
    select: { provider: true, isActive: true, stripeSecretKey: true },
  });
  return !!(
    paymentConfig?.provider === 'STRIPE' &&
    paymentConfig.isActive &&
    decryptSecret(paymentConfig.stripeSecretKey)
  );
}

export function assertFrontendUrl(url: string, frontendUrl: string): void {
  const allowed = [frontendUrl.replace(/\/$/, '')];
  const normalized = url.replace(/\/$/, '');
  if (!allowed.some((base) => normalized.startsWith(base))) {
    throw new BillingError(400, 'CHECKOUT_FAILED', 'Invalid redirect URL');
  }
}
