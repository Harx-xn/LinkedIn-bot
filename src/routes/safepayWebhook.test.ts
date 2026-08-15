import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { BillingAccessStatus, UserRole } from '@prisma/client';
import type { Request, Response } from 'express';
import { prisma } from '../prismaClient';
import {
  computeSafepayWebhookSignature,
  extractSafepayEventId,
  extractSafepayWebhookResource,
  handleSafepayWebhook,
} from './safepayWebhook';

const WEBHOOK_SECRET = 'test-webhook-secret';
const REGION_ID = 'region123';
const LOCAL_SUBSCRIPTION_ID = '21b0db92-6cba-4f6c-95f2-b7b5e5f01e98';
const PROVIDER_SUBSCRIPTION_ID = 'sub_660a75c1-2297-487a-9701-c162c5d0c4d0';
const EVENT_ID = 'evt_0456ae3d-7c53-443d-ad6b-d4f60f995da3';

const observedPayload = {
  token: EVENT_ID,
  version: '2.0.0',
  merchant_api_key: 'sec_test',
  type: 'subscription.created',
  endpoint: 'https://example.com/api/payments/webhook/safepay/region123',
  data: {
    id: PROVIDER_SUBSCRIPTION_ID,
    plan_id: 'plan_be28985f-df2e-4518-a173-c3358897d5b8',
    status: 'TRIALING',
    amount: 2500,
    currency: 'USD',
    reference: LOCAL_SUBSCRIPTION_ID,
    expires: true,
  },
};

type MutableState = ReturnType<typeof makeState>;

function makeState(reference = LOCAL_SUBSCRIPTION_ID) {
  return {
    user: {
      id: 'user123', role: UserRole.USER, regionId: REGION_ID,
      trialStartedAt: null as Date | null, trialEndsAt: null as Date | null,
      trialRedeemedAt: null as Date | null,
      billingAccessStatus: BillingAccessStatus.INCOMPLETE,
      stripeCustomerId: null, isBillingExempt: false,
    },
    subscription: {
      id: reference, userId: 'user123', regionId: REGION_ID, planId: 'local-plan-123',
      provider: 'SAFEPAY', status: 'INCOMPLETE', providerStatus: 'CHECKOUT_PENDING',
      providerSubscriptionId: null as string | null, stripeSubscriptionId: null,
      providerPaymentMethodPresent: false, stripeDefaultPaymentMethodId: null,
      paymentFailedAt: null, currentPeriodEnd: null, trialEnd: null,
      plan: { id: 'local-plan-123' },
    },
    events: new Map<string, any>(),
    subscriptionUpdates: 0,
  };
}

const originals: Array<[object, string, unknown]> = [];
function replace(target: object, key: string, value: unknown) {
  originals.push([target, key, (target as any)[key]]);
  (target as any)[key] = value;
}

function installPrismaFakes(state: MutableState) {
  replace(prisma.paymentConfig, 'findUnique', async () => ({
    regionId: REGION_ID, provider: 'SAFEPAY', isActive: true,
    safepayEnvironment: 'SANDBOX', safepayPublicKey: 'public-test',
    safepaySecretKey: 'secret-test', safepayWebhookSecret: WEBHOOK_SECRET,
  }));
  replace(prisma.planProviderMapping, 'findUnique', async () => ({
    providerPlanId: observedPayload.data.plan_id,
  }));
  replace(prisma.paymentEvent, 'findUnique', async ({ where }: any) => state.events.get(where.eventId) ?? null);
  replace(prisma.paymentEvent, 'upsert', async ({ where, create, update }: any) => {
    const current = state.events.get(where.eventId);
    const event = current
      ? { ...current, ...update, attempts: current.attempts + 1 }
      : { ...create, status: 'RECEIVED', processedAt: null, errorMessage: null };
    state.events.set(where.eventId, event);
    return event;
  });
  replace(prisma.paymentEvent, 'update', async ({ where, data }: any) => {
    const event = { ...state.events.get(where.eventId), ...data };
    state.events.set(where.eventId, event);
    return event;
  });
  replace(prisma.subscription, 'findFirst', async ({ where }: any) => {
    if (where.provider === 'SAFEPAY' && where.regionId === REGION_ID && where.OR) {
      const matchesReference = where.OR.some((clause: any) => clause.id === state.subscription.id);
      const matchesProviderId = where.OR.some((clause: any) =>
        clause.providerSubscriptionId && clause.providerSubscriptionId === state.subscription.providerSubscriptionId);
      return matchesReference || matchesProviderId ? state.subscription : null;
    }
    if (where.userId === state.user.id) {
      return ['TRIALING', 'ACTIVE'].includes(state.subscription.status) ? state.subscription : null;
    }
    return null;
  });
  replace(prisma.subscription, 'update', async ({ where, data }: any) => {
    assert.equal(where.id, state.subscription.id);
    Object.assign(state.subscription, data);
    state.subscriptionUpdates += 1;
    return state.subscription;
  });
  replace(prisma.user, 'findUnique', async ({ where }: any) => where.id === state.user.id ? state.user : null);
  replace(prisma.user, 'update', async ({ where, data }: any) => {
    assert.equal(where.id, state.user.id);
    Object.assign(state.user, data);
    return state.user;
  });
}

