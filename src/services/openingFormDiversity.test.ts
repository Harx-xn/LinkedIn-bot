import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyFinalPostFingerprint, classifyOpeningForm } from './finalPostFingerprintClassifier';

describe('realized opening-form classification', () => {
  it('groups wording variants of a misconception correction into one rhetorical move', () => {
    const variants = [
      'A common misconception is that retries guarantee delivery.',
      'Many engineering teams assume retries guarantee delivery.',
      'The myth that retries guarantee delivery hides duplicate work.',
    ];
    assert.deepEqual(variants.map((body) => classifyOpeningForm(body).rhetoricalMove), [
      'MISCONCEPTION_CORRECTION', 'MISCONCEPTION_CORRECTION', 'MISCONCEPTION_CORRECTION',
    ]);
    assert.ok(variants.every((body) => classifyFinalPostFingerprint(body).hookType === 'MISCONCEPTION_CORRECTION_HOOK'));
  });

  it('groups broad category lead-ins while allowing a concrete category claim', () => {
    const generic = [
      'In the world of platform engineering, reliability is important.',
      'When discussing platform engineering, there are many factors to consider.',
      'For platform engineering teams, reliability matters more than ever.',
    ];
    assert.ok(generic.every((body) => classifyOpeningForm(body).genericCategorySetup));
    assert.equal(classifyOpeningForm('In platform engineering, scoped cache keys prevent tenant collisions.').genericCategorySetup, false);
  });

  it('recognizes mechanism-first and consequence-first openings as different syntax', () => {
    assert.equal(classifyOpeningForm('Because retries can duplicate side effects, handlers need idempotency keys.').syntax, 'MECHANISM_FIRST');
    assert.equal(classifyOpeningForm('The cost of unscoped retries is duplicate side effects.').syntax, 'CONSEQUENCE_FIRST');
  });

  it('recognizes an obvious question-answer formula', () => {
    assert.equal(classifyOpeningForm('Do retries guarantee delivery?\nYes, of course—until the handler duplicates a side effect.').obviousQuestionAnswer, true);
  });
});
