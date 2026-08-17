import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emailEventForSubscriptionStatus, sendConfirmedSubscriptionEmail, type SubscriptionEmailDependencies } from './subscriptionEmailNotificationService';
import { buildSubscriptionEmail } from '../email/subscriptionEmailTemplates';

function fixture(status: string) {
  return { id: 'sub_1', userId: 'user_1', status, currentPeriodEnd: new Date('2026-09-15T00:00:00Z'), trialEnd: new Date('2026-08-29T00:00:00Z'), user: { email: 'customer@example.com', username: 'Taylor' }, plan: { name: 'Growth', price: 29, currency: 'USD', billingCycle: 'month' } };
}

function harness(status: string, sendError?: Error) {
  const calls = { created: 0, claimed: 0, sent: 0, failed: 0, eventType: '' };
  const dependencies: SubscriptionEmailDependencies = {
    findSubscription: async () => fixture(status),
    createDelivery: async (data) => { calls.created += 1; calls.eventType = data.eventType; return { id: 'delivery_1' }; },
    claimFailedDelivery: async () => { calls.claimed += 1; return null; },
    markSent: async () => { calls.sent += 1; },
    markFailed: async () => { calls.failed += 1; },
    send: async () => { if (sendError) throw sendError; return { messageId: 'message_1' }; },
  };
  return { dependencies, calls };
}

describe('transactional subscription emails', () => {
  it('sends the active confirmation after an ACTIVE state', async () => {
    const { dependencies, calls } = harness('ACTIVE');
    assert.equal((await sendConfirmedSubscriptionEmail('sub_1', dependencies)).outcome, 'SENT');
    assert.equal(calls.eventType, 'SUBSCRIPTION_CONFIRMED');
    assert.equal(calls.sent, 1);
  });
  it('sends the trial-started message after a TRIALING state', async () => {
    const { dependencies, calls } = harness('TRIALING');
    assert.equal((await sendConfirmedSubscriptionEmail('sub_1', dependencies)).outcome, 'SENT');
    assert.equal(calls.eventType, 'TRIAL_STARTED');
  });
  for (const status of ['INCOMPLETE', 'PAST_DUE', 'CANCELED']) {
    it(`does not send for ${status}`, async () => {
      const { dependencies, calls } = harness(status);
      assert.equal((await sendConfirmedSubscriptionEmail('sub_1', dependencies)).outcome, 'NOT_ELIGIBLE');
      assert.equal(calls.created, 0);
    });
  }
  it('treats the unique delivery constraint as an idempotent duplicate', async () => {
    const { dependencies, calls } = harness('ACTIVE');
    dependencies.createDelivery = async () => { calls.created += 1; throw Object.assign(new Error('duplicate'), { code: 'P2002' }); };
    assert.equal((await sendConfirmedSubscriptionEmail('sub_1', dependencies)).outcome, 'ALREADY_RECORDED');
    assert.equal(calls.sent, 0);
  });
  it('atomically reuses a FAILED delivery after a transient SMTP failure', async () => {
    const { dependencies, calls } = harness('ACTIVE');
    dependencies.createDelivery = async () => { throw Object.assign(new Error('duplicate'), { code: 'P2002' }); };
    dependencies.claimFailedDelivery = async () => { calls.claimed += 1; return { id: 'failed_delivery_1' }; };
    assert.equal((await sendConfirmedSubscriptionEmail('sub_1', dependencies)).outcome, 'SENT');
    assert.equal(calls.claimed, 1);
    assert.equal(calls.sent, 1);
  });
  it('records SMTP failure without throwing into billing', async () => {
    const { dependencies, calls } = harness('ACTIVE', new Error('SMTP unavailable'));
    assert.equal((await sendConfirmedSubscriptionEmail('sub_1', dependencies)).outcome, 'FAILED');
    assert.equal(calls.failed, 1);
  });
  it('renders useful text and HTML when optional fields are absent', () => {
    const email = buildSubscriptionEmail('SUBSCRIPTION_CONFIRMED', { planName: 'Growth' });
    assert.match(email.subject, /confirmed/);
    assert.match(email.text, /Plan: Growth/);
    assert.match(email.html, /subscription is active/);
  });
  it('maps only provider-confirmed eligible states', () => {
    assert.equal(emailEventForSubscriptionStatus('ACTIVE'), 'SUBSCRIPTION_CONFIRMED');
    assert.equal(emailEventForSubscriptionStatus('TRIALING'), 'TRIAL_STARTED');
    assert.equal(emailEventForSubscriptionStatus('INCOMPLETE'), null);
  });
});
