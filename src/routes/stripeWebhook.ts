import { Request, Response } from 'express';
import Stripe from 'stripe';
import { prisma } from '../prismaClient';
import { decryptSecret } from '../services/secretCrypto';

function mapStripeStatus(status: string) {
  if (status === 'active' || status === 'trialing') return 'ACTIVE';
  if (status === 'past_due') return 'PAST_DUE';
  if (status === 'canceled') return 'CANCELED';
  return 'INCOMPLETE';
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

  const stripe = new Stripe(stripeSecretKey);

  let event: any;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      signature,
      stripeWebhookSecret
    );
  } catch (error: any) {
    return res.status(400).send(`Webhook signature verification failed: ${error.message}`);
  }

  const alreadyProcessed = await prisma.paymentEvent.findUnique({
    where: { eventId: event.id },
  });

  if (alreadyProcessed) {
    return res.json({ received: true, duplicate: true });
  }

  await prisma.paymentEvent.create({
    data: {
      provider: 'STRIPE',
      eventId: event.id,
      type: event.type,
    },
  });

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as any;

    const userId = session.metadata?.userId;
    const planId = session.metadata?.planId;
    const sessionRegionId = session.metadata?.regionId;

    if (userId && planId && sessionRegionId === regionId && session.subscription) {
      const subscriptionId =
        typeof session.subscription === 'string'
          ? session.subscription
          : session.subscription.id;

      const customerId =
        typeof session.customer === 'string'
          ? session.customer
          : session.customer?.id;

      await prisma.subscription.upsert({
        where: {
          stripeSubscriptionId: subscriptionId,
        },
        create: {
          userId,
          planId,
          regionId,
          status: 'ACTIVE',
          stripeCustomerId: customerId || null,
          stripeSubscriptionId: subscriptionId,
          stripeCheckoutSessionId: session.id,
          startsAt: new Date(),
          autoRenew: true,
        },
        update: {
          status: 'ACTIVE',
          planId,
          stripeCustomerId: customerId || null,
          stripeCheckoutSessionId: session.id,
          autoRenew: true,
        },
      });
    }
  }

  if (
    event.type === 'customer.subscription.updated' ||
    event.type === 'customer.subscription.deleted'
  ) {
    const stripeSub = event.data.object as any;

    const status =
      event.type === 'customer.subscription.deleted'
        ? 'CANCELED'
        : mapStripeStatus(stripeSub.status);

    const endsAt = stripeSub.current_period_end
      ? new Date(stripeSub.current_period_end * 1000)
      : null;

    await prisma.subscription.updateMany({
      where: {
        stripeSubscriptionId: stripeSub.id,
      },
      data: {
        status,
        endsAt,
        autoRenew: !stripeSub.cancel_at_period_end,
      },
    });
  }

  if (event.type === 'invoice.payment_failed') {
    const invoice = event.data.object as any;
    const subscriptionId = invoice.subscription;

    if (typeof subscriptionId === 'string') {
      await prisma.subscription.updateMany({
        where: {
          stripeSubscriptionId: subscriptionId,
        },
        data: {
          status: 'PAST_DUE',
        },
      });
    }
  }

  return res.json({ received: true });
}