function requestFor(payload: typeof observedPayload): Request {
  const rawBody = Buffer.from(JSON.stringify(payload));
  const signature = computeSafepayWebhookSignature(rawBody, WEBHOOK_SECRET);
  return {
    params: { regionId: REGION_ID },
    method: 'POST',
    headers: { 'x-sfpy-signature': signature, 'content-type': 'application/json' },
    body: rawBody,
  } as unknown as Request;
}

function responseRecorder() {
  const result = { statusCode: 200, body: undefined as any };
  const response = {
    status(code: number) { result.statusCode = code; return this; },
    json(body: any) { result.body = body; return this; },
    send(body: any) { result.body = body; return this; },
  } as unknown as Response;
  return { response, result };
}

describe('Safepay webhook v2.0.0 subscription.created regression', () => {
  beforeEach(() => { originals.length = 0; });
  afterEach(() => {
    for (const [target, key, value] of originals.reverse()) (target as any)[key] = value;
  });

  it('extracts the exact observed direct subscription resource and event token', () => {
    const resource = extractSafepayWebhookResource(observedPayload.type, observedPayload);
    assert.equal(extractSafepayEventId(observedPayload, {}, 'fallback'), EVENT_ID);
    assert.equal(resource.subscriptionId, PROVIDER_SUBSCRIPTION_ID);
    assert.equal(resource.reference, LOCAL_SUBSCRIPTION_ID);
    assert.equal(resource.planId, observedPayload.data.plan_id);
    assert.equal(resource.status, 'TRIALING');
    assert.equal(resource.subscription, observedPayload.data);
  });

  it('returns 200, processes the event, correlates once, and unlocks TRIALING access', async () => {
    const state = makeState();
    installPrismaFakes(state);

    const first = responseRecorder();
    await handleSafepayWebhook(requestFor(observedPayload), first.response);

    assert.equal(first.result.statusCode, 200);
    assert.deepEqual(first.result.body, { received: true });
    assert.equal(state.events.get(EVENT_ID).status, 'PROCESSED');
    assert.equal(state.events.get(EVENT_ID).eventId, EVENT_ID);
    assert.equal(state.subscription.providerSubscriptionId, PROVIDER_SUBSCRIPTION_ID);
    assert.equal(state.subscription.providerStatus, 'TRIALING');
    assert.equal(state.subscription.status, 'TRIALING');
    assert.equal(state.user.billingAccessStatus, BillingAccessStatus.TRIALING);
    assert.equal(state.subscriptionUpdates, 1);

    const duplicate = responseRecorder();
    await handleSafepayWebhook(requestFor(observedPayload), duplicate.response);
    assert.equal(duplicate.result.statusCode, 200);
    assert.deepEqual(duplicate.result.body, { received: true, duplicate: true });
    assert.equal(state.subscriptionUpdates, 1);
  });

  it('rejects an invalid signature before persisting or parsing the event', async () => {
    const state = makeState();
    installPrismaFakes(state);
    const request = requestFor(observedPayload);
    request.headers['x-sfpy-signature'] = '0'.repeat(128);
    const response = responseRecorder();

    await handleSafepayWebhook(request, response.response);

    assert.equal(response.result.statusCode, 400);
    assert.equal(state.events.size, 0);
    assert.equal(state.subscriptionUpdates, 0);
  });

  it('signs the exact raw webhook bytes, including insignificant JSON whitespace', () => {
    const compact = Buffer.from(JSON.stringify(observedPayload));
    const spaced = Buffer.from(JSON.stringify(observedPayload, null, 2));
    assert.notEqual(
      computeSafepayWebhookSignature(compact, WEBHOOK_SECRET),
      computeSafepayWebhookSignature(spaced, WEBHOOK_SECRET),
    );
  });

  it('persists FAILED and returns non-2xx when the reference cannot correlate', async () => {
    const state = makeState('different-local-subscription-id');
    installPrismaFakes(state);
    const response = responseRecorder();

    await handleSafepayWebhook(requestFor(observedPayload), response.response);

    assert.equal(response.result.statusCode, 500);
    assert.deepEqual(response.result.body, { error: 'Webhook processing failed' });
    assert.equal(state.events.get(EVENT_ID).status, 'FAILED');
    assert.match(state.events.get(EVENT_ID).errorMessage, /No local pending subscription matched provider reference/);
    assert.equal(state.subscriptionUpdates, 0);
  });
});
