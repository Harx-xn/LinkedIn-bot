import { Request, Response } from 'express';
import Stripe from 'stripe';
import { prisma } from '../prismaClient';
import { decryptSecret } from '../services/secretCrypto';
import { sanitizeExternalError } from '../services/billing/billingError';
import {
  handleCheckoutSessionCompleted,
  handleInvoiceEvent,
  handlePaymentMethodAttached,
  handleTrialWillEnd,
  syncSubscriptionFromStripe,
} from '../services/billing/stripeSubscriptionSyncService';
import {
  notifyDisputeOpened,
  notifyRefundIssued,
} from '../services/billing/billingNotificationService';
import type { StripeWebhookEventLike } from '../services/billing/stripeTypes';
import type {
  StripeCheckoutSessionLike,
  StripeInvoiceLike,
  StripePaymentMethodLike,
  StripeSubscriptionFull,
} from '../services/billing/stripeTypes';

type StripeClient = InstanceType<typeof Stripe>;

async function beginPaymentEvent(event: StripeWebhookEventLike) {
  const existing = await prisma.paymentEvent.findUnique({
    where: { eventId: event.id },
  });

  if (existing?.status === 'PROCESSED') {
    return { skip: true as const, row: existing };
  }

  const row = await prisma.paymentEvent.upsert({
    where: { eventId: event.id },
    create: {
      provider: 'STRIPE',
      eventId: event.id,
      type: event.type,
      stripeCreatedAt: new Date(event.created * 1000),
      status: 'RECEIVED',
      attempts: 1,
    },
    update: {
      attempts: { increment: 1 },
      status: 'RECEIVED',
      errorMessage: null,
    },
  });

  return { skip: false as const, row };
}

async function completePaymentEvent(eventId: string) {
  await prisma.paymentEvent.update({
    where: { eventId },
    data: { status: 'PROCESSED', processedAt: new Date() },
  });
}

async function failPaymentEvent(eventId: string, error: unknown) {
  await prisma.paymentEvent.update({
    where: { eventId },
    data: {
      status: 'FAILED',
      errorMessage: sanitizeExternalError(error),
    },
  });
}

export async function handleStripeWebhook(req: Request, res: Response) {
  const { regionId } = req.params;
  const signature = req.headers['stripe-signature'];

  if (!signature || typeof signature !== 'string') {
    return res.status(400).send('Missing Stripe signature');
  }

  const paymentConfig = await prisma.paymentConfig.findUnique({
    where: { regionId },
  });

  const stripeSecretKey = decryptSecret(paymentConfig?.stripeSecretKey);
  const stripeWebhookSecret = decryptSecret(paymentConfig?.stripeWebhookSecret);

  if (!stripeSecretKey || !stripeWebhookSecret) {
    return res.status(400).send('Stripe webhook is not configured for this region');
  }

  const stripe: StripeClient = new Stripe(stripeSecretKey);

  let event: StripeWebhookEventLike;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      signature,
      stripeWebhookSecret,
    ) as StripeWebhookEventLike;
  } catch {
    return res.status(400).send('Webhook signature verification failed');
  }

  const begun = await beginPaymentEvent(event);
  if (begun.skip) {
    return res.json({ received: true, duplicate: true });
  }

  const sourceEvent = { id: event.id, type: event.type, created: event.created };

  try {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object as StripeCheckoutSessionLike;
        await handleCheckoutSessionCompleted({
          stripe,
          session,
          expectedRegionId: regionId,
          sourceEvent,
        });
        break;
      }
      case 'checkout.session.async_payment_failed': {
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
      case 'customer.subscription.paused':
      case 'customer.subscription.resumed': {
        const stripeSub = event.data.object as StripeSubscriptionFull;
        const metaRegion = stripeSub.metadata?.regionId;
        if (metaRegion && metaRegion !== regionId) break;
        await syncSubscriptionFromStripe({
          stripe,
          stripeSubscription: stripeSub,
          expectedRegionId: regionId,
          sourceEvent,
        });
        break;
      }
      case 'customer.subscription.trial_will_end': {
        const stripeSub = event.data.object as StripeSubscriptionFull;
        await handleTrialWillEnd({
          stripeSub,
          expectedRegionId: regionId,
          sourceEvent,
        });
        break;
      }
      case 'invoice.paid':
      case 'invoice.payment_failed':
      case 'invoice.payment_action_required': {
        const invoice = event.data.object as StripeInvoiceLike;
        await handleInvoiceEvent({
          stripe,
          invoice,
          expectedRegionId: regionId,
          eventType: event.type,
          sourceEvent,
        });
        break;
      }
      case 'payment_method.attached': {
        const pm = event.data.object as StripePaymentMethodLike;
        await handlePaymentMethodAttached({
          paymentMethod: pm,
          expectedRegionId: regionId,
          sourceEvent,
        });
        break;
      }
      case 'charge.refunded': {
        const charge = event.data.object as {
          customer?: string | { id: string } | null;
        };
        const customerId =
          typeof charge.customer === 'string' ? charge.customer : charge.customer?.id;
        if (customerId) {
          const user = await prisma.user.findFirst({
            where: { stripeCustomerId: customerId, regionId },
            select: { id: true },
          });
          if (user) await notifyRefundIssued(user.id, event.id);
        }
        break;
      }
      case 'charge.dispute.created': {
        const dispute = event.data.object as { charge?: string | { id: string } | null };
        const chargeId =
          typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id;
        if (chargeId) {
          const charge = await stripe.charges.retrieve(chargeId);
          const customerId =
            typeof charge.customer === 'string' ? charge.customer : charge.customer?.id;
          if (customerId) {
            const user = await prisma.user.findFirst({
              where: { stripeCustomerId: customerId, regionId },
              select: { id: true },
            });
            if (user) await notifyDisputeOpened(user.id, event.id);
          }
        }
        break;
      }
      default:
        break;
    }

    await completePaymentEvent(event.id);
    return res.json({ received: true });
  } catch (error) {
    await failPaymentEvent(event.id, error);
    console.error('[stripe-webhook]', sanitizeExternalError(error));
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
}
