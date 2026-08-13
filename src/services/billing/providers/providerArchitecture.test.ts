import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { getPaymentProvider } from './providerFactory';
import { mapSafepayStatusToLocal } from './safepay/safepaySubscriptionSyncService';
import { subscriptionAllowsConfirmedAccess } from '../billingAccessService';
import { decryptSecret, encryptSecret } from '../../secretCrypto';
import { normalizeCheckoutReference } from '../../../routes/payments';
import {
  computeSafepayWebhookSignature,
  extractSafepayWebhookResource,
  verifySafepayWebhookSignature,
  validateSafepayWebhookEnvelope,
} from '../../../routes/safepayWebhook';

describe('payment provider abstraction', () => {
  it('resolves Stripe with existing capabilities', () => {
    const provider = getPaymentProvider('STRIPE');
    assert.equal(provider.type, 'STRIPE');
    assert.equal(provider.capabilities.customerPortal, true);
    assert.equal(provider.capabilities.proratedPlanChanges, true);
  });
  it('resolves Safepay with documented capabilities', () => {
    const provider = getPaymentProvider('SAFEPAY');
    assert.equal(provider.type, 'SAFEPAY');
    assert.equal(provider.capabilities.pause, true);
    assert.equal(provider.capabilities.automaticPlanSync, false);
    assert.equal(provider.capabilities.proratedPlanChanges, false);
  });
  it('rejects config-only and unsupported automated providers', () => {
    assert.throws(() => getPaymentProvider('PAYPAL'), /not available/i);
    assert.throws(() => getPaymentProvider('UNKNOWN'), /not available/i);
  });
});

