import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { getEffectiveAccess } from './billingExemptionService';

const dbFor = (user: { role: 'USER' | 'REGIONAL_ADMIN' | 'SUPER_ADMIN'; isBillingExempt: boolean } | null) => ({
  user: { findUnique: async () => user },
}) as any;

test('billing-exempt user resolves to unlimited access without a subscription', async () => {
  assert.deepEqual(await getEffectiveAccess('user-1', dbFor({ role: 'USER', isBillingExempt: true })), {
    hasAccess: true,
    unlimited: true,
    billingExempt: true,
    accessSource: 'BILLING_EXEMPT',
  });
});

test('removing exemption restores standard access resolution', async () => {
  assert.deepEqual(await getEffectiveAccess('user-1', dbFor({ role: 'USER', isBillingExempt: false })), {
    hasAccess: false,
    unlimited: false,
    billingExempt: false,
    accessSource: 'STANDARD',
  });
});

test('quota gates use the centralized unlimited-access resolver and usage recording remains enabled', () => {
  const source = readFileSync(path.join(__dirname, '../planEntitlementService.ts'), 'utf8');
  for (const gate of ['canRewritePost', 'canPublishToLinkedIn', 'canStartBatchGeneration', 'canUseImageGeneration', 'canUseManualAiOperation']) {
    const start = source.indexOf(`export async function ${gate}`);
    assert.ok(start >= 0, `${gate} exists`);
    assert.ok(source.slice(start, start + 900).includes('isPrivileged(userId)'), `${gate} checks centralized unlimited access`);
  }
  assert.ok(source.includes('prisma.manualAiRewriteUsage.create'));
  assert.ok(source.includes('prisma.imageGenerationUsage.create'));
});

test('Super Admin endpoint is role-gated, audits changes, and does not touch subscriptions', () => {
  const source = readFileSync(path.join(__dirname, '../../routes/admin.ts'), 'utf8');
  assert.ok(source.includes('router.use(requireRole(UserRole.SUPER_ADMIN))'));
  const start = source.indexOf("router.patch('/users/:userId/billing-exemption'");
  const body = source.slice(start, source.indexOf('\n});', start) + 4);
  assert.ok(body.includes("console.info('[audit] billing exemption changed'"));
  assert.equal(body.includes('prisma.subscription.update'), false);
  assert.equal(body.includes('stripe'), false);
});
