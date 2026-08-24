import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LINKEDIN_LINE_FORMAT_RULES,
  SPECIFICITY_RULES,
  VARIED_FORMAT_RULES,
  buildRepairPrompt,
  DEFAULT_EDITORIAL_RULES,
  GHOSTWRITER_SYSTEM,
} from './ghostwriterPrompts';
import { buildExpressionModePromptBlock } from './expressionModeService';
import type { AuthorContext, BatchPostPlan, ExpressionMode, GeneratedPostContent } from './generationTypes';

test('global production rules do not prescribe one six-stage essay progression', () => {
  const globalRules = `${LINKEDIN_LINE_FORMAT_RULES}\n${VARIED_FORMAT_RULES}`;
  assert.doesNotMatch(globalRules, /hook, problem, mechanism, example, action, takeaway/i);
  assert.doesNotMatch(globalRules, /Recommended progression/i);
  assert.doesNotMatch(globalRules, /Voice Plan|adaptive (?:character )?range/i);
  assert.match(globalRules, /Zero paragraphs, examples, lists, questions, conclusions, or CTAs are mandatory/);
  assert.match(DEFAULT_EDITORIAL_RULES, /End on the final substantive move/);
  assert.match(GHOSTWRITER_SYSTEM, /Depth-proportional completeness/);
  assert.match(GHOSTWRITER_SYSTEM, /Natural LinkedIn formatting/);
});

test('examples, consequences, and explicit endings are optional globally', () => {
  assert.match(SPECIFICITY_RULES, /optional reasoning dimensions, not mandatory sections of the final post/);
  assert.doesNotMatch(VARY_FORMAT_RULES_FOR_ASSERTION(), /Show one realistic scenario/);
  assert.doesNotMatch(LINKEDIN_LINE_FORMAT_RULES, /End with a useful takeaway/);
});

function VARY_FORMAT_RULES_FOR_ASSERTION(): string {
  return VARIED_FORMAT_RULES;
}

test('batch repair preserves the selected expression mode and unusual structure', () => {
  const author: AuthorContext = { description: 'Backend engineer', tone: 'Conversational', niches: ['SaaS'] };
  const plan: BatchPostPlan = {
    trendIndex: 0,
    sourceTopic: 'API pagination',
    angle: 'product_lesson',
    hookStyle: 'observation',
    endingStyle: 'takeaway',
    layout: 'short_observation',
    rationale: 'test',
    expressionMode: 'direct',
  };
  const post: GeneratedPostContent = { body: 'Pagination is part of the API contract.', headline: '', subheadline: '', bulletPoints: [], hashtags: '' };
  const prompt = buildRepairPrompt(post, ['clarify mechanism'], author, plan);
  assert.match(prompt, /EXPRESSION MODE: DIRECT/);
  assert.match(prompt, /Preserve the claim contract, verified facts, successful rhetorical movement/);
  assert.match(prompt, /Do not normalize the draft into an essay or add a scenario, list, action step, conclusion, question, or CTA/);
});

test('expression modes define distinct movement, optional moves, avoids, and stopping behavior', () => {
  const expected: Record<string, RegExp[]> = {
    direct: [/State the claim immediately/, /strongest support/, /then stop/],
    analytical: [/causal reasoning/, /implication or condition/, /do not automatically pivot/],
    diagnostic: [/concrete signal/, /relevant cause and response/, /each optional/],
    conversational: [/natural spoken progression/, /mixed cadence/, /naturally completes/],
    opinionated: [/position clear early/, /credible reasoning/, /forced balance/],
    walkthrough: [/actual sequence or process/, /intrinsic steps/, /last meaningful step/],
    reflective: [/precise observation/, /useful implication/, /CTAs are optional/],
  };
  for (const [mode, patterns] of Object.entries(expected)) {
    const block = buildExpressionModePromptBlock(mode as ExpressionMode, []);
    for (const pattern of patterns) assert.match(block, pattern);
    assert.match(block, /does not add mandatory sections/);
  }
});

test('voice diversity uses compact fingerprints and changes construction rather than synonyms', () => {
  const omitted = 'FULL_BODY_TAIL_SHOULD_BE_OMITTED';
  const block = buildExpressionModePromptBlock('direct', [`For instance, imagine a team. ${'Context '.repeat(20)}${omitted}`]);
  assert.match(block, /RECENT RHETORICAL FINGERPRINTS/);
  assert.match(block, /full post bodies omitted/);
  assert.match(block, /Change the thought ordering, not merely synonyms/);
  assert.doesNotMatch(block, new RegExp(omitted));
});
