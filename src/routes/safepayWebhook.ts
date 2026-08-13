import crypto from 'crypto';
import type { Request, Response } from 'express';
import { prisma } from '../prismaClient';
import { decryptSecret } from '../services/secretCrypto';
import { recordSafepayTransaction, syncSafepaySubscription } from '../services/billing/providers/safepay/safepaySubscriptionSyncService';
import { retrieveSafepaySubscription } from '../services/billing/providers/safepay/safepayClient';

export function extractSafepayWebhookResource(eventType: string, body: Record<string, any>) {
  const normalizedType = eventType.toLowerCase();
  const isSubscriptionEvent = normalizedType.startsWith('subscription.');
  const data = body.data && typeof body.data === 'object' ? body.data : {};
  const isPaymentEvent = normalizedType.includes('payment.') || normalizedType.startsWith('payment.');
  const transaction = data.transaction && typeof data.transaction === 'object'
    ? data.transaction
    : isPaymentEvent && (data.subscription_id || data.transaction_id ||
        (typeof data.id === 'string' && (data.id.startsWith('txn_') || data.id.startsWith('track_'))))
      ? data
      : null;
  let subscription: Record<string, any> | null = null;
  if (data.subscription && typeof data.subscription === 'object') {
    subscription = data.subscription;
  } else if (transaction?.subscription && typeof transaction.subscription === 'object') {
    subscription = transaction.subscription;
  } else if (isSubscriptionEvent &&
      ((typeof data.id === 'string' && data.id.startsWith('sub_')) ||
       (typeof data.token === 'string' && data.token.startsWith('sub_')))) {
    // Safepay webhook v2.0.0 lifecycle events put the subscription directly in body.data.
    subscription = data;
  }
  const subscriptionId = subscription?.id ?? subscription?.token ?? transaction?.subscription_id ?? transaction?.subscription_token;
  const reference = subscription?.reference ?? transaction?.reference ?? data.reference ?? subscription?.metadata?.reference;
  const planId = subscription?.plan_id ?? transaction?.plan_id ?? data.plan_id;
  const transactionId = transaction?.token ?? transaction?.id ?? transaction?.transaction_id ?? transaction?.tracker;
  return {
    eventType: normalizedType, data, transaction, subscription,
    subscriptionId: subscriptionId ? String(subscriptionId) : null,
    reference: reference ? String(reference) : null,
    planId: planId ? String(planId) : null,
    transactionId: transactionId ? String(transactionId) : null,
    status: subscription?.status ?? data.status ?? null,
  };
}

export function extractSafepayEventId(
  body: Record<string, any>,
  headers: Record<string, unknown>,
  signatureFallback: string,
) {
  return String(body.token ?? body.id ?? body.event_id ?? headers['x-sfpy-event-id'] ?? signatureFallback);
}

