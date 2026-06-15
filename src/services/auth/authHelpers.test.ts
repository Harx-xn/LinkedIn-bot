import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createUniqueUsernameFromEmail,
  isValidUsername,
  resolveEffectivePromoCode,
} from './authHelpers';

describe('authHelpers', () => {
  it('validates usernames with the project regex', () => {
    assert.equal(isValidUsername('abc'), true);
    assert.equal(isValidUsername('user_name'), true);
    assert.equal(isValidUsername('Jane Doe'), true);
    assert.equal(isValidUsername('_bad'), false);
    assert.equal(isValidUsername('ab'), false);
  });

  it('derives a valid username from email local part', async () => {
    const username = await createUniqueUsernameFromEmail(
      `jane.${Date.now()}@example.com`,
    );
    assert.equal(isValidUsername(username), true);
    assert.ok(username.length >= 3 && username.length <= 20);
  });

  it('resolves promo code precedence for register vs social', () => {
    assert.equal(resolveEffectivePromoCode('register', 'PROMO1', 'INVITE1'), 'PROMO1');
    assert.equal(resolveEffectivePromoCode('social', 'PROMO1', 'INVITE1'), 'INVITE1');
  });
});
