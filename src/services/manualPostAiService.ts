import {
  generateManualPostV2,
  rewriteSavedManualPostV2,
  rewriteUnsavedManualPostV2,
} from './manualPost/manualPostOrchestration';
import { buildManualTopicSuggestionPrompt } from './manualPost/manualPostPrompts';
import { resolveManualContentService } from './manualPost/manualAiProvider';
import { getManualVoiceContext } from './manualPost/manualVoiceProfileService';
import {
  DEFAULT_TOPIC_SUGGESTION_COUNT,
  finalizeTopicSuggestions,
  type ManualTopicSuggestion,
} from './manualPost/manualPostTopicSuggestionService';
import { parseTrendSources } from './trendsService';
import { extractBalancedJsonObject } from './ghostwriterJsonParser';
import { canGenerate } from './entitlementService';
import { getBotVoice } from './userContentContext';
import { prisma } from '../prismaClient';
import { ManualPostError } from './manualPostService';
import {
  fetchReadableArticleFromUrl,
  type ReadableArticle,
} from './manualPost/articleUrlFetcher';
import { buildEffectiveBotStrategy } from './botStrategyService';
import { hasStrategyGenerationContext } from './botStrategyTrendService';
import {
  improveWeakTopicSuggestions,
  STRONG_TOPIC_SCORE,
} from './manualPost/topicImprovementService';
import { areNearDuplicateTitles } from './manualPost/manualPostTopicSuggestionService';

export const MAX_MANUAL_TOPIC_SUGGESTIONS = 10;
export const DEFAULT_MANUAL_TOPIC_SUGGESTIONS = DEFAULT_TOPIC_SUGGESTION_COUNT;

export type { ManualTopicSuggestion };

export const MAX_MANUAL_TOPIC_LENGTH = 500;
export const MAX_ADDITIONAL_INSTRUCTIONS_LENGTH = 1000;
export const MAX_SUPPORTING_CONTEXT_LENGTH = 3000;
export const MAX_REWRITE_SUGGESTIONS_LENGTH = 1000;
export const MAX_REWRITE_CONTENT_LENGTH = 3000;
export const MAX_URL_OPTION_LENGTH = 200;

export const URL_POST_VARIATIONS = [
  'actionable',
  'storytelling',
  'thought-provoking',
  'promotional',
] as const;

export type UrlPostVariation = (typeof URL_POST_VARIATIONS)[number];

export type GenerateFromUrlInput = {
  url: string;
  variation: UrlPostVariation;
  format?: string;
  tone?: string;
  angle?: string;
  structure?: string;
  provider?: unknown;
};

export type ContentProvider = 'OPENAI' | 'GEMINI';

export function parseContentProvider(raw: unknown): ContentProvider {
  if (raw === undefined || raw === null || raw === '') return 'OPENAI';
  if (typeof raw !== 'string') {
    throw new ManualPostError(400, 'Invalid provider; use OPENAI or GEMINI');
  }
  const normalized = raw.trim().toUpperCase();
  if (normalized === 'OPENAI' || normalized === 'GEMINI') return normalized;
  throw new ManualPostError(400, 'Invalid provider; use OPENAI or GEMINI');
}

export function validateGenerateInput(body: {
  topic?: unknown;
  additionalInstructions?: unknown;
  supportingContext?: unknown;
}): { topic: string; additionalInstructions?: string; supportingContext?: string } {
  const topic = typeof body.topic === 'string' ? body.topic.trim() : '';
  if (!topic) throw new ManualPostError(400, 'topic is required');
  if (topic.length > MAX_MANUAL_TOPIC_LENGTH) {
    throw new ManualPostError(400, `topic must be ${MAX_MANUAL_TOPIC_LENGTH} characters or fewer`);
  }

  let additionalInstructions: string | undefined;
  if (body.additionalInstructions !== undefined && body.additionalInstructions !== null) {
    if (typeof body.additionalInstructions !== 'string') {
      throw new ManualPostError(400, 'additionalInstructions must be a string');
    }
    additionalInstructions = body.additionalInstructions.trim();
    if (additionalInstructions.length > MAX_ADDITIONAL_INSTRUCTIONS_LENGTH) {
      throw new ManualPostError(
        400,
        `additionalInstructions must be ${MAX_ADDITIONAL_INSTRUCTIONS_LENGTH} characters or fewer`,
      );
    }
    if (!additionalInstructions) additionalInstructions = undefined;
  }

  let supportingContext: string | undefined;
  if (body.supportingContext !== undefined && body.supportingContext !== null) {
    if (typeof body.supportingContext !== 'string') {
      throw new ManualPostError(400, 'supportingContext must be a string');
    }
    supportingContext = body.supportingContext.trim();
    if (supportingContext.length > MAX_SUPPORTING_CONTEXT_LENGTH) {
      throw new ManualPostError(
        400,
        `supportingContext must be ${MAX_SUPPORTING_CONTEXT_LENGTH} characters or fewer`,
      );
    }
    if (!supportingContext) supportingContext = undefined;
  }

  return { topic, additionalInstructions, supportingContext };
}

