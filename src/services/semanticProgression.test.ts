import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSemanticProgression } from './semanticProgression';
import { calculateManualGenericAiRisk } from './manualPost/manualGenericAiDetector';

describe('semantic paragraph progression', () => {
  it('flags paragraphs that restate the same automation-trust proposition', () => {
    const result = evaluateSemanticProgression(`Trust is essential for automation adoption.

Teams adopt automation when they trust the automation system.

Without trust in automation, adoption becomes difficult.

Trusted automation systems create stronger adoption and engagement.`);
    assert.equal(result.passed, false);
    assert.ok(result.repetitivePairs.length > 0);
  });

  it('accepts cause-and-effect progression with materially distinct propositions', () => {
    const result = evaluateSemanticProgression(`Trust is often the real blocker to automation.

Teams reveal that mistrust through duplicate checks and delayed approvals.

Those behaviors usually come from fear of losing control or unclear accountability.

That means the automation problem is organizational before it is technical.`);
    assert.equal(result.passed, true);
  });

  it('flags an ending that semantically restates the opening', () => {
    const result = evaluateSemanticProgression(`Trust is the biggest obstacle to successful automation.

Teams often keep manual approvals because accountability remains unclear.

Therefore, trust is the most important factor in successful automation.`);
    assert.equal(result.openingConclusionRestatement, true);
  });

  it('flags enumeration without interpretation for normal posts', () => {
    const content = `Automation projects struggle for several reasons.\n\n- Training\n- Trust\n- Reliability\n- Communication\n\nTherefore, organizations should improve their automation strategy.`;
    const result = evaluateSemanticProgression(content);
    assert.ok(result.codes.includes('ENUMERATION_WITHOUT_INTERPRETATION'));
    assert.ok(result.codes.includes('GENERIC_RECOMMENDATION_ENDING'));
  });

  it('flags consecutive essay-transition paragraphs as enumeration without interpretation', () => {
    const content = `Automation projects stall for several reasons.

Additionally, teams keep manual checks.

Moreover, approvals become slower.

Furthermore, the old workflow remains active.

Another factor is unclear ownership.`;
    const result = evaluateSemanticProgression(content);
    assert.ok(result.codes.includes('ENUMERATION_WITHOUT_INTERPRETATION'));
  });

  it('allows intentional enumeration for a listicle or walkthrough', () => {
    const content = `Use this deployment checklist.\n\n1. Validate configuration\n2. Run migrations\n3. Verify health checks\n4. Inspect rollback readiness`;
    const result = evaluateSemanticProgression(content, { allowEnumeration: true });
    assert.equal(result.codes.includes('ENUMERATION_WITHOUT_INTERPRETATION'), false);
  });

  it('flags a forced niche relevance paragraph', () => {
    const result = evaluateSemanticProgression(`Automation changes ownership boundaries.\n\nThis is particularly relevant in game development teams.\n\nApproval design determines whether the workflow is trusted.`);
    assert.ok(result.codes.includes('FORCED_NICHE_PARAGRAPH'));
  });

  it('maps semantic findings into the extended generic-AI risk signals', () => {
    const content = `Trust is the biggest obstacle to automation.

Additionally, teams keep duplicate checks.

Moreover, approvals slow down.

Furthermore, the old workflow stays active.

Therefore trust is the most important factor in automation.`;
    const risk = calculateManualGenericAiRisk(content);
    assert.ok(risk.detectedIssues.includes('ENUMERATION_WITHOUT_INTERPRETATION'));
    assert.ok(risk.detectedIssues.includes('THESIS_RESTATEMENT'));
    assert.ok(risk.detectedIssues.includes('EXCESSIVE_ESSAY_TRANSITIONS'));
  });
});
