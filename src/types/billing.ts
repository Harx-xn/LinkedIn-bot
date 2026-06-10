export type BillingErrorCode =
  | 'TRIAL_ALREADY_USED'
  | 'SUBSCRIPTION_ALREADY_EXISTS'
  | 'PLAN_NOT_FOUND'
  | 'PLAN_NOT_CONFIGURED_IN_STRIPE'
  | 'STRIPE_NOT_CONFIGURED'
  | 'PAYMENT_METHOD_REQUIRED'
  | 'PAYMENT_ACTION_REQUIRED'
  | 'SUBSCRIPTION_NOT_MANAGEABLE'
  | 'PROMO_INVALID'
  | 'REGION_MISMATCH'
  | 'CHECKOUT_FAILED';

export type SubscriptionDisplayStatus =
  | 'TRIALING'
  | 'ACTIVE'
  | 'PAST_DUE'
  | 'PAYMENT_ACTION_REQUIRED'
  | 'INCOMPLETE'
  | 'PAUSED'
  | 'CANCELED'
  | null;

export type PlanRelationship = 'CURRENT' | 'UPGRADE' | 'DOWNGRADE' | 'AVAILABLE';

export type RecommendedBillingAction =
  | 'START_TRIAL'
  | 'SUBSCRIBE'
  | 'MANAGE'
  | 'UPDATE_PAYMENT_METHOD'
  | 'COMPLETE_AUTHENTICATION'
  | 'REACTIVATE'
  | null;

export type CheckoutPollStatus =
  | 'PROCESSING'
  | 'TRIALING'
  | 'ACTIVE'
  | 'INCOMPLETE'
  | 'FAILED';

export const MANAGEABLE_SUBSCRIPTION_STATUSES = [
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'PAYMENT_ACTION_REQUIRED',
  'INCOMPLETE',
  'PAUSED',
] as const;

export type ManageableSubscriptionStatus = (typeof MANAGEABLE_SUBSCRIPTION_STATUSES)[number];

export const ACCESS_GRANTING_BILLING_STATUSES = [
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
] as const;
