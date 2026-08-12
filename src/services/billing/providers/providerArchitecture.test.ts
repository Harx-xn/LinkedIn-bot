import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { getPaymentProvider } from './providerFactory';
import { mapSafepayStatusToLocal } from './safepay/safepaySubscriptionSyncService';
import { decryptSecret, encryptSecret } from '../../secretCrypto';

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
    assert.equal(mapSafepayStatusToLocal('ACTIVE'), 'ACTIVE');
    assert.equal(mapSafepayStatusToLocal('UNPAID'), 'PAST_DUE');
    assert.equal(mapSafepayStatusToLocal('PAUSED'), 'PAUSED');
    assert.equal(mapSafepayStatusToLocal('ENDED'), 'CANCELED');
    assert.equal(mapSafepayStatusToLocal('something-new'), 'INCOMPLETE');
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
});
