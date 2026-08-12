import { createPaidCheckoutSession, createTrialCheckoutSession } from '../../stripeCheckoutService';
import type { PaymentProvider } from '../types';

export class StripePaymentProvider implements PaymentProvider {
  readonly type = 'STRIPE' as const;
  readonly capabilities = {
    checkout: true,
    subscriptions: true,
    trials: true,
    automaticPlanSync: true,
    proratedPlanChanges: true,
    scheduledPlanChanges: false,
    customerPortal: true,
    cancel: true,
    reactivate: true,
    refunds: false,
    invoices: true,
    pause: false,
    resume: false,
  } as const;

  async validateConfiguration(regionId: string) {
    const { getRegionalStripeClient } = await import('../../stripeClientService');
    await getRegionalStripeClient(regionId);
  }

  async createCheckout(input: Parameters<typeof createPaidCheckoutSession>[0]) {
    const result = input.mode === 'trial'
      ? await createTrialCheckoutSession(input)
      : await createPaidCheckoutSession(input);
    if (!result.url) throw new Error('Stripe did not return a checkout URL');
    return { ...result, url: result.url, provider: this.type };
  }
}
