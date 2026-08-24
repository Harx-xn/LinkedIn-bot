import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { BatchPostPlan, GeneratedPostContent, PostDepthPlan } from './generationTypes';
import { classifyPostDepth, POST_DEPTH_TARGETS, resolvePostDepthMetadata, withDerivedPostDepth } from './postDepth';
import { evaluateGeneratedPostLength } from './generatedPostLength';
import { filterBlockingIssues, runDeterministicValidation } from './ghostwriterValidationService';
import { generateSlotPost, generateSlotPostUntilSuccess } from './ghostwriterGenerationService';
import type { ContentService } from './contentService';

const AUTHOR = {
  description: 'Product and operations writer.',
  tone: 'Professional',
  niches: ['Operations'],
};

const BASE_DEPTH: PostDepthPlan = {
  centralClaim: 'Approval boundaries determine whether an automated workflow remains trustworthy.',
  whyThisClaimIsInteresting: null,
  strongestObservations: [],
  underlyingCauseOrMechanism: null,
  deeperInterpretation: null,
  meaningfulConsequence: null,
  usefulTensionOrQualification: null,
  personalPerspective: { supported: false, insight: null },
  endingInsight: null,
  avoidIdeas: ['generic automation advice'],
};

function plan(depthPlan: PostDepthPlan = BASE_DEPTH): BatchPostPlan {
  return withDerivedPostDepth({
    trendIndex: 0,
    sourceTopic: 'Approval boundaries',
    centralClaim: depthPlan.centralClaim,
    angle: 'reflection',
    hookStyle: 'observation',
    endingStyle: 'natural',
    layout: 'short_observation',
    rationale: 'test',
    expressionMode: 'reflective',
    depthPlan,
  });
}

function post(body: string): GeneratedPostContent {
  return { headline: '', subheadline: '', bulletPoints: [], body, hashtags: '' };
}

function padOneParagraph(seed: string, length: number): string {
  const addition = ' The workflow records the decision, its owner, and the condition that allowed it.';
  let result = seed;
  while (result.length + addition.length <= length) result += addition;
  return result.padEnd(length, ' ');
}

const STRONG_COMPACT_BODY = `A useful approval boundary records who can release a workflow and which condition authorizes that decision. The check happens before execution, so a failed approval cannot be mistaken for a completed action.

That boundary also gives retries a stable state to inspect. A worker can distinguish pending approval from an execution failure instead of repeating the action whenever a timeout hides the previous response.

The narrow insight is that trust comes from an inspectable decision boundary. More automation is not the remedy when ownership of that decision remains ambiguous.

Once the boundary is explicit, recovery becomes a decision instead of a guess because the recorded state explains what may happen next. The system can resume an authorized action, hold an unapproved one, and expose the difference without adding another workflow layer.`;

describe('batch post depth classification', () => {
  it('derives compact, standard, and deep classes from substantive plan obligations', () => {
    assert.equal(classifyPostDepth(plan()), 'COMPACT');

    const standard = plan({
      ...BASE_DEPTH,
      strongestObservations: ['Approvals remain pending after the worker is ready.'],
      underlyingCauseOrMechanism: 'The workflow cannot distinguish permission state from execution state.',
    });
    assert.equal(standard.depthClass, 'STANDARD');

    const deep = plan({
      ...BASE_DEPTH,
      whyThisClaimIsInteresting: 'Successful execution can still conceal an invalid approval transition.',
      strongestObservations: ['Approvals remain pending.', 'Retries repeat completed work.', 'Ownership is unclear.'],
      underlyingCauseOrMechanism: 'Permission state and execution state share one ambiguous transition.',
      deeperInterpretation: 'The automation problem is really an ownership-model problem.',
      meaningfulConsequence: 'Recovery must preserve both the decision and the action separately.',
    });
    assert.equal(deep.depthClass, 'DEEP');
  });

  it('keeps depth-aware ranges soft while preserving the hard platform maximum', () => {
    assert.equal(evaluateGeneratedPostLength('x'.repeat(800), POST_DEPTH_TARGETS.COMPACT), 'PREFERRED');
    assert.equal(evaluateGeneratedPostLength('x'.repeat(1200), POST_DEPTH_TARGETS.STANDARD), 'PREFERRED');
    assert.equal(evaluateGeneratedPostLength('x'.repeat(2200), POST_DEPTH_TARGETS.DEEP), 'PREFERRED');
    assert.equal(evaluateGeneratedPostLength('x'.repeat(1200), POST_DEPTH_TARGETS.COMPACT), 'ACCEPTABLE');
    assert.equal(evaluateGeneratedPostLength('x'.repeat(3001), POST_DEPTH_TARGETS.COMPACT), 'TOO_LONG');
  });
});

