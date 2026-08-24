import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AuthorContext, BatchPostPlan, TrendCandidate } from './generationTypes';
import { buildAssembledBatchWriterPrompt, buildAssembledTechnicalReviewPrompt } from './ghostwriterPrompts';

type Fixture = { name: string; author: AuthorContext; trend: TrendCandidate; plan: BatchPostPlan; body: string };

function fixture(name: string, description: string, niche: string, audience: string, claim: string, body: string): Fixture {
  const trend: TrendCandidate = { topic: claim, summary: body, keyPoints: [claim] };
  const plan: BatchPostPlan = {
    trendIndex: 0, sourceTopic: claim, angle: 'product_lesson', hookStyle: 'observation', endingStyle: 'natural',
    layout: 'short_observation', rationale: 'Explain one useful distinction.', expressionMode: 'analytical',
    centralClaim: claim, selectedCentralClaim: claim, claimSource: 'STRATEGY_SELECTED',
    editorialDecision: {
      contentObjective: 'TEACH', conversionObjective: 'NONE', hookFamily: 'OBSERVATION',
      rhetoricalStructure: 'OBSERVATION_MECHANISM_CONSEQUENCE', endingIntent: 'INSIGHT',
      referenceValueForm: 'MEMORABLE_DISTINCTION', personalEvidenceAvailable: false, rationale: ['idea needs explanation'],
    },
  };
  return { name, author: { description, tone: 'clear', niches: [niche], targetAudience: [audience] }, trend, plan, body };
}

const FIXTURES = [
  fixture('clinical', 'A clinician who writes about communication after appointments.', 'patient communication', 'independent clinicians', 'A reminder cannot repair retention when uncertainty begins after the appointment.', 'A reminder and an explanation solve different patient communication problems.'),
  fixture('recruiting', 'A recruiter who helps hiring teams make clearer decisions.', 'recruiting operations', 'hiring leaders', 'Interview consistency improves when evidence standards are defined before the conversation.', 'A scorecard is useful when it defines evidence before interview confidence can shape the decision.'),
  fixture('real-estate', 'A property adviser who explains transaction decisions to first-time buyers.', 'residential real estate', 'first-time buyers', 'A longer property checklist is less useful than clear ownership of unresolved inspection items.', 'Inspection detail creates value only when unresolved items have a clear owner and decision date.'),
];

function snapshot(prompt: string) {
  const lines = prompt.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return {
    hierarchy: lines.filter((line) => /^\d\. /.test(line)).slice(0, 7),
    sections: lines.filter((line) => /^(CLAIM CONTRACT|AUDIENCE AND OBJECTIVE|ASSIGNED EDITORIAL FORM|SOURCE EVIDENCE|CANDIDATE-RELEVANT SAFETY DISTINCTIONS|DEPTH-PROPORTIONAL COMPLETENESS|EXPRESSION MODE|NATURAL LINKEDIN FORMATTING|REVIEW HIERARCHY|SEMANTIC REVIEW)/.test(line)),
    objective: lines.find((line) => line.startsWith('- Content objective:')),
    conversion: lines.find((line) => line.startsWith('- Conversion objective:')),
  };
}

