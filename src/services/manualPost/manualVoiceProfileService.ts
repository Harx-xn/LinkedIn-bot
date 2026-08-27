import { Prisma } from '@prisma/client';
import { prisma } from '../../prismaClient';
import type { ContentService } from '../contentService';
import { createGenerationId, getAiCostContext, withAiCostContext } from '../costIntelligence/aiCostTrackingService';
import { getBotVoice, type BotVoice } from '../userContentContext';
import { getContentServiceForUser } from '../userContentContext';
import {
  classifyVoiceSampleOrigin,
  hasSubstantialUserEditing,
  isEligibleVoiceSample,
  type VoiceSampleOrigin,
  type VoiceSamplePost,
} from './manualVoiceSampleEligibility';
import { topicKeywordOverlap } from './manualVoiceKeywordUtils';
import { calculateManualVoiceSampleWeight } from './manualVoiceSampleWeight';

export const VOICE_PROFILE_STALE_MS = 30 * 24 * 60 * 60 * 1000;
export const MIN_NEW_SAMPLES_FOR_REFRESH = 3;
export const MIN_NEW_REVISIONS_FOR_REFRESH = 3;
export const SAMPLE_RETRIEVAL_MIN = 2;
export const SAMPLE_RETRIEVAL_MAX = 4;
export const PROFILE_ANALYSIS_SAMPLE_LIMIT = 20;

export type LearnedVoiceProfile = {
  profile: Record<string, unknown>;
  preferredPhrases: string[];
  avoidedPhrases: string[];
  approvedPatterns: string[];
  rejectedPatterns: string[];
  analyzedSampleCount: number;
  version: number;
  confidence: number;
  lastAnalyzedAt: Date | null;
};

export type ManualWritingSample = {
  id: string;
  content: string;
  topic: string | null;
  weight: number;
  origin: VoiceSampleOrigin;
  published: boolean;
  createdAt: Date;
};

export type ManualVoiceContext = {
  explicitPreferences: BotVoice;
  learnedVoiceProfile: LearnedVoiceProfile | null;
  selectedWritingSamples: ManualWritingSample[];
};

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String).map((item) => item.trim()).filter(Boolean);
}

function asProfileObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export { topicKeywordOverlap } from './manualVoiceKeywordUtils';
export { calculateManualVoiceSampleWeight } from './manualVoiceSampleWeight';

export function mergeManualVoiceSignals(input: {
  explicitPreferences: BotVoice;
  learnedVoiceProfile: LearnedVoiceProfile | null;
}): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    tone: input.explicitPreferences.tone,
    description: input.explicitPreferences.description,
    niches: input.explicitPreferences.niches,
    includeContactInfo: input.explicitPreferences.includeContactInfo,
    includeWebsiteLink: input.explicitPreferences.includeWebsiteLink,
  };

  if (input.learnedVoiceProfile) {
    merged.learnedProfile = input.learnedVoiceProfile.profile;
    merged.preferredPhrases = input.learnedVoiceProfile.preferredPhrases;
    merged.avoidedPhrases = input.learnedVoiceProfile.avoidedPhrases;
    merged.approvedPatterns = input.learnedVoiceProfile.approvedPatterns;
    merged.rejectedPatterns = input.learnedVoiceProfile.rejectedPatterns;
    merged.profileConfidence = input.learnedVoiceProfile.confidence;
  }

  return merged;
}

/** Voice profile for manual posts comes from the user's BotConfig description. */
export function buildVoiceProfileFromBotConfig(voice: BotVoice): LearnedVoiceProfile | null {
  const description = voice.description.trim();
  if (!description) return null;

  return {
    profile: {
      source: 'botConfig',
      authorDescription: description,
      tone: voice.tone,
      niches: voice.niches,
      websiteUrl: voice.websiteUrl,
    },
    preferredPhrases: [],
    avoidedPhrases: [],
    approvedPatterns: [],
    rejectedPatterns: [],
    analyzedSampleCount: 0,
    version: 1,
    confidence: 1,
    lastAnalyzedAt: null,
  };
}

