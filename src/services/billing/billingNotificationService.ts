import { createNotification } from './notificationService';

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export async function notifyTrialActivated(userId: string, trialEndsAt: Date, dedupeKey: string) {
  return createNotification({
    userId,
    type: 'TRIAL_ACTIVATED',
    title: 'Free trial started',
    message: `Your free trial is active until ${formatDate(trialEndsAt)}. Your saved payment method will be charged when the trial ends unless you cancel.`,
    dedupeKey,
  });
}

export async function notifyTrialEndingSoon(
  userId: string,
  trialEndsAt: Date,
  subscriptionId: string,
) {
  return createNotification({
    userId,
    type: 'TRIAL_ENDING_SOON',
    title: 'Trial ending soon',
    message: `Your free trial ends on ${formatDate(trialEndsAt)}. Your saved payment method will be charged unless you cancel from Billing.`,
    dedupeKey: `trial_will_end:${subscriptionId}:${trialEndsAt.toISOString()}`,
  });
}

export async function notifySubscriptionActivated(userId: string, planName: string, dedupeKey: string) {
  return createNotification({
    userId,
    type: 'SUBSCRIPTION_ACTIVATED',
    title: 'Subscription active',
    message: `Your ${planName} subscription is now active.`,
    dedupeKey,
  });
}

export async function notifyPlanUpgrade(userId: string, planName: string, dedupeKey: string) {
  return createNotification({
    userId,
    type: 'PLAN_UPGRADED',
    title: 'Plan upgraded',
    message: `Your plan has been upgraded to ${planName}.`,
    dedupeKey,
  });
}

export async function notifyDowngradeScheduled(
  userId: string,
  planName: string,
  effectiveAt: Date,
  dedupeKey: string,
) {
  return createNotification({
    userId,
    type: 'DOWNGRADE_SCHEDULED',
    title: 'Plan change scheduled',
    message: `Your plan will change to ${planName} on ${formatDate(effectiveAt)}.`,
    dedupeKey,
  });
}

export async function notifyCancellationScheduled(
  userId: string,
  effectiveAt: Date,
  dedupeKey: string,
) {
  return createNotification({
    userId,
    type: 'CANCELLATION_SCHEDULED',
    title: 'Cancellation scheduled',
    message: `Your subscription will end on ${formatDate(effectiveAt)}. You keep access until then.`,
    dedupeKey,
  });
}

export async function notifyReactivated(userId: string, dedupeKey: string) {
  return createNotification({
    userId,
    type: 'SUBSCRIPTION_REACTIVATED',
    title: 'Cancellation reversed',
    message: 'Your subscription will continue renewing as scheduled.',
    dedupeKey,
  });
}

export async function notifySubscriptionCanceled(userId: string, dedupeKey: string) {
  return createNotification({
    userId,
    type: 'SUBSCRIPTION_CANCELED',
    title: 'Subscription ended',
    message: 'Your subscription has ended. Visit Billing to subscribe again.',
    dedupeKey,
  });
}

export async function notifyPaymentFailed(userId: string, dedupeKey: string) {
  return createNotification({
    userId,
    type: 'PAYMENT_FAILED',
    title: 'Payment failed',
    message: 'We could not process your latest payment. Update your payment method in Billing.',
    dedupeKey,
  });
}

export async function notifyPaymentActionRequired(userId: string, dedupeKey: string) {
  return createNotification({
    userId,
    type: 'PAYMENT_ACTION_REQUIRED',
    title: 'Payment authentication required',
    message: 'Additional verification is required to complete your payment. Open Billing to continue.',
    dedupeKey,
  });
}

export async function notifyPaymentMethodUpdated(userId: string, dedupeKey: string) {
  return createNotification({
    userId,
    type: 'PAYMENT_METHOD_UPDATED',
    title: 'Payment method updated',
    message: 'Your payment method was updated successfully.',
    dedupeKey,
  });
}

export async function notifyRefundIssued(userId: string, dedupeKey: string) {
  return createNotification({
    userId,
    type: 'REFUND_ISSUED',
    title: 'Refund issued',
    message: 'A refund has been issued to your payment method. It may take a few days to appear.',
    dedupeKey,
  });
}

export async function notifyDisputeOpened(userId: string, dedupeKey: string) {
  return createNotification({
    userId,
    type: 'DISPUTE_OPENED',
    title: 'Payment dispute opened',
    message: 'A dispute was opened on a recent charge. Our team may contact you for details.',
    dedupeKey,
  });
}
