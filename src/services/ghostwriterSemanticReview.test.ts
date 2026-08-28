import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTechnicalReviewOutput } from './contentService';
import { buildAcceptanceDecision, mergeQualityIssues, shouldRunTechnicalReview } from './ghostwriterGenerationService';
import { evaluateSemanticProgression } from './semanticProgression';
import { detectDeterministicTechnicalIssues, detectUnsupportedFirstPersonClaims } from './ghostwriterValidationService';

function reviewJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    passed: true, confidence: 0.9, informationDensity: 85, progressionQuality: 85,
    redundancyRisk: 10, genericDiscourseRisk: 10, claimFidelity: 95, issues: [], ...overrides,
  });
}

describe('semantic information-gain review', () => {
  it('literal repetition fails deterministic progression', () => {
    const result = evaluateSemanticProgression(`Approval ownership controls automation trust.

Automation trust is controlled by approval ownership.

Clear approval ownership controls whether teams trust automation.`);
    assert.equal(result.passed, false);
    assert.ok(result.codes.includes('SEMANTIC_REPETITION'));
  });

  it('paraphrased repetition fails semantic review', () => {
    const result = parseTechnicalReviewOutput(reviewJson({
      passed: false, informationDensity: 35, progressionQuality: 30, redundancyRisk: 88,
      issues: [{ code: 'THESIS_RESTATEMENT', severity: 'error', excerpt: 'the later sections', explanation: 'Different vocabulary repeats the opening proposition.', repairInstruction: 'Replace the restatement with a new consequence.' }],
    }));
    assert.equal(result.passed, false);
    assert.ok(result.issues.some((issue) => issue.code === 'THESIS_RESTATEMENT'));
    assert.ok(result.issues.some((issue) => issue.code === 'REDUNDANT_EXPLANATION'));
  });

  it('adding because does not make literal repetition pass', () => {
    const result = evaluateSemanticProgression(`Teams distrust automation when approval ownership is unclear.

Because approval ownership is unclear, teams distrust automation.

Unclear approval ownership therefore makes automation difficult to trust.`);
    assert.equal(result.passed, false);
    assert.ok(result.codes.includes('SEMANTIC_REPETITION'));
  });

  it('genuine mechanism to consequence progression passes', () => {
    const result = evaluateSemanticProgression(`Approval ownership determines whether automation feels safe.

When nobody owns an exception, teams create duplicate manual checks because they cannot predict who will resolve it.

Those checks lengthen the queue and hide which decisions actually need human judgment.

Assigning exception ownership therefore removes a specific source of delay without pretending every approval can disappear.`);
    assert.equal(result.passed, true);
  });

  it('flags a generic article-style structure', () => {
    const result = evaluateSemanticProgression(`In today's evolving landscape, automation is increasingly important.

The issue lies in finding a sustainable approach.

Consider a scenario where an organization introduces a new system.

To mitigate these risks, here are three practical steps.
- Communicate clearly
- Train the team
- Review progress

The key is finding the right balance.`);
    assert.ok(result.codes.includes('GENERIC_SCENARIO_STRUCTURE'));
    assert.ok(result.codes.includes('GENERIC_CHECKLIST_EXPANSION'));
  });

  it('flags paraphrased generic discourse structure', () => {
    const result = evaluateSemanticProgression(`Modern workplaces change quickly, making automation a priority.

A common challenge is choosing an approach everyone accepts.

Imagine a team introducing a system across the organization.

Actionable steps leaders can take include clearer communication and regular reviews.

Striking the proper balance is what matters most.`);
    assert.ok(result.codes.includes('GENERIC_SCENARIO_STRUCTURE'));
  });

  it('does not penalize a concise dense post for lacking sections', () => {
    const result = evaluateSemanticProgression('Approval queues slow down when exception ownership is implicit. Naming one owner per exception class removes duplicate checks because each failed decision has a known escalation path.');
    assert.equal(result.passed, true);
  });

  it('allows a longer post whose sections add real information', () => {
    const result = evaluateSemanticProgression(`A retry policy is incomplete without an idempotency boundary.

Network timeouts leave the caller unable to know whether the first write committed, so a retry can repeat a successful action.

An idempotency key lets the server associate both requests with one operation and return the stored result instead of writing twice.

That changes the operational decision: retries can be aggressive for transient transport failures while business-side duplication stays bounded.

The boundary still needs an expiry policy, because storing every key forever creates a different capacity problem.`);
    assert.equal(result.passed, true);
  });

  it('does not convert malformed reviewer JSON into a pass', () => {
    const result = parseTechnicalReviewOutput('{"passed": true, "issues": [}');
    assert.equal(result.available, false);
    assert.equal(result.passed, false);
  });

  it('uses deterministic acceptance when semantic review is unavailable', () => {
    const deterministic = { passed: true, deterministicScore: 91, score: 91, issues: [], specificity: { score: 80, signals: [], missing: [] } };
    assert.equal(shouldRunTechnicalReview(deterministic), true);
    assert.equal(shouldRunTechnicalReview({ ...deterministic, passed: false, issues: [{ code: 'generated_post_too_short', severity: 'error' as const }] }), true);
    assert.equal(shouldRunTechnicalReview({ ...deterministic, passed: false, issues: [{ code: 'environment_isolation_error', severity: 'error' as const }] }), false);
    const decision = buildAcceptanceDecision({ deterministic, technicalReview: { available: false, passed: false, confidence: 0, issues: [] }, blocking: [], warnings: [] });
    assert.equal(decision.accepted, true);
    assert.equal(decision.technicalPassed, false);
    assert.equal(decision.reviewerStatus, 'REVIEWER_NOT_REQUIRED_SAFE_PATH');

    const blockedDeterministic = { ...deterministic, passed: false, issues: [{ code: 'hook_realization_mismatch', severity: 'error' as const }] };
    const unavailable = buildAcceptanceDecision({
      deterministic: blockedDeterministic,
      technicalReview: { available: false, passed: false, confidence: 0, issues: [] },
      blocking: [],
      warnings: [],
    });
    assert.equal(unavailable.accepted, false);
    assert.equal(unavailable.reviewerStatus, 'REVIEWER_UNAVAILABLE');
  });

  it('accepts strong editorial mismatch after bounded repair but keeps claim drift fatal', () => {
    const deterministic = { passed: false, deterministicScore: 93, score: 93, issues: [], specificity: { score: 74, signals: [], missing: [] } };
    const editorial = { code: 'rhetorical_structure_mismatch', severity: 'error' as const };
    const tolerated = buildAcceptanceDecision({
      deterministic,
      technicalReview: { available: true, passed: true, confidence: 0.9, issues: [] },
      blocking: [editorial], warnings: [], repairAttempts: 1,
    });
    assert.equal(tolerated.accepted, true);
    assert.equal(tolerated.acceptanceMode, 'EDITORIAL_TOLERANCE');
    const drift = buildAcceptanceDecision({
      deterministic,
      technicalReview: { available: true, passed: false, confidence: 0.9, issues: [{ code: 'CLAIM_DRIFT', severity: 'error', excerpt: '', explanation: '', repairInstruction: '' }] },
      blocking: [{ code: 'CLAIM_DRIFT', severity: 'error' }], warnings: [], repairAttempts: 1,
    });
    assert.equal(drift.accepted, false);
    assert.equal(drift.reviewerStatus, 'REVIEWER_CRITICAL_FAIL');
  });

  it('classifies moderate reviewer quality failure without exhausting a strong repaired draft', () => {
    const deterministic = { passed: true, deterministicScore: 92, score: 92, issues: [], specificity: { score: 76, signals: [], missing: [] } };
    const result = buildAcceptanceDecision({
      deterministic,
      technicalReview: { available: true, passed: false, confidence: 0.8, informationDensity: 62, progressionQuality: 68, redundancyRisk: 42, genericDiscourseRisk: 35, claimFidelity: 91, issues: [{ code: 'REDUNDANT_EXPLANATION', severity: 'warning', excerpt: '', explanation: '', repairInstruction: '' }] },
      blocking: [], warnings: [{ code: 'REDUNDANT_EXPLANATION', severity: 'warning' }], repairAttempts: 1,
    });
    assert.equal(result.accepted, true);
    assert.equal(result.reviewerStatus, 'REVIEWER_QUALITY_FAIL');
  });

  it('creates targeted density and redundancy repair codes', () => {
    const result = parseTechnicalReviewOutput(reviewJson({ informationDensity: 40, progressionQuality: 45, redundancyRisk: 80 }));
    const codes = result.issues.map((issue) => issue.code);
    assert.ok(codes.includes('LOW_INFORMATION_DENSITY'));
    assert.ok(codes.includes('REDUNDANT_EXPLANATION'));
    assert.ok(codes.includes('WEAK_ARGUMENT_PROGRESSION'));
    assert.match(result.issues.find((issue) => issue.code === 'REDUNDANT_EXPLANATION')!.repairInstruction, /paraphrased support/i);
  });

  it('upgrades a reviewer density warning when the numeric threshold requires an error', () => {
    const result = parseTechnicalReviewOutput(reviewJson({
      informationDensity: 40,
      issues: [{
        code: 'LOW_INFORMATION_DENSITY', severity: 'warning', excerpt: 'Some framing.',
        explanation: 'The draft could be denser.', repairInstruction: 'Add a concrete mechanism.',
      }],
    }), 'A longer excerpt from the reviewed post.');
    const issue = result.issues.filter((item) => item.code === 'LOW_INFORMATION_DENSITY');
    assert.equal(issue.length, 1);
    assert.equal(issue[0].severity, 'error');
    assert.equal(result.passed, false);
  });

  it('keeps reviewer errors stronger than a non-triggering numeric metric', () => {
    const result = parseTechnicalReviewOutput(reviewJson({
      informationDensity: 90,
      issues: [{
        code: 'LOW_INFORMATION_DENSITY', severity: 'error', excerpt: 'Repeated setup.',
        explanation: 'The support adds no information.', repairInstruction: 'Replace setup with a mechanism.',
      }],
    }));
    assert.equal(result.issues.find((item) => item.code === 'LOW_INFORMATION_DENSITY')?.severity, 'error');
    assert.equal(result.passed, false);
  });

  it('keeps an error when issue sources also report the same code as a warning', () => {
    const issues = mergeQualityIssues(
      [{ code: 'CLAIM_DRIFT', severity: 'warning', evidence: ['deterministic wording signal'] }],
      [{ code: 'CLAIM_DRIFT', severity: 'error', evidence: ['reviewer fidelity score'], instruction: 'Restore the selected claim.' }],
    );
    assert.equal(issues.length, 1);
    assert.equal(issues[0].severity, 'error');
    assert.deepEqual(issues[0].evidence, ['deterministic wording signal', 'reviewer fidelity score']);
    assert.equal(issues[0].instruction, 'Restore the selected claim.');
  });

  it('normalizes redundancy consistently on either side of the configured threshold', () => {
    const below = parseTechnicalReviewOutput(reviewJson({ redundancyRisk: 55 }));
    const above = parseTechnicalReviewOutput(reviewJson({ redundancyRisk: 56 }));
    assert.equal(below.issues.some((item) => item.code === 'REDUNDANT_EXPLANATION'), false);
    assert.equal(above.issues.find((item) => item.code === 'REDUNDANT_EXPLANATION')?.severity, 'error');
  });

  it('treats material claim drift as an error while retaining minor warning-level deviation', () => {
    const warning = {
      code: 'CLAIM_DRIFT', severity: 'warning', excerpt: 'A broader phrase.',
      explanation: 'Wording is slightly broader.', repairInstruction: 'Narrow the wording.',
    };
    const minor = parseTechnicalReviewOutput(reviewJson({ claimFidelity: 65, issues: [warning] }));
    const material = parseTechnicalReviewOutput(reviewJson({ claimFidelity: 64, issues: [warning] }));
    assert.equal(minor.issues.find((item) => item.code === 'CLAIM_DRIFT')?.severity, 'warning');
    assert.equal(minor.passed, true);
    assert.equal(material.issues.find((item) => item.code === 'CLAIM_DRIFT')?.severity, 'error');
    assert.equal(material.passed, false);
  });

  it('keeps safety and unsupported-authority checks unchanged', () => {
    assert.ok(detectDeterministicTechnicalIssues('Use one database instance for all environments to ensure consistency.').some((issue) => issue.code === 'environment_isolation_error'));
    assert.ok(detectUnsupportedFirstPersonClaims('In building Veyrais, I encountered this failure.', 'Operations writer').length > 0);
  });
});