describe('assembled batch prompt snapshots', () => {
  it('keeps the same hierarchy for radically different niches without global software bias', () => {
    const snapshots = FIXTURES.map((item) => snapshot(buildAssembledBatchWriterPrompt(item.plan, item.author, '', item.trend)));
    for (const item of snapshots) {
      assert.deepEqual(item.hierarchy, [
        '1. Factual and authority safety.', '2. Fidelity to the selected claim.',
        '3. Audience relevance and content objective.', '4. Assigned editorial form.', '5. Supplied evidence.',
        '6. Depth-proportional completeness.', '7. Natural LinkedIn formatting.',
      ]);
      assert.equal(item.objective, '- Content objective: teach');
      assert.match(item.conversion ?? '', /NONE means no CTA/);
      assert.deepEqual(item.sections.filter((line) => line.startsWith('CLAIM CONTRACT')), ['CLAIM CONTRACT — SELECTED CENTRAL CLAIM — PRESERVE THIS MEANING:']);
    }
    const unrelated = FIXTURES.flatMap((item) => [
      buildAssembledBatchWriterPrompt(item.plan, item.author, '', item.trend),
      buildAssembledTechnicalReviewPrompt({ body: item.body }, item.author, item.plan),
    ]).join('\n');
    assert.doesNotMatch(unrelated, /\b(?:SaaS|backend|Unity|marketing funnel|tenant isolation|server-side entitlement|idempotenc|database isolation)\b/i);
  });

  it('contains one clear claim contract and no universal long-form minimum', () => {
    for (const item of FIXTURES) {
      const writer = buildAssembledBatchWriterPrompt(item.plan, item.author, '', item.trend);
      assert.equal((writer.match(/CLAIM CONTRACT/g) ?? []).length, 1);
      assert.doesNotMatch(writer, /\b1[,.]?600\b|\b1[,.]?800\b/);
      assert.match(writer, /A compact post is explicitly valid/);
    }
  });

  it('keeps authority and personal-evidence rules consistent', () => {
    for (const item of FIXTURES) {
      const writer = buildAssembledBatchWriterPrompt(item.plan, item.author, '', item.trend);
      const reviewer = buildAssembledTechnicalReviewPrompt({ body: item.body }, item.author, item.plan);
      assert.match(writer, /First-person experiential claims require explicit supplied evidence/);
      assert.match(writer, /Personal evidence: unavailable/);
      assert.match(reviewer, /Do not infer biography, experience, results, or authority beyond supplied author facts/);
      assert.doesNotMatch(`${writer}\n${reviewer}`, /written by an experienced practitioner/i);
    }
  });

  it('presents planner depth fields as optional reasoning rather than prose sections', () => {
    const writer = buildAssembledBatchWriterPrompt(FIXTURES[1].plan, FIXTURES[1].author, '', FIXTURES[1].trend);
    const reviewer = buildAssembledTechnicalReviewPrompt({ body: FIXTURES[1].body }, FIXTURES[1].author, FIXTURES[1].plan);
    for (const prompt of [writer, reviewer]) {
      assert.match(prompt, /Mechanism, consequence, qualification, trade-off and failure mode are optional reasoning dimensions, not mandatory sections of the final post/i);
    }
  });

  it('does not require a CTA, question, conclusion, list, or long treatment', () => {
    const prompt = buildAssembledBatchWriterPrompt(FIXTURES[0].plan, FIXTURES[0].author, '', FIXTURES[0].trend);
    assert.match(prompt, /NONE means no CTA/);
    assert.match(prompt, /Zero paragraphs, examples, lists, questions, conclusions, or CTAs are mandatory/);
    assert.doesNotMatch(prompt, /end with (?:a )?(?:question|CTA)|must include (?:a )?(?:list|conclusion)/i);
  });

  it('keeps safety niche-relevant instead of global', () => {
    const clinical = buildAssembledBatchWriterPrompt(FIXTURES[0].plan, FIXTURES[0].author, '', FIXTURES[0].trend);
    assert.match(clinical, /Do not convert general health information into a diagnosis/);
    assert.doesNotMatch(clinical, /Authentication establishes identity/);
    const software = fixture('software', 'A security educator.', 'application security', 'engineering teams', 'Authentication does not replace authorization at an access boundary.', 'Authentication establishes identity, while authorization governs the requested action.');
    const softwarePrompt = buildAssembledBatchWriterPrompt(software.plan, software.author, '', software.trend);
    assert.match(softwarePrompt, /Authentication establishes identity; authorization determines permitted actions/);
  });

  it('reduces representative assembled prompt size from the recorded baseline', () => {
    const item = FIXTURES[0];
    const writer = buildAssembledBatchWriterPrompt(item.plan, item.author, '', item.trend);
    const reviewer = buildAssembledTechnicalReviewPrompt({ body: item.body }, item.author, item.plan);
    console.log('[prompt-audit-after]', JSON.stringify({ writerChars: writer.length, reviewerChars: reviewer.length }));
    assert.ok(writer.length < 17_360);
    assert.ok(reviewer.length < 6_735);
  });
});
