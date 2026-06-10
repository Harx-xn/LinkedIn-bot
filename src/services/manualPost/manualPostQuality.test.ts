import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import {
  MAX_SUPPORTING_CONTEXT_LENGTH,
  validateGenerateInput,
} from '../manualPostAiService';
import { ManualPostError } from '../manualPostService';
import {
  buildManualPostPromptV2,
  buildManualRewritePromptV2,
  MANUAL_QUALITY_RULES,
  MANUAL_REWRITE_SCOPE_RULES,
} from './manualPostPrompts';
import {
  parseManualGeneratedPostV2,
  parseManualJsonDetailed,
} from './manualPostParsing';
import { buildManualJsonRepairPrompt } from './manualPostJsonRepair';
import {
  calculateManualGenericAiRisk,
  genericManualAiPatterns,
  hasForcedEngagementQuestion,
} from './manualGenericAiDetector';
import {
  assembleManualPostBody,
  finalizeManualGeneratedPostV2,
  MANUAL_LINKEDIN_CHAR_LIMIT,
  normalizeManualHashtags,
} from './manualPostFormatting';
import type { ManualGeneratedPost } from './manualPostTypes';

const ROOT = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

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
    hashtags: ['#SaaS', '#Authorization'],
    sourceTopic: 'Tenant authorization',
    ...overrides,
  };
}

describe('supporting context validation', () => {
  it('accepts optional supportingContext and trims it', () => {
    const result = validateGenerateInput({
      topic: 'Billing gates',
      supportingContext: '  We audited 12 services and found missing server-side checks.  ',
    });
    assert.equal(result.supportingContext, 'We audited 12 services and found missing server-side checks.');
  });

  it('rejects supportingContext above max length', () => {
    assert.throws(
      () => validateGenerateInput({
        topic: 'Billing gates',
        supportingContext: 'x'.repeat(MAX_SUPPORTING_CONTEXT_LENGTH + 1),
      }),
      (err: unknown) => err instanceof ManualPostError && err.status === 400,
    );
  });

  it('remains backward-compatible when supportingContext is omitted', () => {
    const result = validateGenerateInput({ topic: 'Billing gates' });
    assert.equal(result.topic, 'Billing gates');
    assert.equal(result.supportingContext, undefined);
  });
});

describe('unsupported experience prevention in prompts', () => {
  it('includes evidence rules without supporting context', () => {
    const prompt = buildManualPostPromptV2({
      topic: 'Tenant authorization',
      author: { description: 'Backend engineer', tone: 'Professional', niches: ['SaaS'] },
    });
    assert.ok(prompt.includes('labeled hypothetical'));
    assert.ok(prompt.includes('No personal experience claims'));
    assert.ok(!prompt.includes('User-supplied supporting context'));
  });

  it('includes supporting context block when supplied', () => {
    const prompt = buildManualPostPromptV2({
      topic: 'Tenant authorization',
      supportingContext: 'We migrated three services to strict tenant guards.',
      author: { description: 'Backend engineer', tone: 'Professional', niches: ['SaaS'] },
    });
    assert.ok(prompt.includes('User-supplied supporting context'));
    assert.ok(prompt.includes('We migrated three services to strict tenant guards.'));
    assert.ok(prompt.includes('Do not embellish'));
  });
});

describe('manual schema parsing', () => {
  it('parses valid manual provider JSON', () => {
    const parsed = parseManualGeneratedPostV2(JSON.stringify(validManualPost()));
    assert.equal(parsed.contentPlan.coreClaim, 'Server-side authorization must enforce tenant scope on every request.');
    assert.equal(parsed.hashtags.length, 2);
  });

  it('normalizes string hashtags into an array', () => {
    const result = parseManualJsonDetailed(JSON.stringify({
      ...validManualPost(),
      hashtags: '#SaaS #Authorization',
    }));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.data.hashtags, ['#SaaS', '#Authorization']);
    }
  });

  it('rejects batch-style headline/body schema', () => {
    const result = parseManualJsonDetailed(JSON.stringify({
      headline: 'Auth',
      subheadline: '',
      bulletPoints: ['one'],
      body: 'Server-side tenant authorization checks matter for every SaaS product.',
      hashtags: '#SaaS',
    }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.stage, 'normalization');
  });
});

describe('manual JSON repair', () => {
  it('buildManualJsonRepairPrompt requests manual schema shape', () => {
    const prompt = buildManualJsonRepairPrompt({
      repairContext: 'context',
      stage: 'schema_validation',
      message: 'failed',
      issues: ['body: too short'],
      invalidOutput: '{"hook":"x"}',
    });
    assert.ok(prompt.includes('"contentPlan"'));
    assert.ok(prompt.includes('"closingLine"'));
    assert.ok(!prompt.includes('"bulletPoints"'));
  });
});

