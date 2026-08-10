import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExpressionModePromptBlock, getExpressionModeFallbackStructure, selectBatchExpressionMode, selectManualExpressionMode } from './expressionModeService';
import type { PostAngle } from './generationTypes';

test('seven batch posts receive concrete non-adjacent expression modes', () => {
  const angles: PostAngle[] = ['technical_mistake', 'practical_tutorial', 'architecture_tradeoff', 'defensible_opinion', 'debugging_story', 'product_lesson', 'reflection'];
  const modes = angles.map((angle, index) => selectBatchExpressionMode(index, angle));
  assert.equal(modes.length, 7);
  assert.ok(new Set(modes).size >= 5);
  modes.slice(1).forEach((mode, index) => assert.notEqual(mode, modes[index]));
});

test('manual mode follows the topic while avoiding an obvious recent mode', () => {
  assert.equal(selectManualExpressionMode('Debug a broken queue worker', '', undefined, []), 'diagnostic');
  assert.equal(selectManualExpressionMode('How to configure API pagination', '', undefined, []), 'walkthrough');
  const mode = selectManualExpressionMode('API tradeoffs', '', undefined, ['However, this causes latency. Therefore, the contract matters.']);
  assert.notEqual(mode, 'analytical');
});

test('generation block contains direct recent posts and prompt-level anti-repetition rules', () => {
  const block = buildExpressionModePromptBlock('direct', ["It's crucial to inspect the API. Ultimately, verify the contract."], undefined);
  assert.match(block, /EXPRESSION MODE: DIRECT/);
  assert.match(block, /RECENT POST 1/);
  assert.match(block, /It's crucial to inspect the API/);
  assert.match(block, /Do not solve repetition by substituting synonyms/);
  assert.match(block, /Let idea complexity and the saved short\/medium\/long preference determine length/);
});

test('expression modes provide distinct rhetorical structures and ending behavior', () => {
  const modes = ['direct', 'analytical', 'diagnostic', 'conversational', 'opinionated', 'walkthrough', 'reflective'] as const;
  const structures = modes.map((mode) => getExpressionModeFallbackStructure(mode));
  assert.equal(new Set(structures).size, modes.length);
  assert.match(buildExpressionModePromptBlock('direct', []), /one narrow claim -> its strongest concrete support/);
  assert.match(buildExpressionModePromptBlock('diagnostic', []), /symptom -> trace -> cause -> fix or decision/);
  assert.match(buildExpressionModePromptBlock('conversational', []), /free-form discussion/);
  assert.match(buildExpressionModePromptBlock('reflective', []), /Do not force recommendations/);
});