export function buildManualVoiceAnalysisPrompt(samples: ManualWritingSample[], explicitPreferences: BotVoice): string {
  const sampleBlock = samples
    .slice(0, PROFILE_ANALYSIS_SAMPLE_LIMIT)
    .map((sample, index) => `Sample ${index + 1} (${sample.origin}):\n${sample.content.trim()}`)
    .join('\n\n---\n\n');

  return `Analyze these manual LinkedIn writing samples for one author.
Infer sentence rhythm, paragraph length, directness, vocabulary, hook style, explanation style, and closing style.
Do not copy exact phrases. Extract reusable stylistic signals only.

Explicit author preferences (must not be overridden):
- Tone: ${explicitPreferences.tone}
- Description: ${explicitPreferences.description}
- Niches: ${explicitPreferences.niches.join(', ') || 'none'}

Writing samples:
${sampleBlock || 'No samples available.'}

Return JSON only:
{
  "profile": {
    "sentenceRhythm": "string",
    "paragraphLength": "string",
    "directness": "string",
    "vocabulary": "string",
    "hookStyle": "string",
    "explanationStyle": "string",
    "closingStyle": "string"
  },
  "preferredPhrases": ["short reusable phrase patterns"],
  "avoidedPhrases": ["generic AI phrases this author avoids"],
  "approvedPatterns": ["structural patterns that fit this author"],
  "rejectedPatterns": ["patterns that do not fit this author"],
  "confidence": 0.0
}`;
}

function toWritingSample(post: VoiceSamplePost, topic?: string): ManualWritingSample | null {
  const origin = classifyVoiceSampleOrigin(post);
  if (!origin) return null;

  return {
    id: post.id,
    content: post.content.trim(),
    topic: post.manualTopic ?? null,
    weight: calculateManualVoiceSampleWeight(post, topic),
    origin,
    published: post.status === 'PUBLISHED',
    createdAt: post.createdAt,
  };
}

