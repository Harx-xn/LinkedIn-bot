import crypto from 'crypto';
import type { Request, Response } from 'express';
import { prisma } from '../prismaClient';
import { decryptSecret } from '../services/secretCrypto';
import { recordSafepayTransaction, syncSafepaySubscription } from '../services/billing/providers/safepay/safepaySubscriptionSyncService';

function safeEqualHex(expected: string, supplied: string) {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(supplied, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function handleSafepayWebhook(req: Request, res: Response) {
  const { regionId } = req.params;
  const signature = req.headers['x-sfpy-signature'];
  if (typeof signature !== 'string' || !Buffer.isBuffer(req.body)) return res.status(400).send('Invalid webhook request');
  const config = await prisma.paymentConfig.findUnique({ where: { regionId } });
  const secret = decryptSecret(config?.safepayWebhookSecret);
  if (!secret) return res.status(400).send('Webhook is not configured');

  let body: Record<string, any>;
  try { body = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).send('Invalid webhook payload'); }
  // Safepay's official SDK signs JSON.stringify(body.data) using HMAC-SHA512.
  const signedPayload = Buffer.from(JSON.stringify(body.data));
  const expected = crypto.createHmac('sha512', secret).update(signedPayload).digest('hex');
  if (!safeEqualHex(expected, signature)) return res.status(400).send('Webhook signature verification failed');

  const eventId = String(body.id ?? body.event_id ?? req.headers['x-sfpy-event-id'] ?? expected);
  const eventType = String(body.type ?? body.event ?? req.headers['x-sfpy-event-type'] ?? 'unknown');
  const existing = await prisma.paymentEvent.findUnique({ where: { eventId } });
  if (existing?.status === 'PROCESSED') return res.json({ received: true, duplicate: true });
  await prisma.paymentEvent.upsert({
    where: { eventId },
    create: { provider: 'SAFEPAY', eventId, type: eventType, regionId, payload: body, attempts: 1 },
    update: { attempts: { increment: 1 }, status: 'RECEIVED', errorMessage: null },
  });

  try {
    const data = (body.data?.subscription ?? body.data?.transaction ?? body.data) as Record<string, any>;
    const normalizedType = eventType.toLowerCase();
    if (normalizedType.includes('subscription') || data?.plan_id) await syncSafepaySubscription(regionId, data);
    if (normalizedType.includes('payment') || normalizedType.includes('transaction')) {
      const failed = normalizedType.includes('fail') || String(data?.status ?? '').toUpperCase().includes('FAIL');
      await recordSafepayTransaction(regionId, data, !failed);
    }
    await prisma.paymentEvent.update({ where: { eventId }, data: { status: 'PROCESSED', processedAt: new Date() } });
    return res.json({ received: true });
  } catch (error) {
    await prisma.paymentEvent.update({ where: { eventId }, data: { status: 'FAILED', errorMessage: error instanceof Error ? error.message.slice(0, 500) : 'Processing failed' } });
    console.error('[billing-webhook]', { provider: 'SAFEPAY', regionId, eventId, eventType, message: error instanceof Error ? error.message : 'unknown' });
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
}
