import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../../prismaClient';
import { validateGenerateInput } from '../manualPostAiService';
import { selectManualPlan } from './manualPostPlanning';
import { buildManualPlanningPrompt, buildManualPostPromptV2 } from './manualPostPrompts';
import type { ManualPlanningResult } from './manualPostTypes';
import {
  classifyExperienceRelevance,
  enforcePersonalExperienceNumberBoundary,
  personalExperienceWasUsed,
  rankPersonalExperienceSuggestions,
  resolvePersonalExperience,
  validatePersonalExperienceInput,
  type PersonalExperienceRetrievalRecord,
} from './personalExperienceService';

const author = { description: 'Independent operations consultant', tone: 'Direct', niches: ['Operations'] };
const now = new Date('2026-08-24T12:00:00.000Z').getTime();

function record(overrides: Partial<PersonalExperienceRetrievalRecord> = {}): PersonalExperienceRetrievalRecord {
  return {
    id: 'exp-1',
    title: 'Webhook lead transfer',
    rawText: 'I automated lead transfer from email into a CRM using a webhook.',
    summary: 'Email CRM webhook automation',
    topics: ['email', 'crm', 'webhook', 'automation'],
    lessons: null,
    outcomes: null,
    source: 'USER_SUPPLIED',
    usageCount: 0,
    lastUsedAt: null,
    ...overrides,
  };
}

function plan(experienceRelevance: 'HIGH' | 'MEDIUM' | 'LOW'): ManualPlanningResult {
  return {
    angles: [{
      title: 'Automating lead transfer',
      coreClaim: 'A webhook can remove a manual handoff between email and a CRM.',
      audience: 'Operations teams',
      structure: 'claim then mechanism',
      evidenceMode: 'supplied_experience',
      experienceRelevance,
      specificity: 9,
      novelty: 8,
      audienceFit: 9,
      voiceFit: 8,
      evidenceAvailability: 9,
      hookCandidates: [],
      depthPlan: {
        centralClaim: 'A webhook can remove a manual handoff between email and a CRM.',
        whyThisClaimIsInteresting: null,
        strongestObservations: ['The transfer can be triggered when an email arrives.'],
        underlyingCauseOrMechanism: 'The webhook passes the record to the CRM.',
        deeperInterpretation: null,
        meaningfulConsequence: null,
        usefulTensionOrQualification: null,
        personalPerspective: { supported: true, insight: 'I learned this firsthand.' },
        endingInsight: null,
        avoidIdeas: [],
      },
    }],
  };
}

describe('manual personal-experience request semantics', () => {
  it('keeps generation without an experience unchanged', () => {
    const input = validateGenerateInput({ topic: 'CRM automation' });
    assert.equal(input.topic, 'CRM automation');
    assert.equal(input.personalExperience, undefined);
  });

  it('accepts a one-post experience without opting it into persistence', () => {
    assert.deepEqual(validatePersonalExperienceInput({ rawText: 'I connected email to our CRM.' }), {
      rawText: 'I connected email to our CRM.',
      save: false,
    });
  });

  it('retains an explicit save opt-in and never infers one', () => {
    assert.equal(validatePersonalExperienceInput({ rawText: 'I tested this.', save: true })?.save, true);
    assert.equal(validatePersonalExperienceInput({ rawText: 'I tested this.' })?.save, false);
  });

  it('persists new text only when the user explicitly opts in', async () => {
    const delegate = prisma.personalExperience as any;
    const originalFindFirst = delegate.findFirst;
    const originalCreate = delegate.create;
    let creates = 0;
    delegate.findFirst = async () => null;
    delegate.create = async ({ data }: { data: Record<string, unknown> }) => {
      creates += 1;
      return { id: 'saved-1', title: data.title, rawText: data.rawText };
    };
    try {
      const ephemeral = await resolvePersonalExperience('user-1', { rawText: 'I tested an ephemeral workflow.', save: false });
      assert.equal(ephemeral?.id, undefined);
      assert.equal(creates, 0);

      const saved = await resolvePersonalExperience('user-1', { rawText: 'I tested a saved workflow.', save: true });
      assert.equal(saved?.id, 'saved-1');
      assert.equal(creates, 1);
    } finally {
      delegate.findFirst = originalFindFirst;
      delegate.create = originalCreate;
    }
  });
});

