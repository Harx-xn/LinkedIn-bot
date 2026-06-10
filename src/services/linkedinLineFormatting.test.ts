import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLinkedInLineBody, validateLinkedInFormatting } from './linkedinLineFormatting';

describe('LinkedIn line formatting', () => {
  it('splits a dense four-sentence paragraph', () => {
    const input = 'First sentence here. Second sentence follows. Third sentence adds detail. Fourth sentence closes the point.';
    const out = normalizeLinkedInLineBody(input);
    assert.ok(out.split('\n\n').length >= 2);
  });

  it('keeps a single concise sentence unchanged', () => {
    const input = 'Atomic counters keep plan enforcement accurate.';
    assert.equal(normalizeLinkedInLineBody(input), input);
  });

  it('may keep two tightly related sentences together', () => {
    const input = 'Validate usage in the API. Increment the counter in the same transaction.';
    const out = normalizeLinkedInLineBody(input);
    assert.ok(out.includes('Validate usage'));
  });

  it('keeps numbered lists contiguous', () => {
    const input = 'Steps:\n\n1. Load entitlement.\n2. Increment usage.\n3. Reject on limit.';
    const out = normalizeLinkedInLineBody(input);
    assert.ok(out.includes('1. Load entitlement.'));
    assert.ok(out.includes('2. Increment usage.'));
    assert.ok(!out.includes('1. Load entitlement.\n\n2.'));
  });

  it('keeps hyphen bullets contiguous', () => {
    const input = 'Actions:\n\n- Validate server-side.\n- Increment atomically.\n- Reject over-limit requests.';
    const out = normalizeLinkedInLineBody(input);
    assert.ok(out.includes('- Validate server-side.'));
    assert.ok(!out.includes('- Validate server-side.\n\n- Increment'));
  });

  it('does not split URLs', () => {
    const input = 'Learn more at https://example.com/docs before changing the middleware.';
    const out = normalizeLinkedInLineBody(input);
    assert.ok(out.includes('https://example.com/docs'));
  });

  it('preserves version numbers', () => {
    const input = 'Upgrade to v2.1.0 before enabling the new scheduler.';
    const out = normalizeLinkedInLineBody(input);
    assert.ok(out.includes('v2.1.0'));
  });

  it('collapses more than two blank lines', () => {
    const input = 'Line one.\n\n\n\nLine two.';
    const out = normalizeLinkedInLineBody(input);
    assert.ok(!out.includes('\n\n\n'));
  });

  it('detects dense paragraphs before normalization', () => {
    const dense = 'One. Two. Three. Four.';
    const issues = validateLinkedInFormatting(dense);
    assert.ok(issues.some((i) => i.code === 'dense_paragraph'));
  });
});