export async function collectManualVoiceSamples(
  userId: string,
  limit = PROFILE_ANALYSIS_SAMPLE_LIMIT,
): Promise<ManualWritingSample[]> {
  const posts = await prisma.post.findMany({
    where: {
      userId,
      source: 'MANUAL',
    },
    orderBy: [{ publishedAt: 'desc' }, { updatedAt: 'desc' }],
    take: Math.max(limit * 4, 40),
    select: {
      id: true,
      userId: true,
      source: true,
      status: true,
      content: true,
      hashtags: true,
      manualTopic: true,
      aiGenerated: true,
      rewriteCount: true,
      publishedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return posts
    .filter((post) => isEligibleVoiceSample(post))
    .map((post) => toWritingSample(post))
    .filter((sample): sample is ManualWritingSample => !!sample)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);
}

export async function getManualVoiceProfile(userId: string): Promise<LearnedVoiceProfile | null> {
  const voice = await getBotVoice(userId);
  return buildVoiceProfileFromBotConfig(voice);
}

function parseVoiceAnalysisOutput(raw: string): {
  profile: Record<string, unknown>;
  preferredPhrases: string[];
  avoidedPhrases: string[];
  approvedPatterns: string[];
  rejectedPatterns: string[];
  confidence: number;
} | null {
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    return {
      profile: asProfileObject(parsed.profile),
      preferredPhrases: asStringArray(parsed.preferredPhrases),
      avoidedPhrases: asStringArray(parsed.avoidedPhrases),
      approvedPatterns: asStringArray(parsed.approvedPatterns),
      rejectedPatterns: asStringArray(parsed.rejectedPatterns),
      confidence: typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0.5,
    };
  } catch {
    return null;
  }
}

export async function refreshManualVoiceProfile(
  userId: string,
  contentService?: ContentService,
): Promise<LearnedVoiceProfile | null> {
  const explicitPreferences = await getBotVoice(userId);
  const samples = await collectManualVoiceSamples(userId, PROFILE_ANALYSIS_SAMPLE_LIMIT);
  if (samples.length === 0) return null;

  const service = contentService ?? await getContentServiceForUser(userId);
  const prompt = buildManualVoiceAnalysisPrompt(samples, explicitPreferences);
  const raw = await withAiCostContext({
    userId, feature: 'CONTENT_INTELLIGENCE', operation: 'VOICE_PROFILE_ANALYZE', agent: 'STRATEGY_ANALYZER',
    generationId: getAiCostContext().generationId || createGenerationId(),
  }, () => service.fetchComposerRewriteRaw(prompt, 'OPENAI'));
  const parsed = parseVoiceAnalysisOutput(raw);
  if (!parsed) {
    console.warn('[manual-voice] profile analysis parse failed', { userId });
    return null;
  }

  const existing = await prisma.userVoiceProfile.findUnique({ where: { userId } });
  const profileJson = parsed.profile as Prisma.InputJsonValue;
  const preferredJson = parsed.preferredPhrases as Prisma.InputJsonValue;
  const avoidedJson = parsed.avoidedPhrases as Prisma.InputJsonValue;
  const approvedJson = parsed.approvedPatterns as Prisma.InputJsonValue;
  const rejectedJson = parsed.rejectedPatterns as Prisma.InputJsonValue;

  const saved = await prisma.userVoiceProfile.upsert({
    where: { userId },
    create: {
      userId,
      profile: profileJson,
      preferredPhrases: preferredJson,
      avoidedPhrases: avoidedJson,
      approvedPatterns: approvedJson,
      rejectedPatterns: rejectedJson,
      analyzedSampleCount: samples.length,
      confidence: parsed.confidence,
      version: 1,
      lastAnalyzedAt: new Date(),
    },
    update: {
      profile: profileJson,
      preferredPhrases: preferredJson,
      avoidedPhrases: avoidedJson,
      approvedPatterns: approvedJson,
      rejectedPatterns: rejectedJson,
      analyzedSampleCount: samples.length,
      confidence: parsed.confidence,
      version: (existing?.version ?? 1) + 1,
      lastAnalyzedAt: new Date(),
    },
  });

  return {
    profile: asProfileObject(saved.profile),
    preferredPhrases: asStringArray(saved.preferredPhrases),
    avoidedPhrases: asStringArray(saved.avoidedPhrases),
    approvedPatterns: asStringArray(saved.approvedPatterns),
    rejectedPatterns: asStringArray(saved.rejectedPatterns),
    analyzedSampleCount: saved.analyzedSampleCount,
    version: saved.version,
    confidence: saved.confidence,
    lastAnalyzedAt: saved.lastAnalyzedAt,
  };
}

async function countNewUsefulSamplesSince(userId: string, since: Date | null): Promise<number> {
  const posts = await prisma.post.findMany({
    where: {
      userId,
      source: 'MANUAL',
      ...(since ? { updatedAt: { gt: since } } : {}),
    },
    select: {
      id: true,
      userId: true,
      source: true,
      status: true,
      content: true,
      hashtags: true,
      manualTopic: true,
      aiGenerated: true,
      rewriteCount: true,
      publishedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return posts.filter((post) => isEligibleVoiceSample(post)).length;
}

async function countNewSubstantialRevisionsSince(userId: string, since: Date | null): Promise<number> {
  const posts = await prisma.post.findMany({
    where: {
      userId,
      source: 'MANUAL',
      aiGenerated: true,
      ...(since ? { updatedAt: { gt: since } } : {}),
    },
    select: {
      id: true,
      userId: true,
      source: true,
      status: true,
      content: true,
      hashtags: true,
      manualTopic: true,
      aiGenerated: true,
      rewriteCount: true,
      publishedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return posts.filter((post) => hasSubstantialUserEditing(post)).length;
}

export async function shouldRefreshManualVoiceProfile(userId: string): Promise<boolean> {
  const existing = await prisma.userVoiceProfile.findUnique({
    where: { userId },
    select: { lastAnalyzedAt: true },
  });

  if (!existing) return true;

  const since = existing.lastAnalyzedAt;
  if (!since || Date.now() - since.getTime() >= VOICE_PROFILE_STALE_MS) return true;

  const [newSamples, newRevisions] = await Promise.all([
    countNewUsefulSamplesSince(userId, since),
    countNewSubstantialRevisionsSince(userId, since),
  ]);

  return newSamples >= MIN_NEW_SAMPLES_FOR_REFRESH || newRevisions >= MIN_NEW_REVISIONS_FOR_REFRESH;
}

export function scheduleManualVoiceProfileRefresh(_userId: string): void {
  // Voice profile is sourced from BotConfig.description; no background refresh needed.
}

export async function retrieveRelevantWritingSamples(
  userId: string,
  topic?: string,
  maxSamples = SAMPLE_RETRIEVAL_MAX,
): Promise<ManualWritingSample[]> {
  const samples = await collectManualVoiceSamples(userId, Math.max(maxSamples * 3, 12));
  const ranked = samples
    .map((sample) => ({
      sample,
      score: sample.weight + topicKeywordOverlap(topic ?? '', sample.topic, sample.content) * 25,
    }))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.sample);

  const unique: ManualWritingSample[] = [];
  for (const sample of ranked) {
    if (unique.some((existing) => existing.id === sample.id)) continue;
    unique.push(sample);
    if (unique.length >= maxSamples) break;
  }

  return unique.length >= SAMPLE_RETRIEVAL_MIN
    ? unique.slice(0, maxSamples)
    : unique;
}

export async function getManualVoiceContext(
  userId: string,
  topic?: string,
  preloadedPreferences?: BotVoice,
): Promise<ManualVoiceContext> {
  const explicitPreferences = preloadedPreferences ?? await getBotVoice(userId);
  const learnedVoiceProfile = buildVoiceProfileFromBotConfig(explicitPreferences);

  let selectedWritingSamples: ManualWritingSample[] = [];
  try {
    selectedWritingSamples = await retrieveRelevantWritingSamples(userId, topic, SAMPLE_RETRIEVAL_MAX);
  } catch (error) {
    console.warn('[manual-voice] sample retrieval failed', {
      userId,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    explicitPreferences,
    learnedVoiceProfile,
    selectedWritingSamples,
  };
}
