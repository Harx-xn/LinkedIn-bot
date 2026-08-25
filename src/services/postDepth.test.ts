import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { BatchPostPlan, GeneratedPostContent, PostDepthPlan } from './generationTypes';
import { classifyPostDepth, classifyPostDepthWithTrace, POST_DEPTH_TARGETS, resolvePostDepthMetadata, withDerivedPostDepth } from './postDepth';
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

  it('does not promote three paraphrased fields to DEEP', () => {
    const result = classifyPostDepthWithTrace(plan({
      ...BASE_DEPTH,
      centralClaim: 'A local optimization can move the bottleneck.',
      underlyingCauseOrMechanism: 'The bottleneck moves to another step.',
      meaningfulConsequence: 'Another step becomes the bottleneck.',
    }));
    assert.equal(result.depthClass, 'COMPACT');
    assert.ok(result.discountedRedundantSignals.length >= 2);
  });

  it('keeps one sharp claim COMPACT', () => {
    const result = classifyPostDepthWithTrace(plan());
    assert.equal(result.depthClass, 'COMPACT');
    assert.deepEqual(result.independentSubstanceUnits.map((unit) => unit.type), ['CORE_INSIGHT']);
  });

  it('makes a distinct mechanism and consequence STANDARD', () => {
    const result = classifyPostDepthWithTrace(plan({
      ...BASE_DEPTH,
      underlyingCauseOrMechanism: 'A separate state transition preserves the authorization timestamp.',
      meaningfulConsequence: 'Operators can choose whether to resume, cancel, or investigate after a timeout.',
    }));
    assert.equal(result.depthClass, 'STANDARD');
    assert.equal(result.signalsContributing.mechanismPresent, true);
    assert.equal(result.signalsContributing.consequencePresent, true);
  });

  it('counts a genuine trade-off as independent substance without forcing DEEP', () => {
    const withoutTradeoff = classifyPostDepthWithTrace(plan({
      ...BASE_DEPTH,
      underlyingCauseOrMechanism: 'A separate state transition preserves the authorization timestamp.',
      meaningfulConsequence: 'Operators can choose whether to resume, cancel, or investigate after a timeout.',
    }));
    const withTradeoff = classifyPostDepthWithTrace(plan({
      ...BASE_DEPTH,
      underlyingCauseOrMechanism: 'A separate state transition preserves the authorization timestamp.',
      meaningfulConsequence: 'Operators can choose whether to resume, cancel, or investigate after a timeout.',
      usefulTensionOrQualification: 'The extra checkpoint is slower, but it prevents an ambiguous replay decision.',
    }));
    assert.ok(withTradeoff.depthScore > withoutTradeoff.depthScore);
    assert.equal(withTradeoff.signalsContributing.tradeoffPresent, true);
    assert.equal(withTradeoff.depthClass, 'STANDARD');
  });

  it('does not count a source title alone as evidence', () => {
    const result = classifyPostDepthWithTrace(plan(), {
      topic: 'Benchmark report title',
      link: 'https://example.test/report',
      evidenceRole: 'primary',
      supportingSources: [{ url: 'https://example.test/report', source: 'Report title', evidenceRole: 'primary' }],
    });
    assert.equal(result.signalsContributing.evidencePresent, false);
    assert.equal(result.depthClass, 'COMPACT');
  });

  it('lets a genuine multi-step process increase depth', () => {
    const depthPlan: PostDepthPlan = {
      ...BASE_DEPTH,
      strongestObservations: [
        'First, record the authorization decision before work enters the queue.',
        'Next, execute the approved action with an idempotency key tied to that decision.',
        'Then, reconcile the worker response against the separately stored execution state.',
      ],
    };
    const result = classifyPostDepthWithTrace(withDerivedPostDepth({
      ...plan(depthPlan), angle: 'practical_tutorial', layout: 'technical_walkthrough', depthPlan,
    }));
    assert.equal(result.depthClass, 'DEEP');
    assert.equal(result.signalsContributing.walkthroughPresent, true);
  });

  it('does not reward artificial listification', () => {
    const depthPlan: PostDepthPlan = {
      ...BASE_DEPTH,
      centralClaim: 'Record the approval state before execution begins.',
      strongestObservations: [
        'First, record the approval state before execution begins.',
        'Next, record the approval state before starting execution.',
        'Then, save the approval state prior to execution.',
        'Finally, store approval before execution starts.',
      ],
    };
    const result = classifyPostDepthWithTrace(withDerivedPostDepth({
      ...plan(depthPlan), angle: 'practical_tutorial', layout: 'technical_walkthrough', depthPlan,
    }));
    assert.notEqual(result.depthClass, 'DEEP');
    assert.equal(result.signalsContributing.walkthroughPresent, false);
    assert.ok(result.discountedRedundantSignals.length >= 3);
  });

  it('preserves compact drafting without universal long-form pressure', () => {
    const compact = withDerivedPostDepth(plan());
    assert.equal(compact.depthClass, 'COMPACT');
    assert.deepEqual(compact.targetLengthRange, POST_DEPTH_TARGETS.COMPACT);
    assert.ok(POST_DEPTH_TARGETS.COMPACT.min < POST_DEPTH_TARGETS.DEEP.min);
  });

  it('classifies unrelated niches by substance rather than domain vocabulary', () => {
    const operations = classifyPostDepthWithTrace(plan({
      ...BASE_DEPTH,
      underlyingCauseOrMechanism: 'A shared queue hides which team owns the retry decision.',
      meaningfulConsequence: 'Operators cannot distinguish safe recovery from duplicate execution.',
    }));
    const education = classifyPostDepthWithTrace(plan({
      ...BASE_DEPTH,
      centralClaim: 'Feedback timing changes which misconception a learner can correct.',
      underlyingCauseOrMechanism: 'Delayed review separates the correction from the decision that produced the error.',
      meaningfulConsequence: 'Learners repeat the wrong method before they can identify the faulty step.',
    }));
    assert.equal(operations.depthClass, 'STANDARD');
    assert.equal(education.depthClass, 'STANDARD');
  });

  it('adds no model client or model call to depth classification', () => {
    const source = readFileSync(require.resolve('./postDepth'), 'utf8');
    assert.doesNotMatch(source, /openai|gemini|generateWithFallback|generateContent|chat\.completions/i);
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

  it('repairs a warning-only reviewer failure instead of normally accepting it', async () => {
    let reviewCalls = 0;
    let repairCalls = 0;
    let receivedRepairCodes: string[] = [];
    const service = {
      generatePlannedPost: async () => post(STRONG_COMPACT_BODY),
      reviewTechnicalClaims: async () => {
        reviewCalls += 1;
        return reviewCalls === 1
          ? {
              available: true, passed: false, confidence: 1,
              informationDensity: 75, progressionQuality: 75, redundancyRisk: 20,
              genericDiscourseRisk: 20, claimFidelity: 85,
              issues: [{
                code: 'other' as const, severity: 'warning' as const, excerpt: 'A qualification is missing.',
                explanation: 'The conclusion needs a qualification.', repairInstruction: 'Add the qualification.',
              }],
            }
          : {
              available: true, passed: true, confidence: 1,
              informationDensity: 85, progressionQuality: 85, redundancyRisk: 10,
              genericDiscourseRisk: 10, claimFidelity: 95, issues: [],
            };
      },
      repairPost: async (_generated: GeneratedPostContent, issues: Array<{ code: string }>) => {
        repairCalls += 1;
        receivedRepairCodes = issues.map((issue) => issue.code);
        return post(STRONG_COMPACT_BODY);
      },
    } as unknown as ContentService;

    const result = await generateSlotPost(service, plan(), null, AUTHOR, { niches: ['Operations'] }, []);
    assert.equal(result.ok, true);
    assert.equal(repairCalls, 1);
    assert.deepEqual(receivedRepairCodes, ['other']);
    assert.equal(result.ok && result.acceptance.accepted, true);
    assert.equal(result.ok && result.fallbackProvenance, undefined);
  });

  it('returns a safe best-usable fallback after bounded warning-only review exhaustion', async () => {
    let generationCalls = 0;
    let repairCalls = 0;
    const service = {
      generatePlannedPost: async () => {
        generationCalls += 1;
        return post(STRONG_COMPACT_BODY);
      },
      reviewTechnicalClaims: async () => ({
        available: true, passed: false, confidence: 1,
        informationDensity: 75, progressionQuality: 75, redundancyRisk: 20,
        genericDiscourseRisk: 20, claimFidelity: 85,
        issues: [{
          code: 'other' as const, severity: 'warning' as const, excerpt: 'A qualification is missing.',
          explanation: 'The conclusion needs a qualification.', repairInstruction: 'Add the qualification.',
        }],
      }),
      repairPost: async () => {
        repairCalls += 1;
        return post(STRONG_COMPACT_BODY);
      },
    } as unknown as ContentService;

    const result = await generateSlotPost(service, plan(), null, AUTHOR, { niches: ['Operations'] }, []);
    assert.equal(result.ok, true);
    assert.equal(generationCalls, 3);
    assert.equal(repairCalls, 6);
    assert.equal(result.ok && result.acceptance.accepted, false);
    assert.deepEqual(result.ok && result.fallbackProvenance, ['BEST_USABLE_FALLBACK']);
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
