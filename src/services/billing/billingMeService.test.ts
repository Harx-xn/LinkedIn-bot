import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isBillingRequiredStatus, planRelationship } from './billingMeService';

describe('billing overview after cancellation', () => {
  it('marks every plan available when no manageable subscription exists', () => {
    assert.equal(planRelationship(null, 9, false), 'AVAILABLE');
    assert.equal(planRelationship(null, 29, false), 'AVAILABLE');
  });

  it('requires a new paid subscription after cancellation', () => {
    assert.equal(isBillingRequiredStatus('CANCELED'), true);
    assert.equal(isBillingRequiredStatus('ACTIVE'), false);
  });

  it('preserves upgrade and downgrade comparisons for active subscriptions', () => {
    assert.equal(planRelationship(9, 29, false), 'UPGRADE');
    assert.equal(planRelationship(29, 9, false), 'DOWNGRADE');
    assert.equal(planRelationship(29, 29, true), 'CURRENT');
  });
});