describe('Safepay normalization and security', () => {
  it('maps provider statuses into canonical local states', () => {
    assert.equal(mapSafepayStatusToLocal('TRAILING'), 'TRIALING');
    assert.equal(mapSafepayStatusToLocal('trial'), 'TRIALING');
    assert.equal(mapSafepayStatusToLocal('ACTIVE'), 'ACTIVE');
    assert.equal(mapSafepayStatusToLocal('UNPAID'), 'PAST_DUE');
    assert.equal(mapSafepayStatusToLocal('PAUSED'), 'PAUSED');
    assert.equal(mapSafepayStatusToLocal('ENDED'), 'CANCELED');
    assert.equal(mapSafepayStatusToLocal('something-new'), 'INCOMPLETE');
  });
  it('grants access for verified Safepay trials and paid subscriptions', () => {
    for (const status of ['TRIALING', 'ACTIVE']) {
      assert.equal(subscriptionAllowsConfirmedAccess({
        provider: 'SAFEPAY', status, providerSubscriptionId: 'sub_safe_1', paymentMethodPresent: false,
      }), true);
    }
  });
  it('keeps failed Safepay subscriptions locked and Stripe instrument checks unchanged', () => {
    assert.equal(subscriptionAllowsConfirmedAccess({
      provider: 'SAFEPAY', status: 'PAST_DUE', providerSubscriptionId: 'sub_safe_1', paymentMethodPresent: true,
    }), false);
    assert.equal(subscriptionAllowsConfirmedAccess({
      provider: 'STRIPE', status: 'ACTIVE', providerSubscriptionId: 'sub_stripe_1', paymentMethodPresent: false,
    }), false);
  });
  it('reconciles payment-first events and delayed checkout confirmation server-side', () => {
    const webhook = readFileSync(join(process.cwd(), 'src/routes/safepayWebhook.ts'), 'utf8');
    const payments = readFileSync(join(process.cwd(), 'src/routes/payments.ts'), 'utf8');
    const sync = readFileSync(join(process.cwd(), 'src/services/billing/providers/safepay/safepaySubscriptionSyncService.ts'), 'utf8');
    assert.ok(webhook.includes('retrieveSafepaySubscription(regionId, resources.subscriptionId)'));
    assert.ok(sync.includes('provider_providerTransactionId'));
    assert.ok(payments.includes('reconcileSafepaySubscription(providerSub.regionId, providerSub.id)'));
  });
  it('does not compare Safepay provider timestamps with local database timestamps', () => {
    const sync = readFileSync(join(process.cwd(), 'src/services/billing/providers/safepay/safepaySubscriptionSyncService.ts'), 'utf8');
    assert.ok(!sync.includes('providerUpdatedAt.getTime() < existing.updatedAt.getTime()'));
    assert.ok(sync.includes("['TRIALING', 'ACTIVE'].includes(existing.status) && mappedStatus === 'INCOMPLETE'"));
  });
  it('encrypts Safepay credentials using the shared secret format', () => {
    const previous = process.env.SECRETS_ENCRYPTION_KEY;
    process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    try {
      const encrypted = encryptSecret('sfpy-secret');
      assert.ok(encrypted?.startsWith('enc:v1:'));
      assert.equal(decryptSecret(encrypted), 'sfpy-secret');
      assert.ok(!encrypted?.includes('sfpy-secret'));
    } finally {
      if (previous === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
      else process.env.SECRETS_ENCRYPTION_KEY = previous;
    }
  });
  it('uses explicit environments and environment-specific mappings', () => {
    const client = readFileSync(join(process.cwd(), 'src/services/billing/providers/safepay/safepayClient.ts'), 'utf8');
    const migration = readFileSync(join(process.cwd(), 'prisma/migrations/20260812120000_add_provider_independent_billing/migration.sql'), 'utf8');
    assert.ok(client.includes("environment === 'SANDBOX'"));
    assert.ok(migration.includes('PlanProviderMapping_planId_provider_environment_key'));
  });
  it('verifies HMAC before processing and preserves raw bodies', () => {
    const route = readFileSync(join(process.cwd(), 'src/routes/safepayWebhook.ts'), 'utf8');
    const index = readFileSync(join(process.cwd(), 'src/index.ts'), 'utf8');
    assert.ok(route.includes("createHmac('sha512'"));
    assert.ok(route.indexOf('safeEqualHex') < route.indexOf('syncSafepaySubscription(regionId'));
    assert.ok(index.includes("'/api/payments/webhook/safepay/:regionId'"));
    assert.ok(index.includes("express.raw({ type: 'application/json' })"));
  });
  it('routes management by subscription owner', () => {
    const source = readFileSync(join(process.cwd(), 'src/services/subscriptionAdminService.ts'), 'utf8');
    assert.ok(source.includes("existing.provider ?? (existing.stripeSubscriptionId ? 'STRIPE' : 'MANUAL')"));
    assert.ok(!source.includes("paymentConfig?.provider ?? 'MANUAL'"));
  });
  it('does not grant trials at checkout URL creation', () => {
    const checkout = readFileSync(join(process.cwd(), 'src/services/billing/providers/safepay/safepayCheckoutService.ts'), 'utf8');
    assert.ok(checkout.includes('TRIAL_PENDING'));
    assert.ok(!checkout.includes('BillingAccessStatus.TRIALING'));
  });
  it('allows an explicit retry to reuse only an unconfirmed Safepay checkout', () => {
    const checkout = readFileSync(join(process.cwd(), 'src/services/billing/providers/safepay/safepayCheckoutService.ts'), 'utf8');
    const payments = readFileSync(join(process.cwd(), 'src/routes/payments.ts'), 'utf8');
    assert.ok(checkout.includes('pending && !input.retryIncomplete'));
    assert.ok(checkout.includes('pending.providerSubscriptionId'));
    assert.ok(checkout.includes('const pendingId = pending?.id ?? randomUUID()'));
    assert.ok(payments.includes('retryIncomplete: retryIncomplete === true'));
  });
  it('normalizes a legacy encoded Safepay reference without changing Stripe session IDs', () => {
    const reference = 'a5d99904-01dc-49db-817a-d475feb6918e';
    const planId = 'plan_be28985f-df2e-4518-a173-c3358897d5b8';
    assert.deepEqual(normalizeCheckoutReference(`${reference}?plan_id=${planId}`), {
      reference,
      legacyPlanId: planId,
    });
    assert.deepEqual(normalizeCheckoutReference('cs_test_123'), {
      reference: 'cs_test_123',
      legacyPlanId: null,
    });
  });
  it('matches the official SDK HMAC-SHA512 webhook scheme', () => {
    const body = { data: { subscription: { token: 'sub_123', status: 'ACTIVE' } } };
    const signature = computeSafepayWebhookSignature(body.data, 'webhook-secret');
    assert.match(signature, /^[0-9a-f]{128}$/);
    assert.equal(verifySafepayWebhookSignature(body, signature, 'webhook-secret'), true);
    assert.equal(verifySafepayWebhookSignature(body, '0'.repeat(128), 'webhook-secret'), false);
  });
  it('rejects missing signatures and parsed/non-buffer webhook bodies', () => {
    assert.equal(validateSafepayWebhookEnvelope(Buffer.from('{}'), undefined), 'Missing Safepay signature');
    assert.equal(validateSafepayWebhookEnvelope({}, 'signature'), 'Safepay webhook body is not raw');
    assert.equal(validateSafepayWebhookEnvelope(Buffer.from('{}'), 'signature'), null);
  });
  it('extracts Safepay 2.0 subscription and subscription-payment resources', () => {
    const created = extractSafepayWebhookResource('subscription.created', {
      data: { subscription: { token: 'sub_123', plan_id: 'plan_123', reference: 'local_123', status: 'TRAILING' } },
    });
    assert.equal(created.subscriptionId, 'sub_123');
    assert.equal(created.planId, 'plan_123');
    assert.equal(created.reference, 'local_123');
    assert.equal(created.status, 'TRAILING');

    const payment = extractSafepayWebhookResource('subscription.payment.succeeded', {
      data: { transaction: { token: 'txn_123', subscription_id: 'sub_123', status: 'PAID' } },
    });
    assert.equal(payment.subscriptionId, 'sub_123');
    assert.equal(payment.transactionId, 'txn_123');
  });
  it('emits every safe webhook pipeline diagnostic stage', () => {
    const route = readFileSync(join(process.cwd(), 'src/routes/safepayWebhook.ts'), 'utf8');
    for (const stage of [
      'SAFEPAY-WEBHOOK-RECEIVED', 'SAFEPAY-WEBHOOK-VERIFIED',
      'SAFEPAY-WEBHOOK-RESOURCE', 'billing-webhook-event-persisted',
      'billing-webhook-transaction-recorded', 'billing-webhook-processed',
    ]) assert.ok(route.includes(stage), `missing ${stage}`);
    const sync = readFileSync(join(process.cwd(), 'src/services/billing/providers/safepay/safepaySubscriptionSyncService.ts'), 'utf8');
    for (const stage of [
      'SAFEPAY-CORRELATION-ATTEMPT', 'SAFEPAY-CORRELATION-SUCCESS',
      'SAFEPAY-STATUS-MAPPED', 'SAFEPAY-LOCAL-SUBSCRIPTION-UPDATED',
      'SAFEPAY-ACCESS-RESULT',
    ]) assert.ok(sync.includes(stage), `missing ${stage}`);
    const checkout = readFileSync(join(process.cwd(), 'src/services/billing/providers/safepay/safepayCheckoutService.ts'), 'utf8');
    assert.ok(checkout.includes('SAFEPAY-CHECKOUT-CREATED'));
    const client = readFileSync(join(process.cwd(), 'src/services/billing/providers/safepay/safepayClient.ts'), 'utf8');
    assert.ok(client.includes('SAFEPAY-PROVIDER-SUBSCRIPTION-FETCH'));
    assert.ok(client.includes('SAFEPAY-PROVIDER-SUBSCRIPTION-RESULT'));
    const payments = readFileSync(join(process.cwd(), 'src/routes/payments.ts'), 'utf8');
    assert.ok(payments.includes('SAFEPAY-RETURN-PARSED'));
    assert.ok(payments.includes('SAFEPAY-CHECKOUT-STATUS'));
  });
});