function safeEqualHex(expected: string, supplied: string) {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(supplied, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function computeSafepayWebhookSignature(data: unknown, secret: string) {
  return crypto.createHmac('sha512', secret).update(Buffer.from(JSON.stringify(data))).digest('hex');
}

export function verifySafepayWebhookSignature(body: Record<string, any>, signature: string, secret: string) {
  return safeEqualHex(computeSafepayWebhookSignature(body.data, secret), signature);
}

export function validateSafepayWebhookEnvelope(rawBody: unknown, signature: unknown) {
  if (typeof signature !== 'string') return 'Missing Safepay signature';
  if (!Buffer.isBuffer(rawBody)) return 'Safepay webhook body is not raw';
  return null;
}

export async function handleSafepayWebhook(req: Request, res: Response) {
  const { regionId } = req.params;
  const signature = req.headers['x-sfpy-signature'];
  console.info('[SAFEPAY-WEBHOOK-RECEIVED]', {
    provider: 'SAFEPAY', regionId,
    rawBodyPresent: Buffer.isBuffer(req.body),
    signaturePresent: typeof signature === 'string',
  });
  const envelopeError = validateSafepayWebhookEnvelope(req.body, signature);
  if (envelopeError) return res.status(400).send('Invalid webhook request');
  const config = await prisma.paymentConfig.findUnique({ where: { regionId } });
  const secret = decryptSecret(config?.safepayWebhookSecret);
  if (!secret) return res.status(400).send('Webhook is not configured');

  let body: Record<string, any>;
  try { body = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).send('Invalid webhook payload'); }
  // Safepay's official SDK signs JSON.stringify(body.data) using HMAC-SHA512.
  const expected = computeSafepayWebhookSignature(body.data, secret);
  if (!verifySafepayWebhookSignature(body, signature as string, secret)) return res.status(400).send('Webhook signature verification failed');
  console.info('[SAFEPAY-WEBHOOK-VERIFIED]', { regionId });

  const eventId = extractSafepayEventId(body, req.headers, expected);
  const eventType = String(body.type ?? body.event ?? req.headers['x-sfpy-event-type'] ?? 'unknown');
  const existing = await prisma.paymentEvent.findUnique({ where: { eventId } });
  if (existing?.status === 'PROCESSED') return res.json({ received: true, duplicate: true });
  await prisma.paymentEvent.upsert({
    where: { eventId },
    create: { provider: 'SAFEPAY', eventId, type: eventType, regionId, payload: body, attempts: 1 },
    update: { attempts: { increment: 1 }, status: 'RECEIVED', errorMessage: null },
  });
  console.info('[billing-webhook-event-persisted]', { provider: 'SAFEPAY', regionId, eventId, eventType });

  try {
    const normalizedType = eventType.toLowerCase();
    const resources = extractSafepayWebhookResource(eventType, body);
    console.info('[SAFEPAY-WEBHOOK-RESOURCE]', {
      regionId,
      eventId,
      eventType,
      localSubscriptionId: resources.reference,
      checkoutReference: resources.reference,
      reference: resources.reference,
      providerSubscriptionId: resources.subscriptionId,
      planId: resources.planId,
      providerStatus: resources.status ? String(resources.status) : null,
    });
    const isSubscriptionEvent = normalizedType.startsWith('subscription.');
    const isPaymentEvent = normalizedType === 'payment.succeeded' || normalizedType === 'payment.failed' ||
      normalizedType === 'payment.refunded' || normalizedType === 'payment.disputed' ||
      normalizedType === 'subscription.payment.succeeded' || normalizedType === 'subscription.payment.failed';
    let synced: any = null;
    let transaction: Awaited<ReturnType<typeof recordSafepayTransaction>> = null;

    if (isSubscriptionEvent && !normalizedType.startsWith('subscription.payment.')) {
      if (!resources.subscription) throw new Error('Missing Safepay subscription resource');
      // A verified lifecycle event already contains the authoritative resource.
      // Avoid making acknowledgement depend on another Safepay network request.
      synced = await syncSafepaySubscription(regionId, resources.subscription);
    } else if (isPaymentEvent && resources.subscriptionId) {
      const remote = await retrieveSafepaySubscription(regionId, resources.subscriptionId);
      synced = await syncSafepaySubscription(regionId, { ...remote, ...(resources.reference ? { reference: resources.reference } : {}) });
    }

    if (isPaymentEvent) {
      const outcome = normalizedType.includes('failed') ? 'FAILED'
        : normalizedType.includes('refunded') ? 'REFUNDED'
          : normalizedType.includes('disputed') ? 'DISPUTED' : 'SUCCEEDED';
      transaction = await recordSafepayTransaction(regionId, resources.transaction, outcome);
      console.info('[billing-webhook-transaction-recorded]', {
        provider: 'SAFEPAY', regionId, eventId, eventType,
        providerSubscriptionId: transaction?.providerSubscriptionId ?? resources.subscriptionId,
        localSubscriptionId: transaction?.localSubscriptionId ?? null,
        userId: transaction?.userId ?? null, transactionId: transaction?.transactionId ?? resources.transactionId,
        transactionStatus: transaction?.status ?? 'not-recorded',
      });
    }
    if (!synced && isSubscriptionEvent && !normalizedType.startsWith('subscription.payment.')) throw new Error('Missing Safepay subscription ID or resource');
    await prisma.paymentEvent.update({ where: { eventId }, data: { status: 'PROCESSED', processedAt: new Date() } });
    console.info('[billing-webhook-sync]', {
      provider: 'SAFEPAY', regionId, eventId, eventType,
      providerSubscriptionId: synced?.providerSubscriptionId ?? resources.subscriptionId,
      localSubscriptionId: synced?.id ?? null, userId: synced?.userId ?? null,
      providerStatus: synced?.providerStatus ?? null, normalizedStatus: synced?.status ?? null,
    });
    console.info('[billing-webhook-processed]', {
      provider: 'SAFEPAY', regionId, eventId, eventType,
      providerSubscriptionId: synced?.providerSubscriptionId ?? resources.subscriptionId,
      localSubscriptionId: synced?.id ?? transaction?.localSubscriptionId ?? null,
      userId: synced?.userId ?? transaction?.userId ?? null,
      providerStatus: synced?.providerStatus ?? null, normalizedStatus: synced?.status ?? null,
    });
    return res.json({ received: true });
  } catch (error) {
    await prisma.paymentEvent.update({ where: { eventId }, data: { status: 'FAILED', errorMessage: error instanceof Error ? error.message.slice(0, 500) : 'Processing failed' } });
    console.error('[billing-webhook]', { provider: 'SAFEPAY', regionId, eventId, eventType, message: error instanceof Error ? error.message : 'unknown' });
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
}