describe('generic phrase detection', () => {
  it('matches listed generic AI patterns', () => {
    const sample = 'In today\'s digital age, this distinction is critical for teams.';
    const risk = calculateManualGenericAiRisk(sample);
    assert.ok(risk.score >= 2);
    assert.ok(risk.matches.length >= 2);
    assert.ok(genericManualAiPatterns.some((re) => re.test(sample)));
  });

  it('detects forced closing questions', () => {
    const sample = 'Tenant scope must be enforced server-side.\n\nWhat measures are you taking?';
    assert.equal(hasForcedEngagementQuestion(sample), true);
    const risk = calculateManualGenericAiRisk(sample);
    assert.ok(risk.matches.some((m) => m.startsWith('forced_question')));
  });

  it('detects generic bullet structure', () => {
    const sample = [
      'Hook line here with enough context for testing.',
      '',
      '- Improve your workflow',
      '- Enhance team collaboration',
      '- Optimize delivery speed',
    ].join('\n');
    const risk = calculateManualGenericAiRisk(sample);
    assert.ok(risk.matches.includes('structure:three_generic_bullets'));
  });
});

describe('narrow rewrite instructions', () => {
  it('includes rewrite scope rules for shorter and hook edits', () => {
    const shorter = buildManualRewritePromptV2({
      currentContent: 'Original post body with enough detail to rewrite safely.',
      suggestions: 'Make it shorter',
      author: { description: 'Engineer', tone: 'Professional', niches: [] },
    });
    assert.ok(shorter.includes(MANUAL_REWRITE_SCOPE_RULES));
    assert.ok(shorter.includes('preserve the same angle, facts, and claims'));

    const hook = buildManualRewritePromptV2({
      currentContent: 'Original post body with enough detail to rewrite safely.',
      suggestions: 'Add a stronger hook',
      author: { description: 'Engineer', tone: 'Professional', niches: [] },
    });
    assert.ok(hook.includes('strengthen opening lines only'));

    const tone = buildManualRewritePromptV2({
      currentContent: 'Original post body with enough detail to rewrite safely.',
      suggestions: 'Make it less formal',
      author: { description: 'Engineer', tone: 'Professional', niches: [] },
    });
    assert.ok(tone.includes('adjust voice/register only'));
  });
});

describe('manual finalization', () => {
  it('enforces 3000-character limit after assembly', () => {
    const manual = validManualPost({
      body: 'A'.repeat(3100),
    });
    assert.throws(
      () => finalizeManualGeneratedPostV2(manual, 'fallback', {
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
      }),
      /exceeds 3000 characters/,
    );
  });

  it('normalizes hashtags to at most three relevant tags', () => {
    const tags = normalizeManualHashtags(
      ['#SaaS', '#Authorization', '#Security', '#Cloud'],
      'Tenant scope enforcement for SaaS authorization systems.',
      'Tenant authorization',
    );
    const count = tags.split(/\s+/).filter(Boolean).length;
    assert.ok(count <= 3);
  });

  it('appends contact and website when enabled', () => {
    const finalized = finalizeManualGeneratedPostV2(validManualPost(), 'fallback', {
      topic: 'Tenant authorization',
      voice: {
        tone: 'Professional',
        description: 'SaaS founder',
        niches: [],
        customLinks: null,
        contactInfo: 'Email me at hello@veyra.test',
        websiteUrl: 'https://veyra.test',
        includeContactInfo: true,
        includeWebsiteLink: true,
      },
    });
    assert.ok(finalized.content.includes('hello@veyra.test'));
    assert.ok(finalized.content.includes('https://veyra.test'));
    assert.ok(finalized.content.length <= MANUAL_LINKEDIN_CHAR_LIMIT);
  });

  it('assembles hook, body, and closing line', () => {
    const body = assembleManualPostBody(validManualPost());
    assert.ok(body.includes('Most multi-tenant bugs'));
    assert.ok(body.includes('Treat tenant scope as a request invariant'));
  });
});

describe('batch isolation after manual quality upgrade', () => {
  it('batch prompts in ghostwriterPrompts remain unchanged', () => {
    const prompts = readSrc('services/ghostwriterPrompts.ts');
    assert.ok(prompts.includes('export const GHOSTWRITER_SYSTEM'));
    assert.ok(!prompts.includes('MANUAL_COMPOSER_SYSTEM'));
    assert.ok(!prompts.includes('MANUAL_QUALITY_RULES'));
  });

  it('batch parser in ghostwriterJsonParser remains unchanged', () => {
    const parser = readSrc('services/ghostwriterJsonParser.ts');
    assert.ok(parser.includes('parseGeneratedJsonDetailed'));
    assert.ok(!parser.includes('parseManualJsonDetailed'));
    assert.ok(!parser.includes('manualGeneratedPostSchema'));
  });

  it('manual generation prompt uses manual quality rules not batch angle planner', () => {
    const prompt = buildManualPostPromptV2({
      topic: 'Tenant authorization',
      author: { description: 'Backend engineer', tone: 'Professional', niches: ['SaaS'] },
    });
    assert.ok(prompt.includes(MANUAL_QUALITY_RULES));
    assert.ok(!prompt.includes('Assigned batch angle'));
  });
});
