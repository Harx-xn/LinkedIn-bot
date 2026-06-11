import type { StripeSubscriptionLike } from '../subscriptionAdminService';

export interface StripeCheckoutSessionLike {
  id: string;
  metadata?: Record<string, string> | null;
  subscription?: string | { id: string; default_payment_method?: string | { id: string } | null } | null;
  customer?: string | { id: string } | null;
  payment_status?: string | null;
  status?: string | null;
  setup_intent?: string | { payment_method?: string | { id: string } | null } | null;
  payment_intent?: string | { payment_method?: string | { id: string } | null } | null;
}

export interface StripeSubscriptionFull extends StripeSubscriptionLike {
  id: string;
  status: string;
  customer?: string | { id: string } | null;
  trial_start?: number | null;
  trial_end?: number | null;
  current_period_start?: number;
  current_period_end?: number;
  canceled_at?: number | null;
  cancel_at_period_end?: boolean;
  default_payment_method?: string | { id: string } | null;
}

export interface StripeInvoiceLike {
  id: string;
  subscription?: string | { id: string } | null;
}

export interface StripePaymentMethodLike {
  id: string;
  customer?: string | { id: string } | null;
}

export interface StripeWebhookEventLike {
  id: string;
  type: string;
  created: number;
  data: { object: unknown };
}
