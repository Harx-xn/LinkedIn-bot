import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ManualPostError } from '../manualPostService';
import {
  assertSafeArticleUrl,
  extractReadableArticleFromHtml,
  ARTICLE_MIN_TEXT_LENGTH,
} from './articleUrlFetcher';
import {
  URL_POST_VARIATIONS,
  validateGenerateFromUrlInput,
} from '../manualPostAiService';

describe('articleUrlFetcher', () => {
  it('rejects unsupported protocols', async () => {
    await assert.rejects(
      () => assertSafeArticleUrl('file:///etc/passwd'),
      (err: unknown) => err instanceof ManualPostError && err.status === 400,
    );
  });

  it('rejects localhost URLs', async () => {
    await assert.rejects(
      () => assertSafeArticleUrl('http://localhost/article'),
      (err: unknown) => err instanceof ManualPostError && err.status === 400,
    );
  });

  it('extracts title, description, and article text from HTML', () => {
    const longBody = 'This is readable article content. '.repeat(20);
    const html = `
      <html>
        <head>
          <title>Fallback title</title>
          <meta name="description" content="A useful article summary." />
        </head>
        <body>
          <article><p>${longBody}</p></article>
        </body>
      </html>
    `;

    const article = extractReadableArticleFromHtml(html, 'https://example.com/post');
    assert.equal(article.title, 'Fallback title');
    assert.equal(article.description, 'A useful article summary.');
    assert.ok(article.text.length >= ARTICLE_MIN_TEXT_LENGTH);
  });
});

describe('generate from url validation', () => {
  it('requires url and variation', () => {
    assert.throws(
      () => validateGenerateFromUrlInput({ variation: 'actionable' }),
      (err: unknown) => err instanceof ManualPostError && err.status === 400,
    );
    assert.throws(
      () => validateGenerateFromUrlInput({ url: 'https://example.com' }),
      (err: unknown) => err instanceof ManualPostError && err.status === 400,
    );
  });

  it('accepts supported variations', () => {
    for (const variation of URL_POST_VARIATIONS) {
      const result = validateGenerateFromUrlInput({
        url: 'https://example.com/post',
        variation,
        angle: 'Practical takeaway',
      });
      assert.equal(result.variation, variation);
      assert.equal(result.angle, 'Practical takeaway');
    }
  });
});
