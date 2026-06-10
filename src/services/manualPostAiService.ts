import { prisma } from '../prismaClient';
import { canGenerate } from './entitlementService';
import {
  canRewritePost,
  canUseManualAiOperation,
  recordManualAiOperation,
} from './planEntitlementService';
import {
  deriveTopicFromContent,
  getBotVoice,
  getContentServiceForUser,
  normalizeGeneratedContent,
} from './userContentContext';
import { ManualPostError, MANUAL_SOURCE, MUTABLE_STATUSES } from './manualPostService';

export const MAX_MANUAL_TOPIC_LENGTH = 500;
export const MAX_ADDITIONAL_INSTRUCTIONS_LENGTH = 1000;
export const MAX_REWRITE_SUGGESTIONS_LENGTH = 1000;
export const MAX_REWRITE_CONTENT_LENGTH = 3000;

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
}): { topic: string; additionalInstructions?: string } {
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

  return { topic, additionalInstructions };
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

async function assertProviderAvailable(
  userId: string,
  provider: ContentProvider,
): Promise<Awaited<ReturnType<typeof getContentServiceForUser>>> {
  const contentService = await getContentServiceForUser(userId);
  const hasPrimary = contentService.hasProvider(provider);
  const hasFallback = provider === 'OPENAI'
    ? contentService.hasProvider('GEMINI')
    : contentService.hasProvider('OPENAI');

  if (!hasPrimary && !hasFallback) {
    throw new ManualPostError(
      503,
      provider === 'OPENAI'
        ? 'AI provider unavailable. Configure OpenAI or Gemini API keys.'
        : 'AI provider unavailable. Configure Gemini or OpenAI API keys.',
    );
  }
  return contentService;
}

export async function generateManualPostContent(
  userId: string,
  body: {
    topic?: unknown;
    additionalInstructions?: unknown;
    provider?: unknown;
  },
) {
  const gate = await canGenerate(userId);
  if (!gate.allowed) {
    throw new ManualPostError(403, gate.reason || 'You are not allowed to generate content right now', gate.entitlement);
  }

  await canUseManualAiOperation(userId);

  const { topic, additionalInstructions } = validateGenerateInput(body);
  const provider = parseContentProvider(body.provider);
  const voice = await getBotVoice(userId);
  const contentService = await assertProviderAvailable(userId, provider);

  let generated;
  try {
    generated = await contentService.generateManualPost(
      {
        topic,
        additionalInstructions,
        tone: voice.tone,
        description: voice.description,
        niches: voice.niches,
      },
      provider,
    );
  } catch (error) {
    console.error('[manual-post-ai] generation failed', {
      userId,
      message: error instanceof Error ? error.message : String(error),
    });
    throw new ManualPostError(502, 'Failed to generate post content');
  }

  const normalized = normalizeGeneratedContent(generated, topic, {
    topic,
    includeContactInfo: voice.includeContactInfo,
    includeWebsiteLink: voice.includeWebsiteLink,
    contactInfo: voice.contactInfo,
    websiteUrl: voice.websiteUrl,
    description: voice.description,
    customLinks: voice.customLinks,
  });

  await recordManualAiOperation(userId, 'generate');

  return {
    content: normalized.content,
    hashtags: normalized.hashtags || null,
    topic,
    generatedBy: 'AI' as const,
  };
}

export async function rewriteUnsavedManualContent(
  userId: string,
  body: {
    content?: unknown;
    suggestions?: unknown;
    topic?: unknown;
    provider?: unknown;
  },
) {
  const gate = await canGenerate(userId);
  if (!gate.allowed) {
    throw new ManualPostError(403, gate.reason || 'You are not allowed to rewrite content right now', gate.entitlement);
  }

  const usage = await canUseManualAiOperation(userId);

  const { content, suggestions, topic: suppliedTopic } = validateUnsavedRewriteInput(body);
  const provider = parseContentProvider(body.provider);
  const voice = await getBotVoice(userId);
  const contentService = await assertProviderAvailable(userId, provider);
  const topic = suppliedTopic ?? deriveTopicFromContent(content);

  let generated;
  try {
    generated = await contentService.rewritePost(
      content,
      suggestions,
      provider,
      voice.tone,
      voice.description,
    );
  } catch (error) {
    console.error('[manual-post-ai] unsaved rewrite failed', {
      userId,
      message: error instanceof Error ? error.message : String(error),
    });
    throw new ManualPostError(502, 'Failed to rewrite post content');
  }

  const normalized = normalizeGeneratedContent(generated, content, {
    topic,
    includeContactInfo: voice.includeContactInfo,
    includeWebsiteLink: voice.includeWebsiteLink,
    contactInfo: voice.contactInfo,
    websiteUrl: voice.websiteUrl,
    description: voice.description,
    customLinks: voice.customLinks,
  });

  await recordManualAiOperation(userId, 'rewrite_unsaved');

  return {
    content: normalized.content,
    hashtags: normalized.hashtags || null,
    topic,
    rewriteCount: usage.usedToday + 1,
  };
}

async function findRewritableManualPost(userId: string, postId: string) {
  const post = await prisma.post.findFirst({
    where: { id: postId, userId, source: MANUAL_SOURCE },
  });
  if (!post) throw new ManualPostError(404, 'Post not found');
  if (post.status === 'PUBLISHED') {
    throw new ManualPostError(409, 'Cannot rewrite a published post');
  }
  if (!MUTABLE_STATUSES.includes(post.status)) {
    throw new ManualPostError(409, `Cannot rewrite a post with status ${post.status}`);
  }
  return post;
}

export async function rewriteSavedManualPost(
  userId: string,
  postId: string,
  body: { suggestions?: unknown; provider?: unknown },
) {
  const suggestions = typeof body.suggestions === 'string' ? body.suggestions.trim() : '';
  if (!suggestions) throw new ManualPostError(400, 'suggestions is required');
  if (suggestions.length > MAX_REWRITE_SUGGESTIONS_LENGTH) {
    throw new ManualPostError(
      400,
      `suggestions must be ${MAX_REWRITE_SUGGESTIONS_LENGTH} characters or fewer`,
    );
  }

  const post = await findRewritableManualPost(userId, postId);
  await canRewritePost(userId, post.id);

  const provider = parseContentProvider(body.provider);
  const voice = await getBotVoice(userId);
  const contentService = await assertProviderAvailable(userId, provider);
  const topic = post.manualTopic ?? deriveTopicFromContent(post.content);

  let generated;
  try {
    generated = await contentService.rewritePost(
      post.content,
      suggestions,
      provider,
      voice.tone,
      voice.description,
    );
  } catch (error) {
    console.error('[manual-post-ai] saved rewrite failed', {
      userId,
      postId,
      message: error instanceof Error ? error.message : String(error),
    });
    throw new ManualPostError(502, 'Failed to rewrite post content');
  }

  const normalized = normalizeGeneratedContent(generated, post.content, {
    topic,
    includeContactInfo: voice.includeContactInfo,
    includeWebsiteLink: voice.includeWebsiteLink,
    contactInfo: voice.contactInfo,
    websiteUrl: voice.websiteUrl,
    description: voice.description,
    customLinks: voice.customLinks,
  });

  const updated = await prisma.post.update({
    where: { id: post.id },
    data: {
      content: normalized.content,
      hashtags: normalized.hashtags || post.hashtags,
      rewriteCount: { increment: 1 },
      errorMessage: null,
      aiGenerated: true,
      manualTopic: post.manualTopic ?? topic,
    },
  });

  return updated;
}
