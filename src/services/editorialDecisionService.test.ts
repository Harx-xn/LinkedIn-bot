import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AuthorContext, BatchPostPlan, GeneratedPostContent, TrendCandidate } from './generationTypes';
import {
  evaluateFirstThreeLines,
  selectEditorialDecision,
} from './editorialDecisionService';
import { classifyFinalPostFingerprint } from './finalPostFingerprintClassifier';
import { runDeterministicValidation } from './ghostwriterValidationService';

function trend(topic: string, extra: Partial<TrendCandidate> = {}): TrendCandidate {
  return { topic, ...extra };
}

describe('idea-aware editorial decisions', () => {
  it('does not select a fabricated first-person hook without personal evidence', () => {
    const decision = selectEditorialDecision(trend(
      'The useful lesson appears after a workflow fails at its ownership boundary.',
      { personalEvidencePotential: 'STRONGLY_BENEFICIAL' },
    ));
    assert.equal(decision.personalEvidenceAvailable, false);
    assert.notEqual(decision.hookFamily, 'FIRST_PERSON_LESSON');
    assert.notEqual(decision.hookFamily, 'STORY_OPENING');
  });

  it('can select a first-person opening when authentic evidence is explicitly available', () => {
    const decision = selectEditorialDecision(trend(
      'The lesson from rebuilding an intake workflow is that unclear ownership creates delay.',
      { personalEvidencePotential: 'STRONGLY_BENEFICIAL' },
    ), { personalEvidenceAvailable: true });
    assert.equal(decision.contentObjective, 'SHOW_EXPERIENCE');
    assert.equal(decision.hookFamily, 'FIRST_PERSON_LESSON');
    assert.equal(decision.rhetoricalStructure, 'STORY_TURNING_POINT_LESSON');
  });

  it('penalizes a repeated hook family within the current batch', () => {
    const idea = trend('Clear ownership makes handoffs easier to diagnose.');
    const first = selectEditorialDecision(idea);
    const second = selectEditorialDecision(idea, { currentBatch: [first] });
    assert.notEqual(second.hookFamily, first.hookFamily);
  });

  it('penalizes a repeated body structure within the current batch', () => {
    const idea = trend('A narrow decision deserves a precise explanation.');
    const first = selectEditorialDecision(idea);
    const second = selectEditorialDecision(idea, { currentBatch: [first] });
    assert.notEqual(second.rhetoricalStructure, first.rhetoricalStructure);
  });

  it('penalizes repeated structure in the actual generated body, not only in labels', () => {
    const editorialDecision = selectEditorialDecision(trend('Explicit ownership makes delayed handoffs diagnosable.'));
    const plan: BatchPostPlan = {
      trendIndex: 0,
      sourceTopic: 'handoff ownership',
      angle: 'product_lesson',
      hookStyle: 'observation',
      endingStyle: 'natural',
      layout: 'short_observation',
      expressionMode: 'analytical',
      rationale: 'test',
      editorialDecision,
    };
    const body = 'Delayed handoffs become diagnosable when ownership is explicit.\n\nBecause one role owns the exception queue, unresolved work has a visible escalation path.\n\nThat boundary reduces ambiguity at the next decision.';
    const post: GeneratedPostContent = { headline: '', subheadline: '', bulletPoints: [], body, hashtags: '' };
    const author: AuthorContext = { description: 'Operations professional', tone: 'clear', targetAudience: ['operations teams'] };
    const result = runDeterministicValidation(post, author, plan, [body]);
    assert.ok(result.issues.some((issue) => issue.code === 'repeated_body_structure'));
  });

  it('keeps question CTAs opt-in rather than a default ending', () => {
    const decision = selectEditorialDecision(trend('Clear escalation ownership reduces ambiguity.'));
    assert.equal(decision.conversionObjective, 'NONE');
    assert.notEqual(decision.endingIntent, 'QUESTION');
  });

  it('distinguishes a strong conclusion from a post that simply has no CTA', () => {
    const conclusion = classifyFinalPostFingerprint('Ownership controls queue health.\n\nThis means the escalation path is part of the design.');
    const noCta = classifyFinalPostFingerprint('Ownership controls queue health.\n\nExplicit ownership reduces ambiguity at the handoff.');
    assert.equal(conclusion.endingIntent, 'CONCLUSION');
    assert.equal(noCta.endingIntent, 'NO_CTA');
  });

  it('lets the content objective influence rhetorical structure without imposing a domain template', () => {
    const decision = selectEditorialDecision(trend(
      'A useful framework starts with the decision boundary, then explains how to apply it.',
      { ideaFamily: 'decision heuristic' },
    ));
    assert.equal(decision.contentObjective, 'CREATE_REFERENCE_VALUE');
    assert.equal(decision.rhetoricalStructure, 'FRAMEWORK_EXPLANATION_APPLICATION');
    assert.equal(decision.referenceValueForm, 'HEURISTIC');
  });

  it('allows a value-dense compact editorial form', () => {
    const decision = selectEditorialDecision(trend('Clarity beats volume.'));
    assert.equal(decision.rhetoricalStructure, 'COMPACT_INSIGHT');
    assert.equal(decision.endingIntent, 'NO_CTA');
  });

  it('penalizes generic category introductions in the first three lines', () => {
    const evaluation = evaluateFirstThreeLines('When it comes to patient retention, communication is important.\n\nThere are many factors to consider.');
    assert.ok(evaluation.issues.some((issue) => issue.code === 'generic_category_intro' && issue.severity === 'error'));
  });

  it('remains niche-generic across unrelated professions', () => {
    const decisions = [
      trend('A reminder cannot repair retention when uncertainty begins after the appointment.'),
      trend('A recruiter should compare evidence quality rather than interview confidence.'),
      trend('A property inspection checklist fails when nobody owns exception follow-up.'),
    ].map((candidate) => selectEditorialDecision(candidate));
    assert.equal(decisions.length, 3);
    assert.ok(decisions.every((decision) => decision.contentObjective && decision.rhetoricalStructure));
    assert.ok(decisions.every((decision) => decision.conversionObjective === 'NONE'));
  });
});
