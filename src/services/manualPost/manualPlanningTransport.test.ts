import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ContentService } from '../contentService';
import { invokeManualPlanningPrompt } from './manualAiProvider';
import { runManualGenerationMultiStage } from './manualPostMultiStage';
import { createFallbackManualPlan, parseManualPlanningResult } from './manualPostPlanning';
import { MANUAL_PLANNING_OPENAI_JSON_SCHEMA } from './manualPostSchemas';
import { createManualProviderCallBudget, type ManualGeneratedPost } from './manualPostTypes';

function planningResponse(coreClaim: string, title = 'Focused angle'): string {
  return JSON.stringify({
    angles: [{
      title, coreClaim, audience: 'Professional operators',
      structure: 'claim -> causal support', evidenceMode: 'reasoned_observation',
      specificity: 9, novelty: 8, audienceFit: 9, voiceFit: 8, evidenceAvailability: 8,
      hookCandidates: [],
    }],
  });
}

function draft(coreClaim: string): ManualGeneratedPost {
  return {
    contentPlan: { angle: 'Focused angle', coreClaim, audience: 'Professional operators', structure: 'claim -> support', hookType: 'specific_observation', evidenceType: 'reasoned_observation', ctaType: 'none' },
    hook: '', body: `${coreClaim}\n\n${'x'.repeat(1650)}`,
    closingLine: '', hashtags: [], sourceTopic: 'test topic',
  };
}

describe('manual planning transport', () => {
  it('uses an angles-only OpenAI schema rather than the final-post schema', () => {
    assert.deepEqual(MANUAL_PLANNING_OPENAI_JSON_SCHEMA.required, ['angles']);
    assert.ok('angles' in MANUAL_PLANNING_OPENAI_JSON_SCHEMA.properties);
    assert.ok(!('contentPlan' in MANUAL_PLANNING_OPENAI_JSON_SCHEMA.properties));
    assert.ok(!('body' in MANUAL_PLANNING_OPENAI_JSON_SCHEMA.properties));
    assert.ok(!('hook' in MANUAL_PLANNING_OPENAI_JSON_SCHEMA.properties));
    assert.ok(!('closingLine' in MANUAL_PLANNING_OPENAI_JSON_SCHEMA.properties));
  });

  it('invokes the planning-specific transport and parses angles successfully', async () => {
    let planningCalls = 0;
    const claim = 'More lead volume can reduce pipeline efficiency when qualification remains unchanged.';
    const service = {
      fetchComposerPlanningRaw: async () => { planningCalls += 1; return planningResponse(claim); },
      fetchComposerGenerationRaw: async () => { throw new Error('final-post transport must not handle planning'); },
    } as unknown as ContentService;
    const budget = createManualProviderCallBudget();
    const result = await invokeManualPlanningPrompt(service, 'planning prompt', 'OPENAI', budget);
    assert.equal(planningCalls, 1);
    assert.equal(budget.totalCalls(), 1);
    assert.equal(result.angles[0].coreClaim, claim);
  });

  it('propagates a nontechnical planner claim exactly into the drafting prompt without fallback', async () => {
    const claim = 'More lead volume can reduce pipeline efficiency when qualification remains unchanged.';
    let draftPrompt = '';
    const service = {
      fetchComposerPlanningRaw: async () => planningResponse(claim, 'Qualification does not scale with volume'),
      fetchComposerGenerationRaw: async (prompt: string) => { draftPrompt = prompt; return JSON.stringify(draft(claim)); },
      fetchComposerRepairRaw: async () => { throw new Error('repair should not run'); },
      fetchComposerRewriteRaw: async () => { throw new Error('critic should not run'); },
    } as unknown as ContentService;
    const result = await runManualGenerationMultiStage(service, {
      topic: 'Lead generation', expressionMode: 'direct',
      author: { description: 'B2B marketing practitioner', tone: 'Conversational', niches: ['Marketing'] },
    }, 'OPENAI', createManualProviderCallBudget());
    assert.equal(result.selectedPlan.coreClaim, claim);
    assert.match(draftPrompt, new RegExp(`CENTRAL CLAIM \\(fixed\\): ${claim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.equal(result.providerCalls, 2);
  });

  it('parses narrow healthcare and leadership planning claims', () => {
    const healthcare = parseManualPlanningResult(planningResponse('Many recoverable denials become permanent losses because follow-up happens after the filing deadline.', 'Filing windows create the permanent loss'));
    const leadership = parseManualPlanningResult(planningResponse('A team can hit its targets while depending on an unhealthy concentration of workload among a few people.', 'Targets can conceal workload concentration'));
    assert.match(healthcare.angles[0].coreClaim, /filing deadline/);
    assert.match(leadership.angles[0].coreClaim, /concentration of workload/);
  });

  it('keeps provider failure non-blocking with a grammatical fallback claim', async () => {
    const service = {
      fetchComposerPlanningRaw: async () => { throw new Error('planning unavailable'); },
      fetchComposerGenerationRaw: async () => JSON.stringify(draft('API design can create worse outcomes when its underlying decision criteria stay unchanged as volume or complexity grows.')),
      fetchComposerRepairRaw: async () => { throw new Error('repair should not run'); },
      fetchComposerRewriteRaw: async () => { throw new Error('critic should not run'); },
    } as unknown as ContentService;
    const result = await runManualGenerationMultiStage(service, {
      topic: 'Why API design matters for scalable web applications', expressionMode: 'analytical',
      author: { description: 'Backend engineer', tone: 'Conversational', niches: ['API design'] },
    }, 'OPENAI', createManualProviderCallBudget());
    assert.equal(result.selectedPlan.coreClaim, 'API design can create worse outcomes when its underlying decision criteria stay unchanged as volume or complexity grows.');
    assert.doesNotMatch(result.selectedPlan.coreClaim, /Why API design matters.*can intensify/i);
  });

  it('builds the same safe fallback directly', () => {
    const fallback = createFallbackManualPlan('Why API design matters for scalable web applications', 'analytical');
    assert.equal(fallback.coreClaim, 'API design can create worse outcomes when its underlying decision criteria stay unchanged as volume or complexity grows.');
  });
});
