import { prisma } from '../../prismaClient';
import { canGenerate } from '../entitlementService';
import {
  canRewritePost,
  canUseManualAiOperation,
  recordManualAiOperation,
} from '../planEntitlementService';
import { getBotVoice } from '../userContentContext';
import {
  ManualPostError,
  MANUAL_SOURCE,
  MUTABLE_STATUSES,
} from '../manualPostService';
import {
  type ContentProvider,
  MAX_REWRITE_SUGGESTIONS_LENGTH,
  parseContentProvider,
  validateGenerateInput,
  validateUnsavedRewriteInput,
} from '../manualPostAiService';
import {
  invokeManualRewritePrompt,
  resolveManualContentService,
} from './manualAiProvider';
import { finalizeManualGeneratedPostV2 } from './manualPostFormatting';
import { runManualGenerationMultiStage } from './manualPostMultiStage';
import {
  buildManualRewritePromptV2,
} from './manualPostPrompts';
import { createManualProviderCallBudget } from './manualPostTypes';
import { getManualVoiceContext } from './manualVoiceProfileService';
import { getRecentManualFingerprints } from './manualPostFingerprintService';

function deriveTopicFromContent(content: string): string {
  const line = content
    .split('\n')
    .map((value) => value.trim())
    .find(Boolean);
  return (line ?? 'LinkedIn post').slice(0, 200);
}

function toAuthorContext(voice: Awaited<ReturnType<typeof getBotVoice>>) {
  return {
    description: voice.description,
    tone: voice.tone,
    niches: voice.niches,
  };
}

export async function generateManualPostV2(
  userId: string,
  body: {
    topic?: unknown;
    additionalInstructions?: unknown;
    supportingContext?: unknown;
    provider?: unknown;
  },
) {
  const gate = await canGenerate(userId);
  if (!gate.allowed) {
    throw new ManualPostError(
      403,
      gate.reason || 'You are not allowed to generate content right now',
      gate.entitlement,
    );
  }

  await canUseManualAiOperation(userId);

  const { topic, additionalInstructions, supportingContext } = validateGenerateInput(body);
  const provider = parseContentProvider(body.provider);
  const voice = await getBotVoice(userId);
  const voiceContext = await getManualVoiceContext(userId, topic);
  let recentFingerprints: Awaited<ReturnType<typeof getRecentManualFingerprints>> = [];
  try {
    recentFingerprints = await getRecentManualFingerprints(userId);
  } catch (error) {
    console.warn('[manual-fingerprint] retrieval failed; continuing without fingerprints', {
      userId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const contentService = await resolveManualContentService(userId, provider);
  const budget = createManualProviderCallBudget();

  let generated;
  try {
    const result = await runManualGenerationMultiStage(
      contentService,
      {
        topic,
        additionalInstructions,
        supportingContext,
        author: toAuthorContext(voice),
        voiceContext,
        recentFingerprints,
      },
      provider,
      budget,
    );
    generated = result.post;
  } catch (error) {
    if (error instanceof ManualPostError) throw error;
    console.error('[manual-post-v2] generation failed', {
      userId,
      message: error instanceof Error ? error.message : String(error),
    });
    throw new ManualPostError(502, 'Failed to generate post content');
  }

  const normalized = finalizeManualGeneratedPostV2(generated, topic, {
    topic,
    voice,
  });

  await recordManualAiOperation(userId, 'generate');

  return {
    content: normalized.content,
    hashtags: normalized.hashtags || null,
    topic,
    generatedBy: 'AI' as const,
  };
}

export async function rewriteUnsavedManualPostV2(
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
    throw new ManualPostError(
      403,
      gate.reason || 'You are not allowed to rewrite content right now',
      gate.entitlement,
    );
  }

  const usage = await canUseManualAiOperation(userId);

  const { content, suggestions, topic: suppliedTopic } = validateUnsavedRewriteInput(body);
  const provider = parseContentProvider(body.provider);
  const voice = await getBotVoice(userId);
  const topic = suppliedTopic ?? deriveTopicFromContent(content);
  const voiceContext = await getManualVoiceContext(userId, topic);
  const contentService = await resolveManualContentService(userId, provider);

  const prompt = buildManualRewritePromptV2({
    currentContent: content,
    suggestions,
    author: toAuthorContext(voice),
    voiceContext,
  });

  let generated;
  try {
    generated = await invokeManualRewritePrompt(contentService, prompt, provider);
  } catch (error) {
    console.error('[manual-post-v2] unsaved rewrite failed', {
      userId,
      message: error instanceof Error ? error.message : String(error),
    });
    throw new ManualPostError(502, 'Failed to rewrite post content');
  }

  const normalized = finalizeManualGeneratedPostV2(generated, content, {
    topic,
    voice,
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

export async function rewriteSavedManualPostV2(
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
  const topic = post.manualTopic ?? deriveTopicFromContent(post.content);
  const voiceContext = await getManualVoiceContext(userId, topic);
  const contentService = await resolveManualContentService(userId, provider);

  const prompt = buildManualRewritePromptV2({
    currentContent: post.content,
    suggestions,
    author: toAuthorContext(voice),
    voiceContext,
  });

  let generated;
  try {
    generated = await invokeManualRewritePrompt(contentService, prompt, provider);
  } catch (error) {
    console.error('[manual-post-v2] saved rewrite failed', {
      userId,
      postId,
      message: error instanceof Error ? error.message : String(error),
    });
    throw new ManualPostError(502, 'Failed to rewrite post content');
  }

  const normalized = finalizeManualGeneratedPostV2(generated, post.content, {
    topic,
    voice,
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
