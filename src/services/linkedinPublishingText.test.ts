import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeLinkedInLittleText,
  prepareLinkedInCommentary,
} from './linkedinPublishingText';

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

  it('applies the limit to visible content rather than added transport escapes', () => {
    const visibleContent = '('.repeat(3000);
    assert.equal(prepareLinkedInCommentary(visibleContent).length, 6000);
  });

  it('escapes parentheses used as ordinary text', () => {
    assert.equal(
      prepareLinkedInCommentary('Building an MVP (Minimum Viable Product)'),
      'Building an MVP \\(Minimum Viable Product\\)',
    );
  });

  it('escapes multiple parenthesized sections and function calls', () => {
    assert.equal(
      prepareLinkedInCommentary('AI automation (when implemented correctly) can improve workflows (without replacing people).'),
      'AI automation \\(when implemented correctly\\) can improve workflows \\(without replacing people\\).',
    );
    assert.equal(prepareLinkedInCommentary('Function call: process(data)'), 'Function call: process\\(data\\)');
  });

  it('escapes brackets, braces, bullets, underscores, and ordinary at signs', () => {
    assert.equal(prepareLinkedInCommentary('Use [draft] before publishing.'), 'Use \\[draft\\] before publishing.');
    assert.equal(prepareLinkedInCommentary('Payload: {status: active}'), 'Payload: \\{status: active\\}');
    assert.equal(prepareLinkedInCommentary('* First point\n* Second point'), '\\* First point\n\\* Second point');
    assert.equal(prepareLinkedInCommentary('some_variable_name @username'), 'some\\_variable\\_name \\@username');
    assert.equal(prepareLinkedInCommentary('| <value> ~done~'), '\\| \\<value\\> \\~done\\~');
  });

  it('preserves hashtags and line breaks while escaping surrounding text', () => {
    assert.equal(
      prepareLinkedInCommentary('Building an MVP (fast).\n\n#Blockchain #MVP #Game_Development'),
      'Building an MVP \\(fast\\).\n\n#Blockchain #MVP #Game_Development',
    );
  });

  it('does not corrupt ordinary URLs', () => {
    assert.equal(
      prepareLinkedInCommentary('Read https://example.com/test and https://example.com/product?id=123'),
      'Read https://example.com/test and https://example.com/product?id=123',
    );
  });

  it('preserves emoji and Unicode while escaping reserved characters', () => {
    assert.equal(
      prepareLinkedInCommentary('AI automation 🚀 (done properly) saves time.'),
      'AI automation 🚀 \\(done properly\\) saves time.',
    );
  });

  it('handles backslashes deterministically and avoids double escaping', () => {
    const once = prepareLinkedInCommentary(String.raw`Path C:\temp and \(MVP\)`);
    assert.equal(once, String.raw`Path C:\\temp and \(MVP\)`);
    assert.equal(escapeLinkedInLittleText(once), once);
  });

  it('keeps stored content unchanged in the reproduced regression case', () => {
    const storedContent = `In the fast-paced world of blockchain, delivering a Minimum Viable Product (MVP) requires making technical decisions early.

A smart contract architecture that works during prototyping may become expensive to change later.

The point of an MVP isn't just to launch quickly. It's to validate the architecture while keeping the system flexible enough to evolve.

#Blockchain #MVP #SmartContracts`;
    const commentary = prepareLinkedInCommentary(storedContent);

    assert.match(commentary, /Product \\\(MVP\\\)/);
    assert.match(commentary, /#Blockchain #MVP #SmartContracts$/);
    assert.equal(storedContent.includes('\\('), false);
  });
});
