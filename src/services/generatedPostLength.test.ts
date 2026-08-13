import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLengthRepairInstruction,
  evaluateGeneratedPostLength,
  isExplicitShorteningInstruction,
  MAX_LENGTH_REPAIR_ATTEMPTS,
} from './generatedPostLength';
import { prepareLinkedInCommentary } from './linkedinPublishingText';

describe('generated post length policy', () => {
  it('classifies short, acceptable, preferred, and long content centrally', () => {
    assert.equal(evaluateGeneratedPostLength('x'.repeat(1050)), 'TOO_SHORT');
    assert.equal(evaluateGeneratedPostLength('x'.repeat(1600)), 'ACCEPTABLE');
    assert.equal(evaluateGeneratedPostLength('x'.repeat(2150)), 'PREFERRED');
    assert.equal(evaluateGeneratedPostLength('x'.repeat(2501)), 'ACCEPTABLE');
    assert.equal(evaluateGeneratedPostLength('x'.repeat(3350)), 'TOO_LONG');
  });

  it('provides substantive bounded expansion and compression instructions', () => {
    assert.match(buildLengthRepairInstruction('TOO_SHORT'), /1,800–2,300/);
    assert.match(buildLengthRepairInstruction('TOO_SHORT'), /Do not restate the thesis/);
    assert.match(buildLengthRepairInstruction('TOO_SHORT'), /approved Depth Plan/);
    assert.match(buildLengthRepairInstruction('TOO_LONG'), /below 3,000/);
    assert.equal(MAX_LENGTH_REPAIR_ATTEMPTS, 2);
  });

  it('recognizes explicit shortening rewrites', () => {
    assert.equal(isExplicitShorteningInstruction('make this shorter'), true);
    assert.equal(isExplicitShorteningInstruction('Please make it more concise'), true);
    assert.equal(isExplicitShorteningInstruction('Improve the argument and examples'), false);
  });

  it('keeps manually authored short posts publishable', () => {
    const manual = 'Great launch today 🚀';
    assert.equal(prepareLinkedInCommentary(manual), manual);
  });

  it('evaluates visible content independently of transport escaping', () => {
    const visible = `A${'(MVP)'.repeat(400)}`;
    assert.equal(evaluateGeneratedPostLength(visible), 'PREFERRED');
    assert.ok(prepareLinkedInCommentary(visible).length > visible.length);
  });
});
