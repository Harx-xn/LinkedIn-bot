import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { prisma } from '../prismaClient';
import {
  ManualPostError,
  MANUAL_SOURCE,
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
import { applyBrandLogoWatermark, normalizeBrandLogoPosition } from '../services/brandLogoService';
import {
  GenerativeImageError,
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

const router = Router();

const AI_IMAGE_ASPECT_RATIOS = new Set<LinkedInImageAspectRatio>(['1:1', '4:5', '16:9']);

function extensionForMimeType(mimeType: string): string {
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  return 'png';
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
  return { instructions, style, aspectRatio };
}

async function generateAndUploadManualAiImage(params: {
  userId: string;
  postText: string;
  uploadKey: string;
  instructions?: string;
  style?: string;
  aspectRatio?: LinkedInImageAspectRatio;
}): Promise<{ mediaUrl: string; mimeType: string; model: string }> {
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
  });

  let finalBuffer = generated.buffer;
  let finalMimeType = generated.mimeType;
  if (botConfig?.brandLogoEnabled && botConfig.brandLogoUrl) {
    try {
      finalBuffer = await applyBrandLogoWatermark({
        baseImage: generated.buffer,
        logoUrl: botConfig.brandLogoUrl,
        userId: params.userId,
        position: normalizeBrandLogoPosition(botConfig.brandLogoPosition),
      });
      finalMimeType = 'image/png';
    } catch (err) {
      console.warn('[manual] Brand logo watermark skipped', {
        userId: params.userId,
        message: err instanceof Error ? err.message : 'unknown error',
      });
    }
  }
  const ext = extensionForMimeType(finalMimeType);
  const mediaUrl = await uploadBufferToR2(
    finalBuffer,
    `${params.uploadKey}.${ext}`,
    finalMimeType,
  );

  return {
    mediaUrl,
    mimeType: finalMimeType,
    model: generated.model,
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
        res.status(err.status).json({ error: err.message, code: err.code });
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
    const result = await generateManualPostContent(userId, req.body || {});
    res.json(result);
  }),
);

// AI: rewrite unsaved generated/edited content.
router.post(
  '/rewrite',
  requireAuth,
  handle(async (req, res) => {
    const userId = requireUserId(req);
    const result = await rewriteUnsavedManualContent(userId, req.body || {});
    res.json(result);
  }),
);

// AI: generate post content from an external article URL.
router.post(
  '/generate-from-url',
  requireAuth,
  handle(async (req, res) => {
    const userId = requireUserId(req);
    await requireSavedGhostwriterDescription(userId);
    const result = await generateManualPostFromUrl(userId, req.body || {});
    res.json(result);
  }),
);

// AI: suggest LinkedIn post topics from the user's ghostwriter profile.
router.post(
  '/suggest-topics',
  requireAuth,
  handle(async (req, res) => {
    const userId = requireUserId(req);
    await requireSavedGhostwriterDescription(userId);
    const result = await suggestManualPostTopics(userId, {
      count: req.body?.count,
      provider: req.body?.provider,
    });
    res.json(result);
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

    const { instructions, style, aspectRatio } = parseAiImageOptions(req.body);

    const result = await generateAndUploadManualAiImage({
      userId,
      postText: content,
      uploadKey: `generated/ai-manual-${userId}-${Date.now()}`,
      instructions,
      style,
      aspectRatio,
    });

    await recordImageGeneration(userId);

    res.json(result);
  }),
);

// 1. Create a manual draft.
router.post(
  '/drafts',
  requireAuth,
  handle(async (req, res) => {
    const userId = requireUserId(req);
    const post = await createDraft(userId, req.body || {});
    res.status(201).json(post);
  }),
);

// 5. Create + publish immediately.
router.post(
  '/publish-now',
  requireAuth,
  handle(async (req, res) => {
    const userId = requireUserId(req);
    const post = await createAndPublishNow(userId, req.body || {});
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
    const post = await rewriteSavedManualPost(userId, req.params.postId, req.body || {});
    res.json(post);
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
    if (!post || post.source !== MANUAL_SOURCE) {
      throw new ManualPostError(404, 'Post not found');
    }
    if (post.userId !== userId) {
      throw new ManualPostError(403, 'Unauthorized');
    }
    if (post.status === 'PUBLISHED') {
      throw new ManualPostError(400, 'Cannot generate images for published posts');
    }

    const content = post.content?.trim();
    if (!content) {
      throw new ManualPostError(400, 'Post content is required');
    }

    const { instructions, style, aspectRatio } = parseAiImageOptions(req.body);

    const { mediaUrl } = await generateAndUploadManualAiImage({
      userId,
      postText: content,
      uploadKey: `generated/ai-manual-${postId}-${Date.now()}`,
      instructions,
      style,
      aspectRatio,
    });

    const updated = await prisma.post.update({
      where: { id: post.id },
      data: { mediaUrl },
    });

    await recordImageGeneration(userId);

    res.json(updated);
  }),
);

// 4. Publish an existing post now.
router.post(
  '/:postId/publish-now',
  requireAuth,
  handle(async (req, res) => {
    const userId = requireUserId(req);
    const post = await publishManualPostNow(userId, req.params.postId);
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