describe('depth-aware batch validation', () => {
  it('accepts a strong concise compact post below the former universal minimum', () => {
    assert.ok(STRONG_COMPACT_BODY.length >= 600 && STRONG_COMPACT_BODY.length <= 900);
    const result = runDeterministicValidation(post(STRONG_COMPACT_BODY), AUTHOR, plan(), [], { enforceLength: true });
    assert.equal(result.passed, true, result.issues.map((issue) => issue.code).join(','));
    assert.equal(result.issues.some((issue) => issue.code === 'generated_post_too_short'), false);
  });

  it('rejects a vague 700-character compact post on quality rather than arbitrary length', () => {
    const body = padOneParagraph('Success matters. Clear strategy improves outcomes.', 750);
    const result = runDeterministicValidation(post(body), AUTHOR, plan(), [], { enforceLength: true });
    assert.equal(result.issues.some((issue) => issue.code === 'generated_post_too_short'), false);
    assert.ok(result.issues.some((issue) => issue.code === 'insufficient_specificity'));
    assert.equal(result.passed, false);
  });

  it('accepts a complete 1200-character standard post', () => {
    const standard = plan({
      ...BASE_DEPTH,
      strongestObservations: ['A pending approval and a failed action produce different recovery decisions.'],
      underlyingCauseOrMechanism: 'A separate state transition preserves who authorized execution and when.',
    });
    const body = padOneParagraph('A workflow should store approval separately from execution because each state answers a different recovery question.', 1200);
    const result = runDeterministicValidation(post(body), AUTHOR, standard, [], { enforceLength: true });
    assert.equal(result.passed, true, result.issues.map((issue) => issue.code).join(','));
  });

  it('rejects an obviously incomplete 600-character draft for a deep plan', () => {
    const deep = plan({
      ...BASE_DEPTH,
      strongestObservations: ['Approvals remain pending.', 'Retries repeat completed work.', 'Ownership is unclear.'],
      underlyingCauseOrMechanism: 'Permission and execution share one state.',
      deeperInterpretation: 'The automation problem is an ownership-model problem.',
      meaningfulConsequence: 'Recovery must preserve both decisions.',
    });
    const result = runDeterministicValidation(
      post(padOneParagraph('The workflow records approval before execution because the states answer different questions.', 600)),
      AUTHOR,
      deep,
      [],
      { enforceLength: true },
    );
    assert.ok(result.issues.some((issue) => issue.code === 'generated_post_too_short'));
  });

  it('accepts a 2200-character deep treatment and rejects hard platform overflow', () => {
    const deep = plan({
      ...BASE_DEPTH,
      strongestObservations: ['Approvals remain pending.', 'Retries repeat completed work.', 'Ownership is unclear.'],
      underlyingCauseOrMechanism: 'Permission and execution share one state.',
      deeperInterpretation: 'The automation problem is an ownership-model problem.',
      meaningfulConsequence: 'Recovery must preserve both decisions.',
    });
    const accepted = runDeterministicValidation(
      post(padOneParagraph('The workflow records approval before execution because the states answer different recovery questions.', 2200)),
      AUTHOR,
      deep,
      [],
      { enforceLength: true },
    );
    assert.equal(accepted.issues.some((issue) => issue.code.startsWith('generated_post_')), false);

    const overflow = runDeterministicValidation(post('x'.repeat(3001)), AUTHOR, plan(), [], { enforceLength: true });
    assert.ok(overflow.issues.some((issue) => issue.code === 'generated_post_too_long'));
  });

  it('never relaxes depth completeness or factual safety at high retry counts', () => {
    const issues = [
      { code: 'generated_post_too_short', severity: 'error' as const },
      { code: 'ARGUMENT_STAGNATION', severity: 'error' as const },
      { code: 'auth_vs_authorization', severity: 'error' as const },
    ];
    assert.deepEqual(filterBlockingIssues(issues, 99).map((issue) => issue.code), issues.map((issue) => issue.code));
  });

  it('does not alter depth classification when retry gates are relaxed', () => {
    const deep = plan({
      ...BASE_DEPTH,
      strongestObservations: ['Approvals remain pending.', 'Retries repeat completed work.', 'Ownership is unclear.'],
      underlyingCauseOrMechanism: 'Permission and execution share one state.',
      deeperInterpretation: 'The automation problem is an ownership-model problem.',
      meaningfulConsequence: 'Recovery must preserve both decisions.',
    });
    const before = resolvePostDepthMetadata(deep);
    filterBlockingIssues([{ code: 'generated_post_too_short', severity: 'error' }], 99);
    assert.deepEqual(resolvePostDepthMetadata(deep), before);
    assert.equal(before.depthClass, 'DEEP');
  });
});

describe('depth-aware generation and repair', () => {
  it('does not send a complete compact post to expansion or repair', async () => {
    let repairCalls = 0;
    const service = {
      generatePlannedPost: async () => post(STRONG_COMPACT_BODY),
      reviewTechnicalClaims: async () => ({ passed: true, confidence: 1, issues: [] }),
      expandSpecificity: async () => { repairCalls += 1; return post(STRONG_COMPACT_BODY); },
      repairPost: async () => { repairCalls += 1; return post(STRONG_COMPACT_BODY); },
    } as unknown as ContentService;

    const result = await generateSlotPost(
      service,
      plan(),
      null,
      AUTHOR,
      { niches: ['Operations'] },
      [],
    );
    assert.equal(result.ok, true);
    assert.equal(repairCalls, 0);
  });

  it('keeps legacy plans usable while deriving depth metadata internally', async () => {
    const legacyPlan: BatchPostPlan = {
      trendIndex: 0,
      sourceTopic: 'Approval boundaries',
      angle: 'reflection',
      hookStyle: 'observation',
      endingStyle: 'natural',
      layout: 'short_observation',
      rationale: 'legacy plan without depth metadata',
      expressionMode: 'reflective',
      depthPlan: BASE_DEPTH,
    };
    const service = {
      generatePlannedPost: async () => post(STRONG_COMPACT_BODY),
      reviewTechnicalClaims: async () => ({ passed: true, confidence: 1, issues: [] }),
    } as unknown as ContentService;

    const result = await generateSlotPostUntilSuccess(
      service,
      legacyPlan,
      null,
      AUTHOR,
      { niches: ['Operations'] },
      [],
    );
    assert.equal(result.ok, true);
  });
});
