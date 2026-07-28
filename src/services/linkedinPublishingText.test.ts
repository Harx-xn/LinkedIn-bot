import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prepareLinkedInCommentary } from './linkedinPublishingText';

describe('prepareLinkedInCommentary', () => {
  it('preserves the complete rewritten post', () => {
    const firstHalf = 'A'.repeat(1200);
    const secondHalf = 'B'.repeat(1200);
    const post = `${firstHalf}\n\n${secondHalf}`;
    assert.equal(prepareLinkedInCommentary(post), post);
  });

  it('removes embedded controls without dropping following text', () => {
    assert.equal(
      prepareLinkedInCommentary('Opening\u0000\u001f\n\nThe rest of the post'),
      'Opening\n\nThe rest of the post',
    );
  });

  it('normalizes line endings while preserving paragraphs and emoji', () => {
    assert.equal(prepareLinkedInCommentary('First 🚀\r\n\r\nSecond'), 'First 🚀\n\nSecond');
  });

  it('rejects over-limit text instead of silently truncating it', () => {
    assert.throws(() => prepareLinkedInCommentary('x'.repeat(3001)), /exceeds 3000/);
  });
});
