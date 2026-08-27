import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { requireAuth } from '../middleware/auth';
import { prisma } from '../prismaClient';
import {
  ManualPostError,
  createDraft,
  updateManualPost,
  scheduleManualPost,
  publishManualPostNow,
  createAndPublishNow,
  createAndSchedule,
  listManualPosts,
  deleteManualPost,
  duplicateManualPost,
} from '../services/manualPostService';
import { uploadBufferToR2 } from '../middleware/r2';
import { applyOptionalBrandLogo } from '../services/brandLogoService';
import {
  GenerativeImageError,
  parseImageCreativeOverrides,
  type GenerateLinkedInPostImageInput,
  type LinkedInImageAspectRatio,
} from '../services/generativeImagesService';
import {
  PlanLimitError,
  canUseImageGeneration,
  recordImageGeneration,
} from '../services/planEntitlementService';
import {
  generateManualPostContent,
  generateManualPostFromUrl,
  rewriteSavedManualPost,
  rewriteUnsavedManualContent,
  suggestManualPostTopics,
} from '../services/manualPostAiService';
import { getBotVoice, getGenerativeImagesServiceForUser } from '../services/userContentContext';
import {
  GHOSTWRITER_CONFIG_REQUIRED_MESSAGE,
  hasSavedGhostwriterDescription,
} from '../services/ghostwriterConfigRequirementService';
import { savePersonalExperience, suggestPersonalExperiences } from '../services/manualPost/personalExperienceService';
import { createGenerationId, withAiCostContext } from '../services/costIntelligence/aiCostTrackingService';
import { linkAiUsageGenerationsToPost } from '../services/costIntelligence/aiUsageService';

const router = Router();

const AI_IMAGE_ASPECT_RATIOS = new Set<LinkedInImageAspectRatio>(['1:1', '4:5', '16:9']);

function extensionForMimeType(mimeType: string): string {
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  return 'png';
}

