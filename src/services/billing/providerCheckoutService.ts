import { prisma } from '../../prismaClient';
import { BillingError } from './billingError';
import { getPaymentProvider } from './providers/providerFactory';
import type { ProviderCheckoutInput } from './providers/types';

export async function createProviderCheckout(input: ProviderCheckoutInput) {
  const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { regionId: true } });
  if (!user?.regionId) throw new BillingError(400, 'USER_REGION_MISSING', 'Your account is not assigned to a billing region');
  const paymentConfig = await prisma.paymentConfig.findUnique({ where: { regionId: user.regionId } });
  if (!paymentConfig?.isActive) throw new BillingError(400, 'BILLING_NOT_AVAILABLE', 'Billing is not configured for this region.');
  return getPaymentProvider(paymentConfig.provider).createCheckout(input);
}
