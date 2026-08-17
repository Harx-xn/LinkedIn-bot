import { Prisma } from '@prisma/client';
import { prisma } from '../../prismaClient';
import { sendSubscriptionEmail } from '../email/emailService';
import type { SubscriptionEmailEventType } from '../email/subscriptionEmailTemplates';

type ConfirmedStatus = 'ACTIVE' | 'TRIALING';
type SubscriptionForEmail = {
  id: string; userId: string; status: string; currentPeriodEnd: Date | null; trialEnd: Date | null;
  user: { email: string; username: string };
  plan: { name: string; price: number; currency: string; billingCycle: string };
};

export interface SubscriptionEmailDependencies {
  findSubscription(id: string): Promise<SubscriptionForEmail | null>;
  createDelivery(data: { subscriptionId: string; userId: string; eventType: SubscriptionEmailEventType }): Promise<{ id: string }>;
  claimFailedDelivery(data: { subscriptionId: string; eventType: SubscriptionEmailEventType }): Promise<{ id: string } | null>;
  markSent(id: string, messageId: string | null): Promise<unknown>;
  markFailed(id: string, message: string): Promise<unknown>;
  send: typeof sendSubscriptionEmail;
}

const defaultDependencies: SubscriptionEmailDependencies = {
  findSubscription: (id) => prisma.subscription.findUnique({
    where: { id },
    select: {
      id: true, userId: true, status: true, currentPeriodEnd: true, trialEnd: true,
      user: { select: { email: true, username: true } },
      plan: { select: { name: true, price: true, currency: true, billingCycle: true } },
    },
  }),
  createDelivery: (data) => prisma.subscriptionEmailDelivery.create({ data, select: { id: true } }),
  claimFailedDelivery: async (data) => {
    const existing = await prisma.subscriptionEmailDelivery.findUnique({
      where: { subscriptionId_eventType: data },
      select: { id: true, status: true },
    });
    if (!existing || existing.status !== 'FAILED') return null;
    const claimed = await prisma.subscriptionEmailDelivery.updateMany({
      where: { id: existing.id, status: 'FAILED' },
      data: { status: 'PENDING', failedAt: null, errorMessage: null },
    });
    return claimed.count === 1 ? { id: existing.id } : null;
  },
  markSent: (id, messageId) => prisma.subscriptionEmailDelivery.update({ where: { id }, data: { status: 'SENT', sentAt: new Date(), messageId } }),
  markFailed: (id, message) => prisma.subscriptionEmailDelivery.update({ where: { id }, data: { status: 'FAILED', failedAt: new Date(), errorMessage: message.slice(0, 500) } }),
  send: sendSubscriptionEmail,
};

export function emailEventForSubscriptionStatus(status: string): SubscriptionEmailEventType | null {
  if (status === 'ACTIVE') return 'SUBSCRIPTION_CONFIRMED';
  if (status === 'TRIALING') return 'TRIAL_STARTED';
  return null;
}

export async function sendConfirmedSubscriptionEmail(subscriptionId: string, dependencies: SubscriptionEmailDependencies = defaultDependencies) {
  const subscription = await dependencies.findSubscription(subscriptionId);
  if (!subscription) return { outcome: 'NOT_FOUND' as const };
  const eventType = emailEventForSubscriptionStatus(subscription.status);
  if (!eventType) return { outcome: 'NOT_ELIGIBLE' as const };

  let delivery: { id: string };
  try {
    delivery = await dependencies.createDelivery({ subscriptionId: subscription.id, userId: subscription.userId, eventType });
  } catch (error) {
    if ((error instanceof Prisma.PrismaClientKnownRequestError || typeof error === 'object') && (error as { code?: string }).code === 'P2002') {
      const retryDelivery = await dependencies.claimFailedDelivery({ subscriptionId: subscription.id, eventType });
      if (retryDelivery) {
        delivery = retryDelivery;
        console.info('[EMAIL_RETRY_STARTED]', { deliveryId: delivery.id, subscriptionId: subscription.id, userId: subscription.userId, eventType });
      } else {
      console.info('[EMAIL_ALREADY_SENT]', { subscriptionId: subscription.id, userId: subscription.userId, eventType });
      return { outcome: 'ALREADY_RECORDED' as const };
      }
    } else {
      throw error;
    }
  }

  console.info('[EMAIL_SEND_STARTED]', { deliveryId: delivery.id, subscriptionId: subscription.id, userId: subscription.userId, eventType });
  try {
    const sent = await dependencies.send({
      eventType,
      to: subscription.user.email,
      data: {
        recipientName: subscription.user.username,
        planName: subscription.plan.name,
        amount: subscription.plan.price,
        currency: subscription.plan.currency,
        billingCycle: subscription.plan.billingCycle,
        trialEndsAt: subscription.trialEnd,
        nextBillingAt: subscription.currentPeriodEnd,
      },
    });
    await dependencies.markSent(delivery.id, sent.messageId);
    console.info('[EMAIL_SEND_SUCCESS]', { deliveryId: delivery.id, subscriptionId: subscription.id, userId: subscription.userId, eventType });
    return { outcome: 'SENT' as const };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Email delivery failed';
    await dependencies.markFailed(delivery.id, message).catch(() => undefined);
    console.error('[EMAIL_SEND_FAILED]', { deliveryId: delivery.id, subscriptionId: subscription.id, userId: subscription.userId, eventType, message });
    return { outcome: 'FAILED' as const };
  }
}

export async function safelySendConfirmedSubscriptionEmail(subscription: { id: string; status: string } | null | undefined) {
  if (!subscription || !emailEventForSubscriptionStatus(subscription.status)) return;
  try {
    await sendConfirmedSubscriptionEmail(subscription.id);
  } catch (error) {
    console.error('[EMAIL_SEND_FAILED]', {
      subscriptionId: subscription.id,
      eventType: emailEventForSubscriptionStatus(subscription.status as ConfirmedStatus),
      message: error instanceof Error ? error.message : 'Email dispatch failed',
    });
  }
}