function requestGenerationIds(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const value = (body as { generationIds?: unknown }).generationIds;
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function resolveBrandNameFromVoice(voice: Awaited<ReturnType<typeof getBotVoice>>): string | undefined {
  if (voice.websiteUrl?.trim()) {
    try {
      return new URL(voice.websiteUrl).hostname.replace(/^www\./i, '');
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function parseAiImageOptions(body: Record<string, unknown> | undefined) {
  const instructions =
    typeof body?.instructions === 'string' ? body.instructions.trim() : undefined;
  const style = typeof body?.style === 'string' ? body.style.trim() : undefined;
  const aspectRatioRaw = body?.aspectRatio;
  const aspectRatio =
    typeof aspectRatioRaw === 'string' &&
    AI_IMAGE_ASPECT_RATIOS.has(aspectRatioRaw as LinkedInImageAspectRatio)
      ? (aspectRatioRaw as LinkedInImageAspectRatio)
      : undefined;
  return { instructions, style, aspectRatio, ...parseImageCreativeOverrides(body) };
}

async function generateAndUploadManualAiImage(params: {
  userId: string;
  postText: string;
  uploadKey: string;
  instructions?: string;
  style?: string;
  aspectRatio?: LinkedInImageAspectRatio;
} & Partial<Pick<GenerateLinkedInPostImageInput, 'visualFormat' | 'imageType' | 'mood' | 'colorPalette' | 'complexity' | 'composition' | 'humanPresence' | 'backgroundStyle' | 'textMode'>>): Promise<{ mediaUrl: string; mimeType: string; model: string; requestId: string }> {
  const requestId = randomUUID();
  console.info(JSON.stringify({ scope: 'ai-image', requestId, stage: 'route', event: 'manual_request_received' }));
  await canUseImageGeneration(params.userId);

  const [imageService, voice, botConfig] = await Promise.all([
    getGenerativeImagesServiceForUser(params.userId),
    getBotVoice(params.userId),
    prisma.botConfig.findUnique({
      where: { userId: params.userId },
      select: { brandLogoUrl: true, brandLogoEnabled: true, brandLogoPosition: true },
    }),
  ]);

  const generated = await imageService.generateLinkedInPostImage({
    postText: params.postText,
    instructions: params.instructions,
    style: params.style,
    aspectRatio: params.aspectRatio,
    brandName: resolveBrandNameFromVoice(voice),
    profileDescription: voice.description,
    visualFormat: params.visualFormat,
    imageType: params.imageType,
    mood: params.mood,
    colorPalette: params.colorPalette,
    complexity: params.complexity,
    composition: params.composition,
    humanPresence: params.humanPresence,
    backgroundStyle: params.backgroundStyle,
    textMode: params.textMode,
    requestId,
  });

  const branded = await applyOptionalBrandLogo({
    buffer: generated.buffer, mimeType: generated.mimeType, userId: params.userId,
    enabled: botConfig?.brandLogoEnabled, logoUrl: botConfig?.brandLogoUrl,
    position: botConfig?.brandLogoPosition, logContext: 'manual',
  });
  const finalBuffer = branded.buffer;
  const finalMimeType = branded.mimeType;
  const ext = extensionForMimeType(finalMimeType);
  let mediaUrl: string;
  try {
    mediaUrl = await uploadBufferToR2(finalBuffer, `${params.uploadKey}.${ext}`, finalMimeType);
    console.info(JSON.stringify({ scope: 'ai-image', requestId, stage: 'upload', event: 'upload_succeeded', byteLength: finalBuffer.length, mimeType: finalMimeType }));
  } catch (error) {
    console.error(JSON.stringify({ scope: 'ai-image', requestId, stage: 'upload', event: 'upload_failed', message: error instanceof Error ? error.message.slice(0, 800) : String(error).slice(0, 800) }));
    throw new GenerativeImageError(502, 'AI_IMAGE_UPLOAD_FAILED', 'The image was created but could not be stored. Try again.', { stage: 'upload', requestId, cause: error });
  }

  return {
    mediaUrl,
    mimeType: finalMimeType,
    model: generated.model,
    requestId,
  };
}

// Resolve the authenticated user id, or throw a 401.
function requireUserId(req: Request): string {
  const userId = (req as any).userId as string | undefined;
  if (!userId) throw new ManualPostError(401, 'Unauthorized');
  return userId;
}

async function requireSavedGhostwriterDescription(userId: string) {
  if (!(await hasSavedGhostwriterDescription(userId))) {
    throw new ManualPostError(400, GHOSTWRITER_CONFIG_REQUIRED_MESSAGE);
  }
}

// Wrap a handler so ManualPostError -> proper status, anything else -> 500.
function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof PlanLimitError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof ManualPostError) {
        const body: Record<string, unknown> = { error: err.message };
        if (err.details !== undefined) body.entitlement = err.details;
        res.status(err.status).json(body);
        return;
      }
      if (err instanceof GenerativeImageError) {
        console.error(JSON.stringify({ scope: 'ai-image', requestId: err.requestId, stage: err.stage, event: 'request_failed', code: err.code, provider: err.providerDetails }));
        res.status(err.status).json({ error: err.message, message: err.message, code: err.code });
        return;
      }
      console.error('[manual-posts] error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}

// AI: generate post content without saving.
router.post(
  '/generate',
  requireAuth,
  handle(async (req, res) => {
    const userId = requireUserId(req);
    await requireSavedGhostwriterDescription(userId);
    const generationId = createGenerationId();
    const result = await withAiCostContext({ userId, feature: 'MANUAL_POST', operation: 'MANUAL_GENERATE', agent: 'WRITER', generationId }, () => generateManualPostContent(userId, req.body || {}));
    res.json({ ...result, generationId });
  }),
);

// AI: rewrite unsaved generated/edited content.
router.post(
  '/rewrite',
  requireAuth,
  handle(async (req, res) => {
    const userId = requireUserId(req);
    const generationId = createGenerationId();
    const result = await withAiCostContext({ userId, feature: 'REWRITE', operation: 'MANUAL_REWRITE', agent: 'WRITER', generationId }, () => rewriteUnsavedManualContent(userId, req.body || {}));
    res.json({ ...result, generationId });
  }),
);

// AI: generate post content from an external article URL.
router.post(
  '/generate-from-url',
  requireAuth,
  handle(async (req, res) => {
    const userId = requireUserId(req);
    await requireSavedGhostwriterDescription(userId);
    const generationId = createGenerationId();
    const result = await withAiCostContext({ userId, feature: 'MANUAL_POST', operation: 'MANUAL_GENERATE', agent: 'WRITER', generationId, metadata: { source: 'ARTICLE_URL' } }, () => generateManualPostFromUrl(userId, req.body || {}));
    res.json({ ...result, generationId });
  }),
);

// AI: suggest LinkedIn post topics from the user's ghostwriter profile.
router.post(
  '/suggest-topics',
  requireAuth,
  handle(async (req, res) => {
    const userId = requireUserId(req);
    const generationId = createGenerationId();
    const result = await withAiCostContext({ userId, feature: 'TOPIC_DISCOVERY', operation: 'TOPIC_GENERATE', agent: 'IDEA_GENERATOR', generationId }, () => suggestManualPostTopics(userId, {
      count: req.body?.count,
      provider: req.body?.provider,
      refresh: req.body?.refresh === true,
    }));
    res.json({ ...result, generationId });
  }),
);

// Manual-only personal experience bank. Batch generation never imports this service.
router.get(
  '/experiences/suggestions',
  requireAuth,
  handle(async (req, res) => {
    const userId = requireUserId(req);
    const topic = typeof req.query.topic === 'string' ? req.query.topic.trim() : '';
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 3;
    if (!topic) { res.json({ experiences: [] }); return; }
    const experiences = await suggestPersonalExperiences(userId, topic, Number.isFinite(limit) ? limit : 3);
    res.json({ experiences });
  }),
);

router.post(
  '/experiences',
  requireAuth,
  handle(async (req, res) => {
    const userId = requireUserId(req);
    const rawText = typeof req.body?.rawText === 'string' ? req.body.rawText : '';
    const experience = await savePersonalExperience(userId, rawText);
    res.status(201).json(experience);
  }),
);

// AI: generate image from unsaved manual post content (no post saved yet).
router.post(
  '/generate-ai-image',
  requireAuth,
  handle(async (req, res) => {
    const userId = requireUserId(req);
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    if (!content) {
      throw new ManualPostError(400, 'Content is required');
    }

    const options = parseAiImageOptions(req.body);

    const generationId = createGenerationId();
    const result = await withAiCostContext({ userId, feature: 'AI_IMAGE', operation: 'IMAGE_GENERATE', agent: 'IMAGE_GENERATOR', generationId }, () => generateAndUploadManualAiImage({
      userId,
      postText: content,
      uploadKey: `generated/ai-manual-${userId}-${Date.now()}`,
      ...options,
    }));

    await recordImageGeneration(userId);

    res.json({ ...result, generationId });
  }),
);

// 1. Create a manual draft.
router.post(
  '/drafts',
  requireAuth,
  handle(async (req, res) => {
    const userId = requireUserId(req);
    const post = await createDraft(userId, req.body || {});
    await linkAiUsageGenerationsToPost(userId, requestGenerationIds(req.body), post.id);
    res.status(201).json(post);
  }),
);

// 5. Create + publish immediately.
router.post(
  '/publish-now',
  requireAuth,
  handle(async (req, res) => {
    const userId = requireUserId(req);
    const post = await createAndPublishNow(userId, req.body || {}, randomUUID());
    if (post) await linkAiUsageGenerationsToPost(userId, requestGenerationIds(req.body), post.id);
    res.json(post);
  }),
);

// 6. Create + schedule.
router.post(
  '/schedule',
  requireAuth,
  handle(async (req, res) => {
    const userId = requireUserId(req);
    const post = await createAndSchedule(userId, req.body || {});
    await linkAiUsageGenerationsToPost(userId, requestGenerationIds(req.body), post.id);
    res.status(201).json(post);
  }),
);

// 7. List manual posts.
router.get(
  '/',
  requireAuth,
  handle(async (req, res) => {
    const userId = requireUserId(req);
    const { status, from, to } = req.query as { status?: string; from?: string; to?: string };
    const posts = await listManualPosts(userId, { status, from, to });
    res.json(posts);
  }),
);

// AI: rewrite a saved manual draft or scheduled post.
router.post(
  '/:postId/rewrite',
  requireAuth,
  handle(async (req, res) => {
    const userId = requireUserId(req);
    const generationId = createGenerationId();
    const post = await withAiCostContext({ userId, feature: 'REWRITE', operation: 'MANUAL_REWRITE', agent: 'WRITER', generationId, postId: req.params.postId }, () => rewriteSavedManualPost(userId, req.params.postId, req.body || {}));
    res.json({ ...post, generationId });
  }),
);

// AI: generate or regenerate image for a saved manual draft/scheduled post.
router.post(
  '/:postId/generate-ai-image',
  requireAuth,
  handle(async (req, res) => {
    const userId = requireUserId(req);
    const { postId } = req.params;

    const post = await prisma.post.findUnique({ where: { id: postId } });
    if (!post) {
      throw new ManualPostError(404, 'Post not found');
    }
    if (post.userId !== userId) {
      throw new ManualPostError(403, 'Unauthorized');
    }
    if (post.status === 'PUBLISHED') {
      throw new ManualPostError(400, 'Cannot generate images for published posts');
    }
    if (post.attachmentType === 'CAROUSEL' && req.body?.replaceExistingMedia !== true) {
      throw new ManualPostError(409, 'Replace the current carousel before adding an image.');
    }

    const content = post.content?.trim();
    if (!content) {
      throw new ManualPostError(400, 'Post content is required');
    }

    const options = parseAiImageOptions(req.body);

    const generationId = createGenerationId();
    const { mediaUrl, requestId } = await withAiCostContext({ userId, feature: 'AI_IMAGE', operation: 'IMAGE_GENERATE', agent: 'IMAGE_GENERATOR', generationId, postId }, () => generateAndUploadManualAiImage({
      userId,
      postText: content,
      uploadKey: `generated/ai-manual-${postId}-${Date.now()}`,
      ...options,
    }));

    let updated;
    try {
      updated = await prisma.post.update({
        where: { id: post.id },
        data: { mediaUrl, attachmentType: 'IMAGE', carouselProjectId: null, carouselPdfUrl: null, carouselFileName: null, carouselUpdatedAt: null, carouselAttachmentStatus: null },
      });
    } catch (error) {
      throw new GenerativeImageError(500, 'AI_IMAGE_DB_SAVE_FAILED', 'The image was created but could not be attached to the post. Try again.', { stage: 'database', requestId, cause: error });
    }

    await recordImageGeneration(userId);

    res.json({ ...updated, generationId });
  }),
);

// 4. Publish an existing post now.
router.post(
  '/:postId/publish-now',
  requireAuth,
  handle(async (req, res) => {
    const userId = requireUserId(req);
    const post = await publishManualPostNow(
      userId,
      req.params.postId,
      req.body || {},
      randomUUID(),
    );
    res.json(post);
  }),
);

// 3. Schedule an existing post.
router.post(
  '/:postId/schedule',
  requireAuth,
  handle(async (req, res) => {
    const userId = requireUserId(req);
    const post = await scheduleManualPost(userId, req.params.postId, req.body?.scheduledAt);
    res.json(post);
  }),
);

// 9. Duplicate a post into a new draft.
router.post(
  '/:postId/duplicate',
  requireAuth,
  handle(async (req, res) => {
    const userId = requireUserId(req);
    const post = await duplicateManualPost(userId, req.params.postId);
    res.status(201).json(post);
  }),
);

// 2. Update a draft / scheduled post.
router.patch(
  '/:postId',
  requireAuth,
  handle(async (req, res) => {
    const userId = requireUserId(req);
    const post = await updateManualPost(userId, req.params.postId, req.body || {});
    res.json(post);
  }),
);

// 8. Delete a draft / scheduled / failed post.
router.delete(
  '/:postId',
  requireAuth,
  handle(async (req, res) => {
    const userId = requireUserId(req);
    const result = await deleteManualPost(userId, req.params.postId);
    res.json(result);
  }),
);

export default router;
