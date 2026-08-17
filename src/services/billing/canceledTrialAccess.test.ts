import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('canceled trial access policy', () => {
  it('revokes dashboard access immediately for a subscription canceled during trial', () => {
    const source = readFileSync(join(process.cwd(), 'src/services/billing/billingAccessService.ts'), 'utf8');
    assert.match(source, /if \(sub\?\.canceledDuringTrial\) return false/);
  });

  it('records the trial cancellation transition for both payment providers', () => {
    const safepay = readFileSync(join(process.cwd(), 'src/services/billing/providers/safepay/safepaySubscriptionSyncService.ts'), 'utf8');
    const stripe = readFileSync(join(process.cwd(), 'src/services/billing/stripeSubscriptionSyncService.ts'), 'utf8');
    assert.match(safepay, /previousStatus === 'TRIALING' && status === 'CANCELED'/);
    assert.match(stripe, /existing\?\.status === 'TRIALING' && localStatus === 'CANCELED'/);
  });
});
