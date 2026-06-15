import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ManualPostError } from './manualPostService';
import {
  MAX_MANUAL_TOPIC_LENGTH,
  MAX_REWRITE_CONTENT_LENGTH,
  MAX_REWRITE_SUGGESTIONS_LENGTH,
  MAX_SUPPORTING_CONTEXT_LENGTH,
  parseContentProvider,
  validateGenerateInput,
  validateUnsavedRewriteInput,
  generateManualPostContent,
  parseManualTopicSuggestionsResponse,
} from './manualPostAiService';
import { generateManualPostV2 } from './manualPost/manualPostOrchestration';
import { finalizeManualGeneratedPostV2 } from './manualPost/manualPostFormatting';
import type { ManualGeneratedPost } from './manualPost/manualPostTypes';

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

  it('validates supportingContext type and max length', () => {
    assert.throws(
      () => validateGenerateInput({ topic: 'Billing', supportingContext: 42 }),
      (err: unknown) => err instanceof ManualPostError && err.status === 400,
    );
    assert.throws(
      () => validateGenerateInput({
        topic: 'Billing',
        supportingContext: 'x'.repeat(MAX_SUPPORTING_CONTEXT_LENGTH + 1),
      }),
      (err: unknown) => err instanceof ManualPostError && err.status === 400,
    );
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
});

describe('manual post AI formatting', () => {
  it('normalized generated output stays within LinkedIn limit', () => {
    const body = 'A'.repeat(1800);
    const manual: ManualGeneratedPost = {
      contentPlan: {
        angle: 'Tenant authorization',
        coreClaim: 'Scope checks belong on the server.',
        audience: 'Backend engineers',
        structure: 'hook-body-close',
        hookType: 'observation',
        evidenceType: 'technical_example',
        ctaType: 'takeaway',
      },
      hook: 'Tenant authorization starts server-side.',
      body,
      closingLine: 'Enforce tenant scope before queries run.',
      hashtags: ['#SaaS', '#Security'],
    };
    const normalized = finalizeManualGeneratedPostV2(
      manual,
      'fallback',
      {
        topic: 'Tenant authorization',
        voice: {
          tone: 'Professional',
          description: '',
          niches: [],
          customLinks: null,
          contactInfo: null,
          websiteUrl: null,
          includeContactInfo: false,
          includeWebsiteLink: false,
        },
      },
    );
    assert.ok(normalized.content.length <= 3000);
  });
});

describe('manual topic suggestions', () => {
  it('parses valid topic suggestion JSON', () => {
    const topics = parseManualTopicSuggestionsResponse(`
      {
        "topics": [
          {
            "title": "Why tenant isolation matters in B2B SaaS",
            "description": "Explain the product and engineering tradeoffs of scoping customer data.",
            "reason": "Matches the author's SaaS and security niche."
          }
        ]
      }
    `);
    assert.equal(topics.length, 1);
    assert.equal(topics[0].title, 'Why tenant isolation matters in B2B SaaS');
  });

  it('rejects invalid topic suggestion JSON', () => {
    assert.throws(
      () => parseManualTopicSuggestionsResponse('not json'),
      (err: unknown) => err instanceof ManualPostError && err.status === 502,
    );
  });
});

describe('manual route orchestration wiring', () => {
  it('generateManualPostContent is the V2 orchestration entry point', () => {
    assert.equal(generateManualPostContent, generateManualPostV2);
  });
});
