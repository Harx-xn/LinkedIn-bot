import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ManualPostError } from './manualPostService';
import {
  deriveTopicFromContent,
  normalizeGeneratedContent,
} from './userContentContext';
import {
  MAX_MANUAL_TOPIC_LENGTH,
  MAX_REWRITE_CONTENT_LENGTH,
  MAX_REWRITE_SUGGESTIONS_LENGTH,
  parseContentProvider,
  validateGenerateInput,
  validateUnsavedRewriteInput,
} from './manualPostAiService';

describe('manual post AI validation', () => {
  it('rejects empty topic', () => {
    assert.throws(
      () => validateGenerateInput({ topic: '   ' }),
      (err: unknown) => err instanceof ManualPostError && err.status === 400,
    );
  });

  it('accepts valid topic', () => {
    const result = validateGenerateInput({
      topic: 'Tenant-scoped authorization in SaaS',
      additionalInstructions: 'Keep it technical',
    });
    assert.equal(result.topic, 'Tenant-scoped authorization in SaaS');
    assert.equal(result.additionalInstructions, 'Keep it technical');
  });

  it('rejects topic above max length', () => {
    assert.throws(
      () => validateGenerateInput({ topic: 'x'.repeat(MAX_MANUAL_TOPIC_LENGTH + 1) }),
      (err: unknown) => err instanceof ManualPostError && err.status === 400,
    );
  });

  it('parses provider values', () => {
    assert.equal(parseContentProvider(undefined), 'OPENAI');
    assert.equal(parseContentProvider('gemini'), 'GEMINI');
    assert.throws(
      () => parseContentProvider('claude'),
      (err: unknown) => err instanceof ManualPostError && err.status === 400,
    );
  });

  it('requires content and suggestions for unsaved rewrite', () => {
    assert.throws(
      () => validateUnsavedRewriteInput({ content: 'Hello', suggestions: '' }),
      (err: unknown) => err instanceof ManualPostError && err.status === 400,
    );
    const ok = validateUnsavedRewriteInput({
      content: 'Post body here',
      suggestions: 'make it shorter',
      topic: 'SaaS auth',
    });
    assert.equal(ok.suggestions, 'make it shorter');
    assert.equal(ok.topic, 'SaaS auth');
  });

  it('enforces rewrite content and suggestion limits', () => {
    assert.throws(
      () => validateUnsavedRewriteInput({
        content: 'a'.repeat(MAX_REWRITE_CONTENT_LENGTH + 1),
        suggestions: 'shorter',
      }),
      (err: unknown) => err instanceof ManualPostError && err.status === 400,
    );
    assert.throws(
      () => validateUnsavedRewriteInput({
        content: 'valid content',
        suggestions: 's'.repeat(MAX_REWRITE_SUGGESTIONS_LENGTH + 1),
      }),
      (err: unknown) => err instanceof ManualPostError && err.status === 400,
    );
  });

  it('derives topic from first meaningful line', () => {
    assert.equal(
      deriveTopicFromContent('\n\nWhy tenant isolation matters\nMore text'),
      'Why tenant isolation matters',
    );
  });

  it('normalized generated output stays within LinkedIn limit', () => {
    const body = 'A'.repeat(2500);
    const normalized = normalizeGeneratedContent(
      {
        headline: 'Tenant authorization',
        subheadline: '',
        bulletPoints: [],
        body,
        hashtags: '#SaaS #Security',
      },
      'fallback',
      { topic: 'Tenant authorization' },
    );
    assert.ok(normalized.content.length <= 3000);
  });
});
