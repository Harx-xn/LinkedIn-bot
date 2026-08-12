export type PaymentProviderType = 'STRIPE' | 'SAFEPAY';
export type PaymentEnvironment = 'SANDBOX' | 'LIVE';

export interface PaymentProviderCapabilities {
  checkout: boolean;
  subscriptions: boolean;
  trials: boolean;
  automaticPlanSync: boolean;
  proratedPlanChanges: boolean;
  scheduledPlanChanges: boolean;
  customerPortal: boolean;
  cancel: boolean;
  reactivate: boolean;
  refunds: boolean;
  invoices: boolean;
  pause: boolean;
  resume: boolean;
}

export interface ProviderCheckoutInput {
  userId: string;
  planId: string;
  promoCode?: string;
  inviteCode?: string;
  mode: 'trial' | 'paid';
}

export interface ProviderCheckoutResult {
  url: string;
  sessionId: string;
  provider: PaymentProviderType;
}

export interface PaymentProvider {
  readonly type: PaymentProviderType;
  readonly capabilities: PaymentProviderCapabilities;
  validateConfiguration(regionId: string): Promise<void>;
  createCheckout(input: ProviderCheckoutInput): Promise<ProviderCheckoutResult>;
}

