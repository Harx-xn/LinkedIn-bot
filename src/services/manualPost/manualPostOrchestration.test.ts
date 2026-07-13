import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import {
  buildManualPostPromptV2,
  buildManualRewritePromptV2,
  MANUAL_COMPOSER_SYSTEM,
} from './manualPostPrompts';
import { finalizeManualGeneratedPostV2, MANUAL_LINKEDIN_CHAR_LIMIT } from './manualPostFormatting';
import { parseManualGeneratedPostV2 } from './manualPostParsing';
import {
  generateManualPostContent,
} from '../manualPostAiService';
import {
  generateManualPostV2,
  rewriteSavedManualPostV2,
  rewriteUnsavedManualPostV2,
} from './manualPostOrchestration';
import * as manualAiProvider from './manualAiProvider';
import type { ManualGeneratedPost } from './manualPostTypes';

function validManualPost(overrides: Partial<ManualGeneratedPost> = {}): ManualGeneratedPost {
  return {
    contentPlan: {
      angle: 'Tenant isolation',
      coreClaim: 'Server-side authorization must enforce tenant scope on every request.',
      audience: 'SaaS backend engineers',
      structure: 'hook → problem → mechanism → consequence → closing',
      hookType: 'specific_observation',
      evidenceType: 'technical_example',
      ctaType: 'takeaway',
    },
    hook: 'Most multi-tenant bugs are not in the database layer.',
    body: 'They show up when application code assumes the caller already belongs to the right tenant. A practical fix is to resolve tenant scope from the authenticated session and reject cross-tenant identifiers before any query runs.',
    closingLine: 'Treat tenant scope as a request invariant, not a UI convenience.',
    hashtags: ['#SaaS'],
    sourceTopic: 'Tenant authorization',
    ...overrides,
  };
}

describe('manual post V2 prompts', () => {
  it('uses manual-only system instructions for generation', () => {
    const prompt = buildManualPostPromptV2({
      topic: 'Tenant authorization in SaaS',
      author: { description: 'Backend engineer', tone: 'Professional', niches: ['SaaS'] },
    });
    assert.ok(prompt.includes(MANUAL_COMPOSER_SYSTEM));
    assert.ok(prompt.includes('Tenant authorization in SaaS'));
    assert.ok(!prompt.includes('Assigned batch angle'));
    assert.ok(prompt.includes('contentPlan'));
  });

  it('uses manual-only system instructions for rewrite', () => {
    const prompt = buildManualRewritePromptV2({
      currentContent: 'Original post body',
      suggestions: 'shorter',
      author: { description: 'Backend engineer', tone: 'Professional', niches: [] },
    });
    assert.ok(prompt.includes(MANUAL_COMPOSER_SYSTEM));
    assert.ok(prompt.includes('USER SUGGESTIONS'));
    assert.ok(prompt.includes('Rewrite scope rules'));
  });
});

describe('manual post V2 parsing and formatting', () => {
  it('parses valid provider JSON', () => {
    const parsed = parseManualGeneratedPostV2(JSON.stringify(validManualPost()));
    assert.equal(parsed.contentPlan.angle, 'Tenant isolation');
    assert.equal(parsed.hashtags.length, 1);
  });

  it('appends contact and website when enabled', () => {
    const finalized = finalizeManualGeneratedPostV2(validManualPost(), 'fallback', {
      topic: 'Billing gates',
      voice: {
        tone: 'Professional',
        description: 'SaaS founder',
        niches: [],
        contactInfo: 'Email me at hello@veyrais.test',
        websiteUrl: 'https://veyrais.test',
        includeContactInfo: true,
        includeWebsiteLink: true,
      },
    });
    assert.ok(finalized.content.includes('hello@veyrais.test'));
    assert.ok(finalized.content.includes('https://veyrais.test'));
    assert.ok(finalized.content.length <= MANUAL_LINKEDIN_CHAR_LIMIT);
  });
});

describe('manual route delegation', () => {
  it('exports route handlers that delegate to V2 orchestration', () => {
    assert.equal(generateManualPostContent, generateManualPostV2);
  });
});

describe('manual orchestration provider transport', () => {
  it('invokeManualGenerationPrompt uses manual raw fetch and manual schema parsing', async () => {
    let fetchCalled = false;
    const fakeService = {
      fetchComposerGenerationRaw: async () => {
        fetchCalled = true;
        return JSON.stringify(validManualPost());
      },
      fetchComposerRepairRaw: async () => {
        throw new Error('repair should not run for valid JSON');
      },
    } as any;

    const result = await manualAiProvider.invokeManualGenerationPrompt(
      fakeService,
      'test-prompt',
      'OPENAI',
    );
    assert.equal(fetchCalled, true);
    assert.equal(result.contentPlan.angle, 'Tenant isolation');
  });

  it('invokeManualRewritePrompt uses manual raw fetch and manual schema parsing', async () => {
    let method = '';
    const fakeService = {
      fetchComposerRewriteRaw: async () => {
        method = 'rewrite';
        return JSON.stringify(validManualPost({ closingLine: 'Rewritten closing takeaway.' }));
      },
      fetchComposerRepairRaw: async () => {
        throw new Error('repair should not run for valid JSON');
      },
    } as any;

    const result = await manualAiProvider.invokeManualRewritePrompt(fakeService, 'rewrite-prompt', 'GEMINI');
    assert.equal(method, 'rewrite');
    assert.equal(result.closingLine, 'Rewritten closing takeaway.');
  });
});

describe('manual orchestration entitlement ordering', () => {
  it('records usage only after provider invocation in generateManualPostV2', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'manualPostOrchestration.ts'),
      'utf8',
    );
    const fnStart = source.indexOf('export async function generateManualPostV2');
    const fnEnd = source.indexOf('export async function rewriteUnsavedManualPostV2');
    const generateBody = source.slice(fnStart, fnEnd);
    const pipelineIdx = generateBody.indexOf('runManualGenerationMultiStage');
    const recordIdx = generateBody.indexOf("recordManualAiOperation(userId, 'generate')");
    assert.ok(pipelineIdx >= 0);
    assert.ok(recordIdx >= 0);
    assert.ok(recordIdx > pipelineIdx);
    assert.ok(!generateBody.includes('prisma.post.create'));
    assert.ok(!generateBody.includes('supportingContext') || generateBody.includes('validateGenerateInput'));
  });

  it('rewriteUnsavedManualPostV2 records usage after invokeManualRewritePrompt', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'manualPostOrchestration.ts'),
      'utf8',
    );
    const fnStart = source.indexOf('export async function rewriteUnsavedManualPostV2');
    const fnEnd = source.indexOf('async function findRewritableManualPost');
    const body = source.slice(fnStart, fnEnd);
    assert.ok(body.indexOf('invokeManualRewritePrompt') < body.indexOf("recordManualAiOperation(userId, 'rewrite_unsaved')"));
  });
});

describe('saved rewrite limits', () => {
  it('rewriteSavedManualPostV2 still calls canRewritePost before provider invoke', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'manualPostOrchestration.ts'),
      'utf8',
    );
    const fnStart = source.indexOf('export async function rewriteSavedManualPostV2');
    const body = source.slice(fnStart);
    assert.ok(body.includes('canRewritePost(userId, post.id)'));
    assert.ok(body.indexOf('canRewritePost') < body.indexOf('invokeManualRewritePrompt'));
    assert.ok(body.includes('rewriteCount: { increment: 1 }'));
  });
});
