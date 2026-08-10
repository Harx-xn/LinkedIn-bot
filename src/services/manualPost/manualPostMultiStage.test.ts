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

const realFailedApiText = `Have you thought about how effective API design can influence the scalability of your web application?

In the realm of scalable web applications, API design is often a neglected aspect.

Many developers focus primarily on frontend and backend functionalities, overlooking how an effective API can streamline communication between services and enhance overall performance.

An API acts as the backbone of your application, facilitating interactions between different components.

When designing your API, adhering to best practicesâ€”like clear versioning, consistent naming conventions, and thorough documentationâ€”can significantly improve flexibility and scalability.

This approach not only accommodates future changes but also ensures that your application can handle increased load seamlessly.

Consider a SaaS application where user demand spikes unexpectedly.

If the API is designed with scalability in mind, it can efficiently manage the increased traffic through load balancing and optimized data retrieval.

Conversely, a poorly designed API can lead to bottlenecks, resulting in slow response times and frustrated users.

The consequence of neglecting API design is clear: it can limit your application's growth potential and impact user satisfaction.

As developers, we must prioritize API design to foster scalable and robust applications that can thrive in a competitive landscape.

Invest in thoughtful API design today to ensure your web applications will evolve and scale with user needs tomorrow.`;

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
  planning?: (prompt: string) => Promise<string> | string;
  draft?: (prompt: string) => Promise<string> | string;
  critic?: (prompt: string) => Promise<string> | string;
}) {
  let generationCalls = 0;
  let planningCalls = 0;
  let rewriteCalls = 0;

  const service = {
    generationCalls: () => generationCalls,
    planningCalls: () => planningCalls,
    rewriteCalls: () => rewriteCalls,
    fetchComposerPlanningRaw: async (prompt: string) => {
      planningCalls += 1;
      return handlers.planning ? handlers.planning(prompt) : planningJson();
    },
    fetchComposerGenerationRaw: async (prompt: string) => {
      generationCalls += 1;
      const value = handlers.draft ? await handlers.draft(prompt) : JSON.stringify(validDraft());
      return value;
    },
    fetchComposerRewriteRaw: async (prompt: string) => {
      rewriteCalls += 1;
      const value = handlers.critic ? await handlers.critic(prompt) : criticPassJson();
      return value;
    },
    fetchComposerRepairRaw: async () => {
      throw new Error('repair should not run in multi-stage happy path tests');
    },
  } as unknown as ContentService & {
    generationCalls: () => number;
    planningCalls: () => number;
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
    assert.equal(service.planningCalls(), 1);
    assert.equal(service.generationCalls(), 1);
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
    assert.equal(service.planningCalls(), 1);
    assert.equal(service.generationCalls(), 1);
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

/* Removed score/threshold-based VoicePlan integration tests during Expression Mode simplification.
describe('manual voice validation integration', () => {
  it('passes VoicePlan and history to drafting/critic, repairs the real API failure, and revalidates', async () => {
    let draftPrompt = '';
    let criticPrompt = '';
    const failedLines = realFailedApiText.split(/\n\n/);
    const service = createMockContentService({
      draft: (prompt) => {
        draftPrompt = prompt;
        return JSON.stringify(validDraft({
          hook: failedLines[0],
          body: failedLines.slice(1, -1).join('\n\n'),
          closingLine: failedLines[failedLines.length - 1],
          sourceTopic: 'API design for scalable applications',
        }));
      },
      critic: (prompt) => {
        criticPrompt = prompt;
        return JSON.stringify({
          scores: { hook: 8, specificity: 9, voiceMatch: 9, focus: 9, credibility: 9, originality: 9, readability: 8, genericAiRisk: 1 },
          issues: ['generic consultant progression'], decision: 'REVISE',
          revised: {
            hook: "Load balancing won't rescue a bad API contract.",
            body: 'In a SaaS API, if one request pulls five resources, performs three synchronous service calls, and returns data the client never uses, another server only spreads the waste around.',
            closingLine: 'Scale the design before you scale the machines.',
          },
        });
      },
    });
    const recentPosts = ['However, API design matters. Therefore, teams should consider it. What do you think?'];
    const recentVoicePatterns = {
      overusedPhrases: [], overusedTransitions: ['however', 'therefore'], repeatedOpenings: [],
      repeatedEndingPatterns: [], repeatedSentencePatterns: [], repeatedNarrativeStructures: ['multi-section explanation â†’ conclusion'],
    };
    const result = await runManualGenerationMultiStage(service, {
      topic: 'API design for scalable applications', author: { description: 'Backend engineer', tone: 'Professional', niches: ['SaaS'] },
      voicePlan: manualVoicePlan, recentPosts, recentVoicePatterns,
    }, 'OPENAI', createManualProviderCallBudget());

    assert.match(draftPrompt, /VOICE PLAN/);
    assert.match(draftPrompt, /RECENT VOICE PATTERNS TO AVOID IMITATING/);
    assert.match(criticPrompt, /VOICE VALIDATION FINDINGS/);
    assert.match(criticPrompt, /generic rhetorical-question opening/);
    assert.equal(result.initialVoiceValidation.passed, false);
    assert.equal(result.finalVoiceValidation.passed, true);
    assert.equal(result.usedQualityRepair, true);
    assert.match(result.post.hook, /Load balancing won't rescue/);
    assert.doesNotMatch(`${result.post.hook}\n${result.post.body}\n${result.post.closingLine}`, /In the realm|Invest in|As developers/i);
  });

  it('returns the higher-scoring usable repair even when both candidates miss the preferred threshold', async () => {
    const service = createMockContentService({ draft: () => genericDraftJson(), critic: () => criticReviseJson() });
    const analyzer = (content: string) => {
      const repaired = /request invariant/i.test(content);
      const score = repaired ? .68 : .55;
      return {
        passed: false, score,
        historicalSimilarity: { passed: false, similarityScore: 1 - score, issues: ['below preferred target'] },
        genericProse: { score: 1 - score, phraseHits: [], structuralFindings: [], cadence: { sentenceLengths: [], oneSentenceParagraphRatio: 0, lengthVariation: 0 } },
        voicePlanCompliance: { score, violations: ['below preferred target'] }, repairReasons: ['below preferred target'],
      };
    };
    const result = await runManualGenerationMultiStage(service, {
      topic: 'Tenant authorization', author: { description: 'Engineer', tone: 'Professional' }, voiceAnalyzer: analyzer,
    }, 'OPENAI', createManualProviderCallBudget());
    assert.equal(result.finalVoiceValidation.score, .68);
    assert.equal(result.finalVoiceValidation.passed, false);
    assert.equal(result.usedQualityRepair, true);
  });

  it('treats an unexpected Voice Diversity exception as advisory and returns a usable draft', async () => {
    const service = createMockContentService({ critic: () => { throw new Error('critic unavailable'); } });
    const result = await runManualGenerationMultiStage(service, {
      topic: 'Tenant authorization', author: { description: 'Engineer', tone: 'Professional' },
      voiceAnalyzer: () => { throw new Error('voice analyzer crashed'); },
    }, 'OPENAI', createManualProviderCallBudget());
    assert.match(result.post.hook, /multi-tenant bugs/i);
    assert.equal(result.finalVoiceValidation.score, 0);
  });

  it('preserves provider failure behavior when no candidate is produced', async () => {
    const service = createMockContentService({ draft: () => { throw new Error('provider unavailable'); } });
    await assert.rejects(() => runManualGenerationMultiStage(service, {
      topic: 'Tenant authorization', author: { description: 'Engineer', tone: 'Professional' },
    }, 'OPENAI', createManualProviderCallBudget()), /Failed to generate post content/);
  });
});
*/

describe('manual expression mode integration', () => {
  it('passes the selected mode and recent posts directly to the drafting prompt', async () => {
    let draftPrompt = '';
    const service = createMockContentService({ draft: (prompt) => { draftPrompt = prompt; return JSON.stringify(validDraft()); } });
    await runManualGenerationMultiStage(service, {
      topic: 'API design', author: { description: 'Backend engineer', tone: 'Conversational' },
      expressionMode: 'direct', recentPosts: ['Ultimately, API design matters. What do you think?'],
    }, 'OPENAI', createManualProviderCallBudget());
    assert.match(draftPrompt, /EXPRESSION MODE: DIRECT/);
    assert.match(draftPrompt, /RECENT STYLE CONTEXT/);
    assert.match(draftPrompt, /Ultimately, API design matters/);
    assert.match(draftPrompt, /Do not solve repetition by substituting synonyms/);
  });

  it('passes the explicit Expression Mode contract into critic repair', async () => {
    const prompts: string[] = [];
    const service = createMockContentService({
      draft: () => genericDraftJson(),
      critic: (prompt: string) => {
        prompts.push(prompt);
        return JSON.stringify({
        scores: { hook: 8, specificity: 8, voiceMatch: 8, focus: 8, credibility: 8, originality: 8, audienceFit: 8, conversationPotential: 8, dwellQuality: 8, readability: 8, genericAiRisk: 1 },
        issues: [], decision: 'PASS', revised: {},
        });
      },
    });
    await runManualGenerationMultiStage(service as never, {
      topic: 'Lead qualification', author: { description: 'Revenue operator', tone: 'Conversational', niches: ['Sales'] }, expressionMode: 'reflective',
      recentPosts: ['For instance, imagine a sales team. Ultimately, adopt a better process.'],
    }, 'OPENAI');
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /EXPRESSION MODE: REFLECTIVE/);
    assert.match(prompts[0], /Fix only the identified issue/);
    assert.match(prompts[0], /Do not add an example, consequence, recommendation/);
  });

  it('preserves provider failure behavior when no draft is produced', async () => {
    const service = createMockContentService({ draft: () => { throw new Error('provider unavailable'); } });
    await assert.rejects(() => runManualGenerationMultiStage(service, {
      topic: 'API design', author: { description: 'Backend engineer', tone: 'Conversational' }, expressionMode: 'direct',
    }, 'OPENAI', createManualProviderCallBudget()), /Failed to generate post content/);
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

  it('returns the best usable draft when critic fails', async () => {
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
    assert.equal(fallback.structure, 'claim -> support');
    assert.equal(createFallbackManualPlan('Tenant authorization', 'diagnostic').structure, 'symptom -> trace -> cause -> fix or decision');
    assert.equal(createFallbackManualPlan('Tenant authorization', 'reflective').structure, 'observation -> implication');
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
