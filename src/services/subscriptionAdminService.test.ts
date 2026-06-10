import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSubscriptionStatus,
  parseEndsAt,
  validateSubscriptionPatchInput,
  resolveStripePlanItem,
  SubscriptionAdminError,
  type StripeSubscriptionLike,
} from './subscriptionAdminService';

describe('normalizeSubscriptionStatus', () => {
  it('normalizes legacy CANCELLED to CANCELED', () => {
    assert.equal(normalizeSubscriptionStatus('CANCELLED'), 'CANCELED');
    assert.equal(normalizeSubscriptionStatus('cancelled'), 'CANCELED');
  });

  it('accepts known statuses', () => {
    assert.equal(normalizeSubscriptionStatus('ACTIVE'), 'ACTIVE');
    assert.equal(normalizeSubscriptionStatus('PAST_DUE'), 'PAST_DUE');
    assert.equal(normalizeSubscriptionStatus('INCOMPLETE'), 'INCOMPLETE');
  });

  it('rejects unknown status', () => {
    assert.equal(normalizeSubscriptionStatus('PAUSED'), null);
  });
});

describe('parseEndsAt', () => {
  it('clears endsAt for null or empty', () => {
    assert.deepEqual(parseEndsAt(null), { ok: true, value: null });
    assert.deepEqual(parseEndsAt(''), { ok: true, value: null });
  });

  it('parses valid ISO date', () => {
    const result = parseEndsAt('2026-12-31T00:00:00.000Z');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value?.toISOString(), '2026-12-31T00:00:00.000Z');
    }
  });

  it('rejects invalid endsAt', () => {
    const result = parseEndsAt('not-a-date');
    assert.equal(result.ok, false);
  });
});

describe('validateSubscriptionPatchInput', () => {
  const currentPlanId = 'plan_current';

  it('rejects unknown status', () => {
    assert.throws(
      () => validateSubscriptionPatchInput({ status: 'PAUSED' }, currentPlanId),
      (err: unknown) =>
        err instanceof SubscriptionAdminError && err.status === 400,
    );
  });

  it('normalizes CANCELLED to CANCELED', () => {
    const patch = validateSubscriptionPatchInput({ status: 'CANCELLED' }, currentPlanId);
    assert.equal(patch.status, 'CANCELED');
  });

  it('rejects invalid endsAt', () => {
    assert.throws(
      () => validateSubscriptionPatchInput({ endsAt: 'bad' }, currentPlanId),
      (err: unknown) =>
        err instanceof SubscriptionAdminError && err.message.includes('Invalid endsAt'),
    );
  });

  it('rejects empty patch', () => {
    assert.throws(
      () => validateSubscriptionPatchInput({}, currentPlanId),
      (err: unknown) =>
        err instanceof SubscriptionAdminError &&
        err.message.includes('No supported subscription changes'),
    );
  });

  it('treats same planId as no plan change', () => {
    const patch = validateSubscriptionPatchInput(
      { planId: currentPlanId, status: 'ACTIVE' },
      currentPlanId,
    );
    assert.equal(patch.planChanging, false);
    assert.equal(patch.status, 'ACTIVE');
  });

  it('detects plan change to a different plan', () => {
    const patch = validateSubscriptionPatchInput(
      { planId: 'plan_other' },
      currentPlanId,
    );
    assert.equal(patch.planChanging, true);
    assert.equal(patch.planId, 'plan_other');
  });
});

describe('resolveStripePlanItem', () => {
  function mockSub(items: Array<{ id: string; priceId: string }>): StripeSubscriptionLike {
    return {
      items: {
        data: items.map((item) => ({
          id: item.id,
          price: { id: item.priceId },
        })),
      },
    };
  }

  it('returns the only item when there is one', () => {
    const sub = mockSub([{ id: 'si_1', priceId: 'price_a' }]);
    const item = resolveStripePlanItem(sub, null);
    assert.equal(item.id, 'si_1');
  });

  it('matches item by current plan stripePriceId when multiple items exist', () => {
    const sub = mockSub([
      { id: 'si_addon', priceId: 'price_addon' },
      { id: 'si_plan', priceId: 'price_plan' },
    ]);
    const item = resolveStripePlanItem(sub, 'price_plan');
    assert.equal(item.id, 'si_plan');
  });

  it('falls back to first item when price does not match', () => {
    const sub = mockSub([
      { id: 'si_first', priceId: 'price_first' },
      { id: 'si_second', priceId: 'price_second' },
    ]);
    const item = resolveStripePlanItem(sub, 'price_unknown');
    assert.equal(item.id, 'si_first');
  });
});