describe('manual personal-experience retrieval', () => {
  it('returns only relevant saved suggestions and excludes an irrelevant story', () => {
    const suggestions = rankPersonalExperienceSuggestions([
      record(),
      record({ id: 'exp-2', title: 'Marathon training', rawText: 'I changed my running cadence during marathon training.', summary: null, topics: ['running'] }),
    ], 'email CRM webhook automation', 3, now);
    assert.deepEqual(suggestions.map((item) => item.id), ['exp-1']);
  });

  it('penalizes a repeatedly and recently used experience', () => {
    const suggestions = rankPersonalExperienceSuggestions([
      record({ id: 'overused', usageCount: 8, lastUsedAt: new Date(now - 86_400_000) }),
      record({ id: 'fresh', usageCount: 0, lastUsedAt: null }),
    ], 'email CRM webhook automation', 2, now);
    assert.deepEqual(suggestions.map((item) => item.id), ['fresh', 'overused']);
    assert.ok(suggestions[1].reusePenalty > suggestions[0].reusePenalty);
  });

  it('classifies unrelated evidence LOW and prevents it from authorizing a personal plan', () => {
    const experience = 'I changed my running cadence during marathon training.';
    assert.equal(classifyExperienceRelevance('CRM webhook automation', experience), 'LOW');
    const selected = selectManualPlan(plan('LOW'), 'CRM webhook automation', undefined, [], experience);
    assert.equal(selected.evidenceMode, 'reasoned_observation');
    assert.deepEqual(selected.depthPlan.personalPerspective, { supported: false, insight: null });
  });
});

describe('manual personal-experience factual boundary', () => {
  it('places experience separately from voice samples and labels it as factual evidence', () => {
    const prompt = buildManualPlanningPrompt({
      topic: 'CRM webhook automation',
      author,
      voiceContext: {
        explicitPreferences: { ...author, includeContactInfo: false, includeWebsiteLink: false, contactInfo: '', websiteUrl: '' },
        learnedVoiceProfile: null,
        selectedWritingSamples: [{ id: 'sample-1', content: 'A style-only sample.', topic: null, weight: 1, origin: 'fully_manual', published: false, createdAt: new Date() }],
      },
      personalExperience: { rawText: record().rawText, source: 'USER_SUPPLIED' },
    });
    assert.ok(prompt.includes('VOICE CONTEXT — AUTHORITATIVE'));
    assert.ok(prompt.includes('STYLE REFERENCES'));
    assert.ok(prompt.includes('PERSONAL EXPERIENCE — USER-SUPPLIED FACTUAL EVIDENCE (separate from VOICE CONTEXT)'));
    assert.ok(prompt.includes('Voice/style samples describe how to write and do not authorize their stories or facts'));
  });

  it('allows supplied first-person facts but strips unsupplied numerical outcomes', () => {
    const content = 'I replaced a manual email-to-CRM step with a webhook. It saved 30 hours a week and increased conversions by 40%.';
    const bounded = enforcePersonalExperienceNumberBoundary(content, record().rawText);
    assert.ok(bounded.includes('I replaced a manual email-to-CRM step with a webhook.'));
    assert.ok(!bounded.includes('30'));
    assert.ok(!bounded.includes('40%'));
  });

  it('counts usage only when relevant supplied evidence appears in first person', () => {
    assert.equal(personalExperienceWasUsed('I connected email to the CRM with a webhook.', record().rawText, 'HIGH'), true);
    assert.equal(personalExperienceWasUsed('A webhook can connect email to a CRM.', record().rawText, 'HIGH'), false);
    assert.equal(personalExperienceWasUsed('I changed my running cadence.', record().rawText, 'LOW'), false);
  });

  it('gives the writer an explicit no-inferred-biography rule', () => {
    const prompt = buildManualPostPromptV2({
      topic: 'CRM webhook automation', author,
      personalExperience: { rawText: record().rawText, source: 'USER_SUPPLIED' },
    });
    assert.ok(prompt.includes('Do not infer biography'));
    assert.ok(prompt.includes('Do not invent numbers, dates, clients, scale, outcomes'));
  });
});

describe('personal-experience architecture isolation', () => {
  it('does not expose the experience bank to batch generation', () => {
    const services = path.resolve(__dirname, '..');
    for (const file of ['ghostwriterPipeline.ts', 'ghostwriterGenerationService.ts', 'trendingBotService.ts']) {
      const source = fs.readFileSync(path.join(services, file), 'utf8');
      assert.ok(!source.includes('personalExperienceService'), `${file} imported the manual experience bank`);
      assert.ok(!source.includes('personalExperience.findMany'), `${file} queried the experience bank`);
    }
  });

  it('keeps the existing deterministic manual fallback in the generation pipeline', () => {
    const source = fs.readFileSync(path.join(__dirname, 'manualPostMultiStage.ts'), 'utf8');
    assert.ok(source.includes('createFallbackManualPlan'));
    assert.ok(source.includes('buildEmergencyWriterPrompt'));
    assert.ok(source.includes("initialCandidateSource = 'emergency'"));
    assert.ok(source.includes('selectBestUsableManualCandidate'));
  });
});
