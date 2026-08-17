import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getSafepayProviderError, isSafepayCancellationConfirmed, normalizeSafepayCancellationResource } from './billingManagementService';

const trial = {
  id: 'local_sub_1',
  providerSubscriptionId: 'sub_provider_1',
  status: 'TRIALING',
};

describe('Safepay subscription cancellation', () => {
  it('keeps a verified trial manageable when Safepay returns only a partial cancellation response', () => {
    assert.deepEqual(normalizeSafepayCancellationResource({}, trial), {
      token: 'sub_provider_1',
      reference: 'local_sub_1',
      status: 'TRIALING',
      cancel_at_period_end: true,
    });
  });

  it('unwraps Safepay cancellation envelopes and preserves authoritative fields', () => {
    const resource = normalizeSafepayCancellationResource({
      data: {
        subscription: {
          token: 'sub_provider_1',
          status: 'CANCELED',
          cancel_at_period_end: false,
          current_period_end_date: '2026-08-31T00:00:00.000Z',
        },
      },
    }, trial);
    assert.equal(resource.status, 'CANCELED');
    assert.equal(resource.cancel_at_period_end, false);
    assert.equal(resource.reference, 'local_sub_1');
  });

  it('extracts the safe reason from a Safepay 406 response', () => {
    assert.deepEqual(getSafepayProviderError({
      response: { status: 406, data: { error: { code: 'not_cancelable', message: 'Subscription cannot be canceled in its current state' } } },
    }), {
      httpStatus: 406,
      providerCode: 'not_cancelable',
      providerMessage: 'Subscription cannot be canceled in its current state',
    });
  });

  it('recognizes an already scheduled or completed provider cancellation', () => {
    assert.equal(isSafepayCancellationConfirmed({ status: 'TRAILING', cancel_at_period_end: true }), true);
    assert.equal(isSafepayCancellationConfirmed({ status: 'CANCELED' }), true);
    assert.equal(isSafepayCancellationConfirmed({ status: 'TRAILING', cancel_at_period_end: false }), false);
  });

  it('does not consider a mutation-only CANCELED response enough when retrieval remains trialing', () => {
    const mutation = normalizeSafepayCancellationResource({ status: 'CANCELED' }, trial);
    const retrieved = { status: 'TRAILING', cancel_at_period_end: false };
    assert.equal(isSafepayCancellationConfirmed(mutation), true);
    assert.equal(isSafepayCancellationConfirmed(retrieved), false);
  });
});
