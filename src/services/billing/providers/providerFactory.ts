import { BillingError } from '../billingError';
import type { PaymentProvider, PaymentProviderType } from './types';
import { StripePaymentProvider } from './stripe/stripeProvider';
import { SafepayPaymentProvider } from './safepay/safepayProvider';

const providers: Record<PaymentProviderType, PaymentProvider> = {
  STRIPE: new StripePaymentProvider(),
  SAFEPAY: new SafepayPaymentProvider(),
};

export function getPaymentProvider(provider: string): PaymentProvider {
  const resolved = providers[provider as PaymentProviderType];
  if (!resolved) throw new BillingError(400, 'BILLING_NOT_AVAILABLE', 'Automated billing is not available for this provider.');
  return resolved;
}

