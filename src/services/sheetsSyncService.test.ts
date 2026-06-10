import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isGoogleInvalidGrantError } from './sheetsSyncService';

describe('Google Sheets sync errors', () => {
  it('detects invalid_grant in message', () => {
    assert.equal(isGoogleInvalidGrantError(new Error('invalid_grant')), true);
  });

  it('detects invalid_grant in response payload', () => {
    assert.equal(isGoogleInvalidGrantError({ response: { data: { error: 'invalid_grant' } } }), true);
  });

  it('treats other errors as retryable', () => {
    assert.equal(isGoogleInvalidGrantError(new Error('network timeout')), false);
  });
});
