import type { PaymentProvider } from '../types';
import { createSafepayCheckout } from './safepayCheckoutService';
import { getSafepayClient } from './safepayClient';

export class SafepayPaymentProvider implements PaymentProvider {
  readonly type = 'SAFEPAY' as const;
  readonly capabilities = {
    checkout: true, subscriptions: true, trials: true,
    automaticPlanSync: false, proratedPlanChanges: false, scheduledPlanChanges: false,
    customerPortal: false, cancel: true, reactivate: true, refunds: false,
    invoices: true, pause: true, resume: true,
  } as const;
  async validateConfiguration(regionId: string) { await getSafepayClient(regionId); }
  createCheckout = createSafepayCheckout;
}

