import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasGhostwriterDescription,
  parseSavedGhostwriterNiches,
} from './ghostwriterConfigRequirementService';

describe('ghostwriter config generation requirement', () => {
  it('requires a non-empty saved description', () => {
    assert.equal(hasGhostwriterDescription(null), false);
    assert.equal(hasGhostwriterDescription('   '), false);
    assert.equal(
      hasGhostwriterDescription('SaaS founder writing for product teams'),
      true,
    );
  });

  it('requires at least one valid saved niche', () => {
    assert.deepEqual(parseSavedGhostwriterNiches(null), []);
    assert.deepEqual(parseSavedGhostwriterNiches('[]'), []);
    assert.deepEqual(parseSavedGhostwriterNiches('["", "  "]'), []);
    assert.deepEqual(
      parseSavedGhostwriterNiches('[" SaaS ", "AI"]'),
      ['SaaS', 'AI'],
    );
    assert.deepEqual(parseSavedGhostwriterNiches('invalid json'), []);
  });
});
