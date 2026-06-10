import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import type { ContentService } from '../contentService';
import {
  applyBoundedManualRevision,
  criticScoresNeedRewrite,
  evaluateDeterministicDraftQuality,
  parseManualCriticResult,
  preservedFactsSurviveRevision,
} from './manualPostCritic';
import {
  createFallbackManualPlan,
  scoreAngle,
  scoreHook,
  selectManualPlan,
} from './manualPostPlanning';
import { runManualGenerationMultiStage } from './manualPostMultiStage';
import type { ManualGeneratedPost, ManualPlanningResult } from './manualPostTypes';
import { createManualProviderCallBudget } from './manualPostTypes';

const ROOT = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function validDraft(overrides: Partial<ManualGeneratedPost> = {}): ManualGeneratedPost {
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

function planningJson(): string {
  return JSON.stringify({
    angles: [
      {
        title: 'Tenant isolation',
        coreClaim: 'Server-side authorization must enforce tenant scope on every request.',
        audience: 'SaaS backend engineers',
        structure: 'hook → problem → mechanism → consequence → closing',
        evidenceMode: 'technical_example',
        specificity: 9,
        novelty: 8,
        audienceFit: 8,
        voiceFit: 8,
        evidenceAvailability: 9,
        hookCandidates: [
          {
            text: 'Most multi-tenant bugs are not in the database layer.',
            type: 'SPECIFIC_WARNING',
            specificity: 9,
            curiosity: 7,
            topicRelevance: 9,
            clarity: 9,
            voiceFit: 8,
          },
        ],
      },
    ],
  } satisfies ManualPlanningResult);
}

function genericDraftJson(): string {
  return JSON.stringify(validDraft({
    hook: 'In today\'s rapidly evolving landscape, many businesses struggle with tenant authorization.',
    body: 'This distinction is critical. Here are some actionable steps to improve your workflow, enhance team collaboration, and optimize delivery speed.',
    closingLine: 'What measures are you taking?',
  }));
}

function criticPassJson(): string {
  return JSON.stringify({
    scores: {
      hook: 8,
      specificity: 8,
      voiceMatch: 8,
      focus: 9,
      credibility: 8,
      originality: 7,
      readability: 8,
      genericAiRisk: 2,
    },
    issues: [],
    decision: 'PASS',
  });
}

function criticReviseJson(): string {
  return JSON.stringify({
    scores: {
      hook: 5,
      specificity: 5,
      voiceMatch: 7,
      focus: 6,
      credibility: 6,
      originality: 6,
      readability: 7,
      genericAiRisk: 7,
    },
    issues: ['generic opening', 'forced question'],
    decision: 'REVISE',
    revised: {
      hook: 'Most multi-tenant bugs are not in the database layer.',
      body: 'They show up when application code assumes the caller already belongs to the right tenant. Resolve tenant scope from the authenticated session and reject cross-tenant identifiers before any query runs.',
      closingLine: 'Treat tenant scope as a request invariant, not a UI convenience.',
    },
  });
}

function createMockContentService(handlers: {
  planning?: () => Promise<string> | string;
  draft?: () => Promise<string> | string;
  critic?: () => Promise<string> | string;
}) {
  let generationCalls = 0;
  let rewriteCalls = 0;

  const service = {
    generationCalls: () => generationCalls,
    rewriteCalls: () => rewriteCalls,
    fetchComposerGenerationRaw: async () => {
      generationCalls += 1;
      if (generationCalls === 1) {
        const value = handlers.planning ? await handlers.planning() : planningJson();
        return value;
      }
      const value = handlers.draft ? await handlers.draft() : JSON.stringify(validDraft());
      return value;
    },
    fetchComposerRewriteRaw: async () => {
      rewriteCalls += 1;
      const value = handlers.critic ? await handlers.critic() : criticPassJson();
      return value;
    },
    fetchComposerRepairRaw: async () => {
      throw new Error('repair should not run in multi-stage happy path tests');
    },
  } as unknown as ContentService & {
    generationCalls: () => number;
    rewriteCalls: () => number;
  };

  return service;
}

describe('manual multi-stage provider call limits', () => {
  it('uses at most two provider calls on the normal path', async () => {
    const service = createMockContentService({});
    const budget = createManualProviderCallBudget();
    const result = await runManualGenerationMultiStage(
      service,
      {
        topic: 'Tenant authorization',
        author: { description: 'Engineer', tone: 'Professional', niches: ['SaaS'] },
      },
      'OPENAI',
      budget,
    );

    assert.equal(result.providerCalls, 2);
    assert.equal(result.usedQualityRepair, false);
    assert.equal(service.generationCalls(), 2);
    assert.equal(service.rewriteCalls(), 0);
  });

  it('uses at most three provider calls on the quality-repair path', async () => {
    const service = createMockContentService({
      draft: () => genericDraftJson(),
      critic: () => criticReviseJson(),
    });
    const budget = createManualProviderCallBudget();
    const result = await runManualGenerationMultiStage(
      service,
      {
        topic: 'Tenant authorization',
        author: { description: 'Engineer', tone: 'Professional', niches: ['SaaS'] },
      },
      'OPENAI',
      budget,
    );

    assert.equal(result.providerCalls, 3);
    assert.equal(result.usedQualityRepair, true);
    assert.equal(service.generationCalls(), 2);
    assert.equal(service.rewriteCalls(), 1);
  });

  it('runs at most one critic revision call', async () => {
    let criticCalls = 0;
    const service = createMockContentService({
      draft: () => genericDraftJson(),
      critic: async () => {
        criticCalls += 1;
        return criticReviseJson();
      },
    });

    await runManualGenerationMultiStage(
      service,
      {
        topic: 'Tenant authorization',
        author: { description: 'Engineer', tone: 'Professional', niches: ['SaaS'] },
      },
      'OPENAI',
      createManualProviderCallBudget(),
    );

    assert.equal(criticCalls, 1);
    assert.equal(service.rewriteCalls(), 1);
  });
});

describe('manual multi-stage fallbacks', () => {
  it('uses a safe fallback plan when planning fails', async () => {
    const service = createMockContentService({
      planning: async () => {
        throw new Error('planning provider failed');
      },
    });

    const result = await runManualGenerationMultiStage(
      service,
      {
        topic: 'Tenant authorization',
        author: { description: 'Engineer', tone: 'Professional', niches: ['SaaS'] },
      },
      'OPENAI',
      createManualProviderCallBudget(),
    );

    assert.equal(result.selectedPlan.title, 'Tenant authorization');
    assert.match(result.selectedPlan.coreClaim, /Tenant authorization/);
    assert.equal(result.post.contentPlan.coreClaim, result.selectedPlan.coreClaim);
  });

  it('returns the valid draft when critic fails', async () => {
    const service = createMockContentService({
      draft: () => genericDraftJson(),
      critic: async () => {
        throw new Error('critic failed');
      },
    });

    const result = await runManualGenerationMultiStage(
      service,
      {
        topic: 'Tenant authorization',
        author: { description: 'Engineer', tone: 'Professional', niches: ['SaaS'] },
      },
      'OPENAI',
      createManualProviderCallBudget(),
    );

    assert.equal(result.usedQualityRepair, false);
    assert.match(result.post.hook, /rapidly evolving landscape/i);
  });

  it('returns the pre-revision draft when revision output is rejected', async () => {
    const service = createMockContentService({
      draft: () => JSON.stringify(validDraft({
        body: 'Acme Corp reduced cross-tenant leaks by enforcing request-scoped tenant guards.',
      })),
      critic: () => JSON.stringify({
        scores: {
          hook: 5,
          specificity: 5,
          voiceMatch: 7,
          focus: 6,
          credibility: 6,
          originality: 6,
          readability: 7,
          genericAiRisk: 7,
        },
        issues: ['needs tighter specificity'],
        decision: 'REVISE',
        revised: {
          body: 'Teams should improve collaboration without mentioning Acme Corp at all.',
        },
      }),
    });

    const result = await runManualGenerationMultiStage(
      service,
      {
        topic: 'Tenant authorization',
        author: { description: 'Engineer', tone: 'Professional', niches: ['SaaS'] },
      },
      'OPENAI',
      createManualProviderCallBudget(),
    );

    assert.match(result.post.body, /Acme Corp/);
  });
});

describe('manual planning and critic helpers', () => {
  it('selects angles and hooks deterministically by score', () => {
    const selected = selectManualPlan(
      {
        angles: [
          {
            title: 'Broad success',
            coreClaim: 'Everything about tenant authorization is a game-changer.',
            audience: 'Everyone',
            structure: 'intro',
            evidenceMode: 'reasoned_observation',
            specificity: 10,
            novelty: 10,
            audienceFit: 10,
            voiceFit: 10,
            evidenceAvailability: 10,
            hookCandidates: [],
          },
          {
            title: 'Tenant isolation',
            coreClaim: 'Server-side authorization must enforce tenant scope on every request.',
            audience: 'SaaS backend engineers',
            structure: 'hook → problem → mechanism → consequence → closing',
            evidenceMode: 'technical_example',
            specificity: 8,
            novelty: 8,
            audienceFit: 8,
            voiceFit: 8,
            evidenceAvailability: 8,
            hookCandidates: [
              {
                text: 'Many businesses struggle with tenant authorization.',
                type: 'GENERIC',
                specificity: 10,
                curiosity: 10,
                topicRelevance: 10,
                clarity: 10,
                voiceFit: 10,
              },
              {
                text: 'Most multi-tenant bugs are not in the database layer.',
                type: 'SPECIFIC_WARNING',
                specificity: 9,
                curiosity: 7,
                topicRelevance: 9,
                clarity: 9,
                voiceFit: 8,
              },
            ],
          },
        ],
      },
      'Tenant authorization',
    );

    assert.equal(selected.title, 'Tenant isolation');
    assert.equal(selected.hook, 'Most multi-tenant bugs are not in the database layer.');
    assert.ok(scoreAngle({
      title: 'Tenant isolation',
      coreClaim: 'Server-side authorization must enforce tenant scope on every request.',
      audience: 'SaaS backend engineers',
      structure: 'hook → problem → mechanism → consequence → closing',
      evidenceMode: 'technical_example',
      specificity: 8,
      novelty: 8,
      audienceFit: 8,
      voiceFit: 8,
      evidenceAvailability: 8,
      hookCandidates: [],
    }) < scoreAngle({
      title: 'Broad success',
      coreClaim: 'Everything about tenant authorization is a game-changer.',
      audience: 'Everyone',
      structure: 'intro',
      evidenceMode: 'reasoned_observation',
      specificity: 10,
      novelty: 10,
      audienceFit: 10,
      voiceFit: 10,
      evidenceAvailability: 10,
      hookCandidates: [],
    }));
    assert.ok(scoreHook({
      text: 'Most multi-tenant bugs are not in the database layer.',
      type: 'SPECIFIC_WARNING',
      specificity: 9,
      curiosity: 7,
      topicRelevance: 9,
      clarity: 9,
      voiceFit: 8,
    }) > 0);
  });

  it('creates a deterministic fallback plan', () => {
    const fallback = createFallbackManualPlan('Tenant authorization');
    assert.equal(fallback.title, 'Tenant authorization');
    assert.match(fallback.coreClaim, /Tenant authorization/);
    assert.equal(fallback.hook, '');
  });

  it('applies bounded revision without changing the core claim', () => {
    const draft = validDraft();
    const revised = applyBoundedManualRevision(draft, parseManualCriticResult(criticReviseJson()));
    assert.equal(revised.contentPlan.coreClaim, draft.contentPlan.coreClaim);
    assert.match(revised.hook, /multi-tenant bugs/);
  });

  it('preserves selected facts through bounded revision', () => {
    const before = validDraft({
      body: 'Acme Corp reduced cross-tenant leaks by enforcing request-scoped tenant guards.',
    });
    const after = applyBoundedManualRevision(before, parseManualCriticResult(JSON.stringify({
      scores: {
        hook: 5,
        specificity: 5,
        voiceMatch: 7,
        focus: 6,
        credibility: 6,
        originality: 6,
        readability: 7,
        genericAiRisk: 7,
      },
      issues: ['tighten wording'],
      decision: 'REVISE',
      revised: {
        body: 'Acme Corp reduced cross-tenant leaks by enforcing request-scoped tenant guards before any query runs.',
      },
    })));

    assert.equal(preservedFactsSurviveRevision(before, after), true);
    assert.match(after.body, /Acme Corp/);
  });

  it('detects deterministic quality repair need from generic language', () => {
    const evaluation = evaluateDeterministicDraftQuality(
      'In today\'s rapidly evolving landscape, many businesses struggle with tenant authorization. This distinction is critical. What measures are you taking?',
    );
    assert.equal(evaluation.needsQualityRepair, true);
    assert.ok(criticScoresNeedRewrite({
      hook: 6,
      specificity: 6,
      voiceMatch: 7,
      focus: 7,
      credibility: 6,
      originality: 6,
      readability: 7,
      genericAiRisk: 6,
    }));
  });
});

describe('manual usage and batch isolation', () => {
  it('records usage only once after multi-stage generation succeeds', () => {
    const source = readSrc('services/manualPost/manualPostOrchestration.ts');
    const fnStart = source.indexOf('export async function generateManualPostV2');
    const fnEnd = source.indexOf('export async function rewriteUnsavedManualPostV2');
    const generateBody = source.slice(fnStart, fnEnd);
    const pipelineIdx = generateBody.indexOf('runManualGenerationMultiStage');
    const recordIdx = generateBody.indexOf("recordManualAiOperation(userId, 'generate')");
    assert.ok(pipelineIdx >= 0);
    assert.ok(recordIdx > pipelineIdx);
    assert.equal((generateBody.match(/recordManualAiOperation\(userId, 'generate'\)/g) || []).length, 1);
  });

  it('batch generation does not invoke manual planning or critic services', () => {
    const batchGen = readSrc('services/ghostwriterGenerationService.ts');
    const trending = readSrc('services/trendingBotService.ts');
    assert.ok(!batchGen.includes('runManualGenerationMultiStage'));
    assert.ok(!batchGen.includes('invokeManualPlanningPrompt'));
    assert.ok(!batchGen.includes('invokeManualCriticPrompt'));
    assert.ok(!trending.includes('manualPostMultiStage'));
    assert.ok(!trending.includes('manualPostPlanning'));
    assert.ok(!trending.includes('manualPostCritic'));
  });

  it('batch provider call count remains unchanged in ghostwriterGenerationService', () => {
    const batchGen = readSrc('services/ghostwriterGenerationService.ts');
    assert.ok(batchGen.includes('generatePlannedPost'));
    assert.ok(!batchGen.includes('createManualProviderCallBudget'));
  });
});
