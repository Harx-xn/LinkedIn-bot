import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAnalyticsInsightResponse } from './linkedinContentAnalyticsService';

test('parses fenced analytics insight JSON without requiring a post schema', () => {
  const result = parseAnalyticsInsightResponse(`Here is the analysis:\n\`\`\`json\n${JSON.stringify({ insights: [{
    type: 'AUDIENCE', importance: 'HIGH', title: 'Audience mismatch',
    finding: 'Entry-level viewers dominate.', recommendation: 'Test decision-maker topics.',
    evidence: [{ metric: 'entry_level_share', value: 42 }], confidence: 0.8, nextMove: 'TEST',
  }] })}\n\`\`\``);
  assert.equal(result.length, 1);
  assert.equal(result[0].type, 'AUDIENCE');
  assert.equal(result[0].nextMove, 'TEST');
});

test('rejects analytics insights without supplied evidence', () => {
  assert.throws(() => parseAnalyticsInsightResponse(JSON.stringify({ insights: [{
    type: 'TOPIC', importance: 'HIGH', title: 'Claim', finding: 'Claim', recommendation: 'Do it', evidence: [],
  }] })), /no usable evidence-backed insights/i);
});
