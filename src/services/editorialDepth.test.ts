import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectManualExpressionMode } from './expressionModeService';
import { buildDeterministicBatchPlan } from './ghostwriterBatchPlanner';
import { evaluateDepthPlanQuality, scoreHook } from './manualPost/manualPostPlanning';
import { buildManualDraftPrompt, buildManualTargetedRepairPrompt } from './manualPost/manualPostPrompts';
import { buildRepairPrompt } from './ghostwriterPrompts';
import { ContentService } from './contentService';
import type { SelectedManualPlan } from './manualPost/manualPostTypes';

const plan: SelectedManualPlan = {
  title: 'Automation trust',
  coreClaim: 'Automation adoption stalls when teams cannot see how control and accountability move.',
  audience: 'Operations leaders',
  structure: 'observation -> cause -> interpretation',
  evidenceMode: 'reasoned_observation',
  hook: 'The hardest part of automation is rarely the integration.',
  selectedHookType: 'CONCRETE_OBSERVATION',
  depthPlan: {
    centralClaim: 'Automation adoption stalls when teams cannot see how control and accountability move.',
    whyThisClaimIsInteresting: 'Technical success can coexist with adoption failure.',
    strongestObservations: ['Delayed approvals', 'Duplicate manual checks'],
    underlyingCauseOrMechanism: 'Teams preserve manual control when accountability is unclear.',
    deeperInterpretation: 'The resistance protects an ownership boundary rather than rejecting automation.',
    meaningfulConsequence: 'Implementation must design trust and ownership before selling efficiency.',
    usefulTensionOrQualification: null,
    personalPerspective: { supported: false, insight: null },
    endingInsight: 'The transfer of control was the real implementation risk.',
    avoidIdeas: ['trust improves adoption', 'generic recommendation to communicate better'],
  },
};

describe('editorial depth planning', () => {
  it('accepts distinct observation, cause, interpretation, and consequence dimensions', () => {
    assert.equal(evaluateDepthPlanQuality(plan.depthPlan).passed, true);
  });

  it('rejects a shallow plan whose dimensions restate one proposition', () => {
    const shallow = {
      ...plan.depthPlan,
      strongestObservations: ['Trust improves automation adoption'],
      underlyingCauseOrMechanism: null,
      deeperInterpretation: 'Automation adoption improves with trust',
      meaningfulConsequence: 'Better trust means better automation adoption',
    };
    assert.equal(evaluateDepthPlanQuality(shallow).passed, false);
  });

  it('puts the approved Depth Plan and editorial authority into drafting and repair prompts', () => {
    const common = { topic: 'Automation trust', author: { description: 'Operations leader', tone: 'Direct' }, selectedPlan: plan };
    const draftPrompt = buildManualDraftPrompt({ ...common, expressionMode: 'analytical' });
    assert.match(draftPrompt, /DEPTH PLAN/);
    assert.match(draftPrompt, /resistance protects an ownership boundary/);
    assert.match(draftPrompt, /EDITORIAL AUTHORITY — FINAL/);
    assert.match(draftPrompt, /not supported; do not invent first-person experience/);
    const repairPrompt = buildManualTargetedRepairPrompt({
      ...common,
      expressionMode: 'analytical',
      draft: { contentPlan: { angle: plan.title, coreClaim: plan.coreClaim, audience: plan.audience, structure: plan.structure, hookType: plan.selectedHookType, evidenceType: plan.evidenceMode, ctaType: 'none' }, hook: plan.hook, body: 'Short draft', closingLine: '', hashtags: [] },
      detectedIssues: ['POST_BELOW_MINIMUM_LENGTH'],
      missingPlanDimension: 'consequence',
    });
    assert.match(repairPrompt, /Develop the planned consequence/);
    assert.match(repairPrompt, /observations: Delayed approvals \| Duplicate manual checks/);

    const batchRepairPrompt = buildRepairPrompt(
      { headline: '', subheadline: '', bulletPoints: [], body: 'Short draft', hashtags: '' },
      [{ code: 'generated_post_too_short', severity: 'error', instruction: 'Expand with depth.' }],
      common.author,
      {
        trendIndex: 0, sourceTopic: 'Automation trust', angle: 'product_lesson', hookStyle: 'observation',
        endingStyle: 'natural', layout: 'short_observation', rationale: 'test', expressionMode: 'direct', depthPlan: plan.depthPlan,
      },
    );
    assert.match(batchRepairPrompt, /LENGTH REPAIR DEPTH CHECK/);
    assert.match(batchRepairPrompt, /resistance protects an ownership boundary/);
    assert.match(batchRepairPrompt, /do not inflate the draft to reach the soft range/);
  });

  it('deprioritizes generic question hooks while retaining question support', () => {
    const base = { type: 'question', specificity: 8, curiosity: 8, topicRelevance: 8, clarity: 8, voiceFit: 8 };
    assert.ok(scoreHook({ ...base, text: 'The risk appears before integration begins.' }) > scoreHook({ ...base, text: 'What if the secret to automation is trust?' }));
  });

  it('favors analytical/direct/reflective defaults while respecting explicit controls', () => {
    assert.equal(selectManualExpressionMode('Automation ownership boundaries', '', undefined, []), 'analytical');
    assert.equal(selectManualExpressionMode('Automation ownership boundaries', 'Format: Listicle', undefined, []), 'walkthrough');
    assert.equal(selectManualExpressionMode('Automation ownership boundaries', 'Use storytelling', undefined, []), 'conversational');
    assert.equal(selectManualExpressionMode('Automation ownership boundaries', 'Preferred structure: Question -> answer.', undefined, []), 'conversational');
    assert.equal(selectManualExpressionMode('Automation ownership boundaries', 'Preferred tone override: Analytical and precise.', undefined, []), 'analytical');
  });

  it('gives deterministic batch plans a machine-readable Depth Plan', () => {
    const [batchPlan] = buildDeterministicBatchPlan([{ topic: 'Automation trust', keyPoints: ['Delayed approvals', 'Duplicate checks'], summary: 'Control transfer shapes adoption.' }], 1);
    assert.deepEqual(batchPlan.depthPlan?.strongestObservations, ['Delayed approvals', 'Duplicate checks']);
    assert.equal(batchPlan.depthPlan?.deeperInterpretation, 'Control transfer shapes adoption.');
    assert.ok(batchPlan.depthClass);
    assert.ok(batchPlan.targetLengthRange);
  });

  it('reuses the existing batch claim-planning call to return the approved Depth Plan', async () => {
    const service = new ContentService({});
    let calls = 0;
    (service as any).generateWithFallback = async () => {
      calls += 1;
      return JSON.stringify({ claims: [{ index: 0, centralClaim: plan.coreClaim, depthPlan: plan.depthPlan }] });
    };
    const [planned] = await service.narrowBatchClaims(
      [{
        trendIndex: 0, sourceTopic: 'Automation trust', angle: 'product_lesson', hookStyle: 'observation',
        endingStyle: 'natural', layout: 'short_observation', rationale: 'test', expressionMode: 'direct',
      }],
      [{ topic: 'Automation trust' }],
      { description: 'Operations leader', tone: 'Direct' },
    );
    assert.equal(calls, 1);
    assert.equal(planned.depthPlan?.deeperInterpretation, plan.depthPlan.deeperInterpretation);
    assert.equal(planned.depthPlan?.centralClaim, plan.coreClaim);
  });
});
