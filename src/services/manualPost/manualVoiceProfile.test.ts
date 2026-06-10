import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import {
  buildManualPlanningPrompt,
  buildManualRewritePromptV2,
} from './manualPostPrompts';
import { buildManualVoiceContextBlocks, STYLE_REFERENCE_INSTRUCTIONS } from './manualVoicePromptBlocks';
import {
  classifyVoiceSampleOrigin,
  isBatchPostSource,
  isEligibleVoiceSample,
  isUneditedAiOutput,
  type VoiceSamplePost,
} from './manualVoiceSampleEligibility';
import { calculateManualVoiceSampleWeight } from './manualVoiceSampleWeight';
import { topicKeywordOverlap } from './manualVoiceKeywordUtils';
import { mergeManualVoiceSignals } from './manualVoiceProfileService';
import type { ManualVoiceContext } from './manualVoiceProfileService';

const ROOT = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function samplePost(overrides: Partial<VoiceSamplePost> = {}): VoiceSamplePost {
  const now = new Date('2026-06-01T12:00:00.000Z');
  return {
    id: 'post-1',
    userId: 'user-1',
    source: 'MANUAL',
    status: 'PUBLISHED',
    content: 'Server-side tenant authorization checks matter for every SaaS product shipping multi-tenant features today.',
    hashtags: '#SaaS',
    manualTopic: 'Tenant authorization',
    aiGenerated: false,
    rewriteCount: 0,
    publishedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function voiceContextFixture(): ManualVoiceContext {
  return {
    explicitPreferences: {
      tone: 'Professional',
      description: 'Backend engineer writing about SaaS architecture',
      niches: ['SaaS'],
      customLinks: null,
      contactInfo: null,
      websiteUrl: null,
      includeContactInfo: false,
      includeWebsiteLink: false,
    },
    learnedVoiceProfile: {
      profile: {
        sentenceRhythm: 'short declarative openings',
        hookStyle: 'contrarian observation',
      },
      preferredPhrases: ['request invariant'],
      avoidedPhrases: ['in today\'s digital age'],
      approvedPatterns: ['mechanism-first explanation'],
      rejectedPatterns: ['forced engagement question'],
      analyzedSampleCount: 4,
      version: 2,
      confidence: 0.72,
      lastAnalyzedAt: new Date('2026-05-20T00:00:00.000Z'),
    },
    selectedWritingSamples: [
      {
        id: 'sample-1',
        content: 'Treat tenant scope as a request invariant, not a UI convenience.',
        topic: 'Tenant authorization',
        weight: 90,
        origin: 'published_manual',
        published: true,
        createdAt: new Date('2026-05-15T00:00:00.000Z'),
      },
    ],
  };
}

describe('manual voice sample eligibility', () => {
  it('includes fully manual posts as eligible samples', () => {
    const post = samplePost({ aiGenerated: false });
    assert.equal(isEligibleVoiceSample(post), true);
    assert.equal(classifyVoiceSampleOrigin(post), 'published_manual');
  });

  it('excludes batch posts', () => {
    const batch = samplePost({ source: 'AI' });
    assert.equal(isBatchPostSource(batch.source), true);
    assert.equal(isEligibleVoiceSample(batch), false);

    const trend = samplePost({ source: 'AI_TRENDING' });
    assert.equal(isEligibleVoiceSample(trend), false);
  });

  it('excludes unedited initial AI output', () => {
    const created = new Date('2026-06-01T12:00:00.000Z');
    const unedited = samplePost({
      aiGenerated: true,
      rewriteCount: 0,
      status: 'DRAFT',
      publishedAt: null,
      createdAt: created,
      updatedAt: new Date(created.getTime() + 60_000),
    });
    assert.equal(isUneditedAiOutput(unedited), true);
    assert.equal(isEligibleVoiceSample(unedited), false);
  });

  it('includes final heavily edited published AI-assisted content', () => {
    const created = new Date('2026-06-01T12:00:00.000Z');
    const edited = samplePost({
      aiGenerated: true,
      rewriteCount: 0,
      status: 'PUBLISHED',
      publishedAt: new Date('2026-06-01T13:30:00.000Z'),
      createdAt: created,
      updatedAt: new Date(created.getTime() + 45 * 60_000),
      content: 'After editing in the composer, this published post reflects the author voice with enough detail to qualify as a sample.',
    });
    assert.equal(isEligibleVoiceSample(edited), true);
    assert.equal(classifyVoiceSampleOrigin(edited), 'published_manual');
  });
});

describe('manual voice sample weighting', () => {
  it('ranks fully manual published posts above edited drafts', () => {
    const publishedManual = calculateManualVoiceSampleWeight(samplePost({ aiGenerated: false }), 'Tenant authorization');
    const editedDraft = calculateManualVoiceSampleWeight(samplePost({
      aiGenerated: true,
      status: 'DRAFT',
      publishedAt: null,
      createdAt: new Date('2026-06-01T10:00:00.000Z'),
      updatedAt: new Date('2026-06-01T11:00:00.000Z'),
    }), 'Tenant authorization');
    assert.ok(publishedManual > editedDraft);
  });

  it('uses topic keyword overlap for ranking', () => {
    const overlap = topicKeywordOverlap(
      'Tenant authorization in SaaS',
      'Tenant authorization',
      'Server-side tenant authorization checks matter for SaaS products.',
    );
    assert.ok(overlap > 0);
  });
});

describe('manual voice prompt integration', () => {
  it('includes AUTHOR IDENTITY, EXPLICIT PREFERENCES, LEARNED VOICE, and STYLE REFERENCES', () => {
    const blocks = buildManualVoiceContextBlocks(voiceContextFixture());
    assert.ok(blocks.includes('AUTHOR IDENTITY'));
    assert.ok(blocks.includes('EXPLICIT PREFERENCES'));
    assert.ok(blocks.includes('LEARNED VOICE'));
    assert.ok(blocks.includes('STYLE REFERENCES'));
    assert.ok(blocks.includes(STYLE_REFERENCE_INSTRUCTIONS));
    assert.ok(blocks.includes('Do not reuse exact phrases'));
  });

  it('adds voice context to manual planning prompts', () => {
    const prompt = buildManualPlanningPrompt({
      topic: 'Tenant authorization',
      author: { description: 'Engineer', tone: 'Professional', niches: ['SaaS'] },
      voiceContext: voiceContextFixture(),
    });
    assert.ok(prompt.includes('LEARNED VOICE'));
    assert.ok(prompt.includes('STYLE REFERENCES'));
  });

  it('adds voice context to manual rewrite prompts', () => {
    const prompt = buildManualRewritePromptV2({
      currentContent: 'Original post body with enough detail to rewrite safely.',
      suggestions: 'Make it sound more like me',
      author: { description: 'Engineer', tone: 'Professional', niches: [] },
      voiceContext: voiceContextFixture(),
    });
    assert.ok(prompt.includes('AUTHOR IDENTITY'));
    assert.ok(prompt.includes('STYLE REFERENCES'));
  });

  it('degrades gracefully when profile and samples are absent', () => {
    const blocks = buildManualVoiceContextBlocks({
      explicitPreferences: voiceContextFixture().explicitPreferences,
      learnedVoiceProfile: null,
      selectedWritingSamples: [],
    });
    assert.ok(blocks.includes('No learned profile available yet'));
    assert.ok(blocks.includes('No eligible writing samples available yet'));
  });
});

describe('manual voice signal merge', () => {
  it('keeps explicit BotConfig preferences authoritative', () => {
    const merged = mergeManualVoiceSignals({
      explicitPreferences: voiceContextFixture().explicitPreferences,
      learnedVoiceProfile: voiceContextFixture().learnedVoiceProfile,
    });
    assert.equal(merged.tone, 'Professional');
    assert.ok(merged.learnedProfile);
    assert.ok(Array.isArray(merged.preferredPhrases));
  });
});

describe('manual voice data scoping', () => {
  it('collectManualVoiceSamples queries only the authenticated user posts', () => {
    const service = readSrc('services/manualPost/manualVoiceProfileService.ts');
    const collectBody = service.slice(
      service.indexOf('export async function collectManualVoiceSamples'),
      service.indexOf('export async function getManualVoiceProfile'),
    );
    assert.ok(collectBody.includes('userId'));
    assert.ok(collectBody.includes("source: 'MANUAL'"));
  });

  it('profile absence returns explicit preferences without throwing', async () => {
    const blocks = buildManualVoiceContextBlocks({
      explicitPreferences: voiceContextFixture().explicitPreferences,
      learnedVoiceProfile: null,
      selectedWritingSamples: [],
    });
    assert.ok(blocks.includes('AUTHOR IDENTITY'));
    assert.ok(blocks.includes('No learned profile available yet'));
  });
});

describe('batch isolation for voice profiles', () => {
  it('batch generation services do not import manual voice profile service', () => {
    const batchGen = readSrc('services/ghostwriterGenerationService.ts');
    const pipeline = readSrc('services/ghostwriterPipeline.ts');
    const trending = readSrc('services/trendingBotService.ts');
    assert.ok(!batchGen.includes('manualVoiceProfile'));
    assert.ok(!pipeline.includes('manualVoiceProfile'));
    assert.ok(!trending.includes('UserVoiceProfile'));
  });

  it('batch prompts do not include manual voice sections', () => {
    const prompts = readSrc('services/ghostwriterPrompts.ts');
    assert.ok(!prompts.includes('LEARNED VOICE'));
    assert.ok(!prompts.includes('STYLE REFERENCES'));
    assert.ok(!prompts.includes('manualVoiceProfile'));
  });

  it('manual orchestration loads voice context only on manual paths', () => {
    const orchestration = readSrc('services/manualPost/manualPostOrchestration.ts');
    assert.ok(orchestration.includes('getManualVoiceContext'));
    assert.ok(orchestration.includes('voiceContext'));
  });
});
