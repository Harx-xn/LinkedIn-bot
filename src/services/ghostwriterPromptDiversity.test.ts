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
  assert.match(globalRules, /Not every post needs a problem statement, example/);
  assert.match(DEFAULT_EDITORIAL_RULES, /End by sharpening, reframing, resolving, exposing a tension, or stopping/);
  assert.match(GHOSTWRITER_SYSTEM, /single most natural credible form/);
  assert.match(GHOSTWRITER_SYSTEM, /do not include all of these forms/);
});

test('examples, consequences, and explicit endings are optional globally', () => {
  assert.match(SPECIFICITY_RULES, /Do not add a failure scenario, consequence, action step, example, trade-off, or implementation boundary unless the idea genuinely needs it/);
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
  assert.match(prompt, /preserving its successful rhetorical shape/);
  assert.match(prompt, /Do not add a scenario, action steps, takeaway, CTA, question, or closing section/);
});

test('expression modes define distinct movement, optional moves, avoids, and stopping behavior', () => {
  const expected: Record<string, RegExp[]> = {
    direct: [/CLAIM -> SUPPORT -> STOP/, /scenarios, recommendation sections/, /completed the argument and satisfied the generation contract/],
    analytical: [/CAUSAL REASONING/, /automatic pivot from analysis into advice/, /causal relationship and its implication/],
    diagnostic: [/symptom -> trace -> cause -> fix or decision/, /educational setup/, /cause and appropriate response/],
    conversational: [/observation -> free-form discussion/, /announced hypothetical stories/, /real person would naturally stop/],
    opinionated: [/POSITION -> REASONS -> OPTIONAL QUALIFICATION/, /forced balance/, /position has been sufficiently defended/],
    walkthrough: [/GOAL -> SEQUENCE OR PROCESS/, /lesson after the final step/, /last meaningful step may be the final line/],
    reflective: [/OBSERVATION -> IMPLICATION/, /Do not force recommendations, action steps, lessons/, /end on the implication or observation/],
  };
  for (const [mode, patterns] of Object.entries(expected)) {
    const block = buildExpressionModePromptBlock(mode as ExpressionMode, []);
    for (const pattern of patterns) assert.match(block, pattern);
    assert.match(block, /A complete post may use only 2 or 3 rhetorical moves/);
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
