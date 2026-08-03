import assert from 'node:assert/strict';
import test from 'node:test';
import { checkSafeForWorkText, normalizeSafetyTokens } from './contentSafety';

test('content safety normalizes unicode and repeated separators', () => {
  assert.deepEqual(normalizeSafetyTokens('  SaaS___Growth—AI  '), ['saas', 'growth', 'ai']);
});

test('content safety rejects blocked whole tokens', () => {
  assert.equal(checkSafeForWorkText('explicit porn content').safe, false);
});

test('content safety does not reject safe words containing similar sequences', () => {
  assert.equal(checkSafeForWorkText('Scunthorpe analysis and assignment class').safe, true);
});