export function validateUnsavedRewriteInput(body: {
  content?: unknown;
  suggestions?: unknown;
  topic?: unknown;
}): { content: string; suggestions: string; topic?: string } {
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content) throw new ManualPostError(400, 'content is required');
  if (content.length > MAX_REWRITE_CONTENT_LENGTH) {
    throw new ManualPostError(400, `content must be ${MAX_REWRITE_CONTENT_LENGTH} characters or fewer`);
  }

  const suggestions = typeof body.suggestions === 'string' ? body.suggestions.trim() : '';
  if (!suggestions) throw new ManualPostError(400, 'suggestions is required');
  if (suggestions.length > MAX_REWRITE_SUGGESTIONS_LENGTH) {
    throw new ManualPostError(
      400,
      `suggestions must be ${MAX_REWRITE_SUGGESTIONS_LENGTH} characters or fewer`,
    );
  }

  let topic: string | undefined;
  if (body.topic !== undefined && body.topic !== null) {
    if (typeof body.topic !== 'string') throw new ManualPostError(400, 'topic must be a string');
    topic = body.topic.trim() || undefined;
    if (topic && topic.length > MAX_MANUAL_TOPIC_LENGTH) {
      throw new ManualPostError(400, `topic must be ${MAX_MANUAL_TOPIC_LENGTH} characters or fewer`);
    }
  }

  return { content, suggestions, topic };
}

/** Route-facing alias — delegates to manual-only orchestration. */
export const generateManualPostContent = generateManualPostV2;

/** Route-facing alias — delegates to manual-only orchestration. */
export const rewriteUnsavedManualContent = rewriteUnsavedManualPostV2;

/** Route-facing alias — delegates to manual-only orchestration. */
export const rewriteSavedManualPost = rewriteSavedManualPostV2;

function clampTopicSuggestionCount(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_MANUAL_TOPIC_SUGGESTIONS;
  }
  const count = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(count) || count < 1) {
    throw new ManualPostError(400, 'count must be a positive number');
  }
  return Math.min(Math.floor(count), MAX_MANUAL_TOPIC_SUGGESTIONS);
}

function stripMarkdownFences(raw: string): string {
  return raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
}

