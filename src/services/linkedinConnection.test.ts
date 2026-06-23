import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isLinkedInAccountUsable } from './linkedinService';

describe('LinkedIn connection status', () => {
  const now = new Date('2026-06-24T00:00:00.000Z');

  it('requires a token that has not expired', () => {
    assert.equal(
      isLinkedInAccountUsable(
        {
          accessToken: 'token',
          expiresAt: new Date('2026-06-25T00:00:00.000Z'),
        },
        now,
      ),
      true,
    );
    assert.equal(
      isLinkedInAccountUsable(
        {
          accessToken: 'token',
          expiresAt: new Date('2026-06-23T00:00:00.000Z'),
        },
        now,
      ),
      false,
    );
    assert.equal(
      isLinkedInAccountUsable(
        {
          accessToken: '',
          expiresAt: new Date('2026-06-25T00:00:00.000Z'),
        },
        now,
      ),
      false,
    );
  });
});