export function parseManualTopicSuggestionsResponse(raw: string): ManualTopicSuggestion[] {
  const cleaned = stripMarkdownFences(raw);
  if (!cleaned) {
    throw new ManualPostError(502, 'Could not parse topic suggestions from AI response.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const balanced = extractBalancedJsonObject(cleaned);
    if (!balanced) {
      throw new ManualPostError(502, 'Could not parse topic suggestions from AI response.');
    }
    try {
      parsed = JSON.parse(balanced);
    } catch {
      throw new ManualPostError(502, 'Could not parse topic suggestions from AI response.');
    }
  }

  const topicsRaw = (parsed as { topics?: unknown })?.topics;
  if (!Array.isArray(topicsRaw) || topicsRaw.length === 0) {
    throw new ManualPostError(502, 'AI did not return any topic suggestions.');
  }

  const topics: ManualTopicSuggestion[] = [];
  for (const item of topicsRaw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const title = typeof record.title === 'string' ? record.title.trim() : '';
    const description = typeof record.description === 'string' ? record.description.trim() : '';
    const reason =
      typeof record.reason === 'string' && record.reason.trim()
        ? record.reason.trim()
        : description;
    if (!title || !description) continue;
    topics.push({
      title,
      description,
      reason,
      sourceTitle: typeof record.sourceTitle === 'string' ? record.sourceTitle.trim() : undefined,
      sourceUrl: typeof record.sourceUrl === 'string' ? record.sourceUrl.trim() : undefined,
      sourcePlatform: typeof record.sourcePlatform === 'string' ? record.sourcePlatform.trim() : undefined,
    });
  }

  if (topics.length === 0) {
    throw new ManualPostError(502, 'AI returned topic suggestions in an invalid format.');
  }

  return topics;
}

export async function suggestManualPostTopics(
  userId: string,
  options?: { count?: unknown; provider?: unknown },
): Promise<{ topics: ManualTopicSuggestion[]; metadata?: { requested: number; accepted: number; discarded: number; additionalDiscoveryRuns: number; minimumScore: number } }> {
  const gate = await canGenerate(userId);
  if (!gate.allowed) {
    throw new ManualPostError(
      403,
      gate.reason || 'You are not allowed to generate content right now',
      gate.entitlement,
    );
  }

  const voice = await getBotVoice(userId);
  const count = clampTopicSuggestionCount(options?.count ?? DEFAULT_TOPIC_SUGGESTION_COUNT);
  const provider = parseContentProvider(options?.provider);
  const [voiceContext, botConfig] = await Promise.all([
    getManualVoiceContext(userId),
    prisma.botConfig.findUnique({
      where: { userId },
    }),
  ]);
  const strategy = buildEffectiveBotStrategy(botConfig);
  if (!voice.description.trim() && !hasStrategyGenerationContext(strategy)) {
    throw new ManualPostError(400, 'Complete your ghostwriter profile before suggesting topics.');
  }
  const trendSources = parseTrendSources(botConfig?.sources);
  const currentYear = new Date().getFullYear();
  const contentService = await resolveManualContentService(userId, provider);
  const discoveryCount = Math.min(MAX_MANUAL_TOPIC_SUGGESTIONS, Math.max(count * 2, count));
  const prompt = buildManualTopicSuggestionPrompt({
    voice: {
      tone: strategy.writingStyle.tone[0] || voice.tone,
      description: strategy.profilePositioning.positioningStatement || voice.description,
      niches: strategy.contentPillars.primaryPillars.map((pillar) => pillar.name).concat(voice.niches),
      websiteUrl: voice.websiteUrl,
      contactInfo: voice.contactInfo,
    },
    voiceContext,
    trendSources,
    count: discoveryCount,
    currentYear,
  });

  const discover = async (): Promise<ManualTopicSuggestion[]> => {
    let raw: string;
    try {
      // Use rewrite raw transport so OpenAI is not forced into manual-post JSON schema.
      raw = await contentService.fetchComposerRewriteRaw(prompt, provider);
    } catch (err) {
      console.error('[manual-posts] suggest-topics provider error:', err instanceof Error ? err.message : err);
      throw new ManualPostError(502, 'Could not generate topic suggestions right now. Try again.');
    }
    let parsedTopics: ManualTopicSuggestion[] = [];
    try {
      parsedTopics = parseManualTopicSuggestionsResponse(raw);
    } catch (err) {
      console.warn('[manual-posts] suggest-topics AI parse failed; using profile fallbacks', {
        userId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return finalizeTopicSuggestions(parsedTopics, voice, trendSources, discoveryCount, strategy);
  };

  const improveBatch = (improvementPrompt: string) =>
    contentService.fetchComposerRewriteRaw(improvementPrompt, provider);
  let discarded = 0;
  let additionalDiscoveryRuns = 0;
  const first = await improveWeakTopicSuggestions({ topics: await discover(), strategy, improveBatch });
  let accepted = first.accepted;
  discarded += first.discarded.length;

  if (accepted.length < count) {
    additionalDiscoveryRuns = 1;
    const second = await improveWeakTopicSuggestions({ topics: await discover(), strategy, improveBatch });
    discarded += second.discarded.length;
    for (const topic of second.accepted) {
      if (!accepted.some((existing) =>
        areNearDuplicateTitles(existing.title, topic.title)
        || (existing.sourceUrl && topic.sourceUrl && existing.sourceUrl === topic.sourceUrl)
        || (existing.suggestedAngle && topic.suggestedAngle && areNearDuplicateTitles(existing.suggestedAngle, topic.suggestedAngle)))) {
        accepted.push(topic);
      }
    }
  }

  const topics = accepted
    .sort((a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0))
    .slice(0, count);
  if (topics.length === 0) {
    throw new ManualPostError(502, 'Could not generate topic suggestions right now. Try again.');
  }
  console.info('[topic-improvement] run complete', {
    requested: count,
    accepted: topics.length,
    discarded,
    additionalDiscoveryRuns,
  });
  return {
    topics,
    metadata: { requested: count, accepted: topics.length, discarded, additionalDiscoveryRuns, minimumScore: STRONG_TOPIC_SCORE },
  };
}

function pickOptionalString(
  value: unknown,
  field: string,
  maxLength = MAX_URL_OPTION_LENGTH,
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new ManualPostError(400, `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > maxLength) {
    throw new ManualPostError(400, `${field} must be ${maxLength} characters or fewer`);
  }
  return trimmed;
}

export function validateGenerateFromUrlInput(body: {
  url?: unknown;
  variation?: unknown;
  format?: unknown;
  tone?: unknown;
  angle?: unknown;
  structure?: unknown;
}): Omit<GenerateFromUrlInput, 'provider'> {
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!url) {
    throw new ManualPostError(400, 'url is required');
  }

  const variationRaw = typeof body.variation === 'string' ? body.variation.trim() : '';
  if (!variationRaw) {
    throw new ManualPostError(400, 'variation is required');
  }
  if (!URL_POST_VARIATIONS.includes(variationRaw as UrlPostVariation)) {
    throw new ManualPostError(
      400,
      'variation must be actionable, storytelling, thought-provoking, or promotional',
    );
  }

  return {
    url,
    variation: variationRaw as UrlPostVariation,
    format: pickOptionalString(body.format, 'format'),
    tone: pickOptionalString(body.tone, 'tone'),
    angle: pickOptionalString(body.angle, 'angle'),
    structure: pickOptionalString(body.structure, 'structure'),
  };
}

function buildArticleSupportingContext(article: ReadableArticle): string {
  const parts = [
    'ARTICLE SOURCE MATERIAL (factual source only — do not invent beyond this excerpt):',
    `URL: ${article.url}`,
    article.title ? `Title: ${article.title}` : '',
    article.description ? `Description: ${article.description}` : '',
    '',
    'ARTICLE EXCERPT:',
    article.text,
  ].filter(Boolean);

  const context = parts.join('\n').trim();
  if (context.length <= MAX_SUPPORTING_CONTEXT_LENGTH) {
    return context;
  }

  const overhead = context.length - article.text.length;
  const allowedTextLength = Math.max(200, MAX_SUPPORTING_CONTEXT_LENGTH - overhead - 3);
  return [
    ...parts.slice(0, -1),
    `${article.text.slice(0, allowedTextLength)}...`,
  ].join('\n');
}

function buildUrlGenerationInstructions(input: Omit<GenerateFromUrlInput, 'url' | 'provider'>): string {
  const lines = [
    'Source type: url article.',
    `Desired variation: ${input.variation}.`,
    'Turn the supplied article excerpt into an original LinkedIn post for this author.',
    'Summarize, interpret, or extract takeaways — do not copy long phrases from the article.',
    'Do not invent facts, metrics, quotes, customers, or events beyond the article excerpt.',
    'Do not claim the author personally experienced something unless the article excerpt or author profile supports it.',
    'Keep a clear angle and make the post LinkedIn-ready.',
  ];

  if (input.format) lines.push(`Preferred format: ${input.format}.`);
  if (input.tone) lines.push(`Preferred tone override: ${input.tone}.`);
  if (input.angle) lines.push(`Preferred angle: ${input.angle}.`);
  if (input.structure) lines.push(`Preferred structure: ${input.structure}.`);

  return lines.join('\n');
}

export async function generateManualPostFromUrl(
  userId: string,
  body: Record<string, unknown>,
): Promise<{
  content: string;
  hashtags: string | null;
  topic: string;
  generatedBy: 'AI';
  source: {
    url: string;
    title: string;
    description: string;
  };
}> {
  const input = validateGenerateFromUrlInput(body);
  const article = await fetchReadableArticleFromUrl(input.url);
  const topic = (article.title || 'Article takeaways').slice(0, MAX_MANUAL_TOPIC_LENGTH);

  const generated = await generateManualPostContent(userId, {
    topic,
    supportingContext: buildArticleSupportingContext(article),
    additionalInstructions: buildUrlGenerationInstructions(input),
    provider: body.provider,
  });

  return {
    ...generated,
    source: {
      url: article.url,
      title: article.title,
      description: article.description,
    },
  };
}
