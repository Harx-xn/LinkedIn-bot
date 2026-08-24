import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { requireAuth } from '../middleware/auth';
import { prisma } from '../prismaClient';
import {
  getUsableLinkedInAccountForUser,
  postToLinkedInFromPostId,
} from '../services/linkedinService';
import { canPublish } from '../services/entitlementService';
import { ImageService } from '../services/imageService';
import { uploadBufferToR2 } from '../middleware/r2';
import {
  getBotVoice,
  getContentServiceForUser,
  getGenerativeImagesServiceForUser,
  normalizeGeneratedContent,
} from '../services/userContentContext';
import {
  GenerativeImageError,
  parseImageCreativeOverrides,
  type LinkedInImageAspectRatio,
} from '../services/generativeImagesService';
import { applyOptionalBrandLogo } from '../services/brandLogoService';
import {
  PlanLimitError,
  canPublishToLinkedIn,
  canRewritePost,
  canUseImageGeneration,
  recordImageGeneration,
} from '../services/planEntitlementService';
import { safeUpdateTopicHistoryStatus } from '../services/topicHistoryService';
import {
  CalendarMonthError,
  getCalendarDayUtcRange,
  getCalendarMonthUtcRange,
} from '../services/calendarMonthService';
import {
  BulkPostDeleteValidationError,
  bulkDeletePosts,
  parseBulkDeletePostIds,
} from '../services/bulkPostDeleteService';
import { validateCarouselAttachmentForScheduling } from '../services/carouselAttachmentValidation';

const router = Router();
const imageService = new ImageService();

// Map a PlanLimitError to the spec response shape; rethrow anything else.
function sendIfPlanLimit(res: any, err: unknown): boolean {
  if (err instanceof PlanLimitError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return true;
  }
  return false;
}

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

router.post('/', requireAuth, async (req, res) => {
  const { content, hashtags, scheduledAt, source, linkedinAccountId, backgroundImageUrl } = req.body;

  if (!content) return res.status(400).json({ error: 'Missing content' });

  let finalLinkedInAccountId = linkedinAccountId;
  if (!finalLinkedInAccountId) {
    const linkedInAccount = await getUsableLinkedInAccountForUser(req.userId!);
    finalLinkedInAccountId = linkedInAccount?.id || null;
  }

  let mediaUrl = null;
  if (backgroundImageUrl) {
    // Image generation is an explicit, user-triggered action here -> enforce.
    try {
      await canUseImageGeneration(req.userId!);
    } catch (err) {
      if (sendIfPlanLimit(res, err)) return;
      throw err;
    }
    try {
      let imageContent;
      try {
        imageContent = JSON.parse(content);
      } catch {
        imageContent = { headline: content.split('\n')[0] };
      }

      mediaUrl = await imageService.createTopicImage(
        imageContent.headline || content,
        backgroundImageUrl,
        imageContent
      );
      await recordImageGeneration(req.userId!);
    } catch (e) {
      console.error('Failed to generate image:', e);
    }
  }

  const post = await prisma.post.create({
    data: {
      userId: req.userId!,
      content,
      hashtags: hashtags || null,
      status: scheduledAt ? 'QUEUED' : 'DRAFT',
      scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
      source: (source === 'GOOGLE_SHEET' || source === 'AI' || source === 'MANUAL' || source === 'AI_TRENDING') ? source : 'MANUAL',
      linkedinAccountId: finalLinkedInAccountId,
      mediaUrl: mediaUrl,
      attachmentType: mediaUrl ? 'IMAGE' : 'NONE',
    }
  });

  res.json(post);
});

// Confirm all generated review posts, or only selected IDs, into the real publishing queue.
router.post('/review/confirm', requireAuth, async (req, res) => {
  const postIds = Array.isArray(req.body?.postIds) ? req.body.postIds : undefined;

  const where = {
    userId: req.userId!,
    status: 'REVIEW',
    source: { in: ['AI', 'AI_TRENDING'] },
    scheduledAt: { not: null },
    ...(postIds ? { id: { in: postIds } } : {}),
  };

  const toConfirm = await prisma.post.findMany({
    where,
    select: { id: true },
  });
  const outdated = await prisma.post.findFirst({ where: { ...where, attachmentType: 'CAROUSEL', OR: [{ carouselPdfUrl: null }, { carouselAttachmentStatus: { not: 'CURRENT' } }] }, select: { id: true } });
  if (outdated) return res.status(409).json({ code: 'CAROUSEL_ATTACHMENT_OUTDATED', message: 'Update the carousel attachment before scheduling this post.', error: 'Update the carousel attachment before scheduling this post.' });
  for (const candidate of await prisma.post.findMany({ where: { ...where, attachmentType: 'CAROUSEL' } })) {
    try { await validateCarouselAttachmentForScheduling(candidate); } catch (error) { return res.status(409).json({ code: 'CAROUSEL_ATTACHMENT_OUTDATED', message: error instanceof Error ? error.message : 'Update the carousel attachment before scheduling this post.', error: error instanceof Error ? error.message : 'Update the carousel attachment before scheduling this post.' }); }
  }

  const result = await prisma.post.updateMany({
    where,
    data: { status: 'QUEUED' },
  });

  for (const p of toConfirm) {
    await safeUpdateTopicHistoryStatus(p.id, 'SCHEDULED');
  }

  res.json({ updated: result.count });
});

router.post('/bulk-delete', requireAuth, async (req, res) => {
  let postIds: string[];
  try {
    postIds = parseBulkDeletePostIds(req.body);
  } catch (err) {
    return res.status(400).json({
      error: err instanceof Error ? err.message : 'Invalid bulk delete request',
    });
  }

  try {
    const result = await bulkDeletePosts(req.userId!, postIds);
    return res.json(result);
  } catch (err) {
    if (err instanceof BulkPostDeleteValidationError) {
      return res.status(400).json({
        error: err.message,
        invalidPosts: err.invalidPosts,
      });
    }
    throw err;
  }
});

const CALENDAR_POST_STATUSES = ['REVIEW', 'QUEUED', 'PUBLISHED', 'FAILED', 'DRAFT'] as const;

const CALENDAR_POST_SELECT = {
  id: true,
  content: true,
  status: true,
  source: true,
  scheduledAt: true,
  publishedAt: true,
  mediaUrl: true,
  hashtags: true,
  linkedinPostUrn: true,
  errorMessage: true,
  createdAt: true,
  updatedAt: true,
} as const;

function serializeCalendarPost(post: {
  id: string;
  content: string;
  status: string;
  source: string;
  scheduledAt: Date | null;
  publishedAt: Date | null;
  mediaUrl: string | null;
  hashtags: string | null;
  linkedinPostUrn: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: post.id,
    content: post.content,
    status: post.status,
    source: post.source,
    scheduledAt: post.scheduledAt?.toISOString() ?? null,
    publishedAt: post.publishedAt?.toISOString() ?? null,
    mediaUrl: post.mediaUrl,
    hashtags: post.hashtags,
    linkedinPostUrn: post.linkedinPostUrn,
    errorMessage: post.errorMessage,
    createdAt: post.createdAt.toISOString(),
    updatedAt: post.updatedAt.toISOString(),
  };
}

router.get('/calendar', requireAuth, async (req, res) => {
  const monthParam = req.query.month;
  const timezoneParam = req.query.timezone;

  if (typeof monthParam !== 'string' || !monthParam.trim()) {
    return res.status(400).json({ error: 'Missing month query parameter. Use YYYY-MM.' });
  }

  if (typeof timezoneParam !== 'string' || !timezoneParam.trim()) {
    return res.status(400).json({ error: 'Missing timezone query parameter.' });
  }

  let range;
  try {
    range = getCalendarMonthUtcRange({
      month: monthParam,
      timezone: timezoneParam,
    });
  } catch (err) {
    if (err instanceof CalendarMonthError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  const posts = await prisma.post.findMany({
    where: {
      userId: req.userId!,
      status: { in: [...CALENDAR_POST_STATUSES] },
      scheduledAt: {
        not: null,
        gte: range.startUtc,
        lt: range.endUtcExclusive,
      },
    },
    select: CALENDAR_POST_SELECT,
    orderBy: { scheduledAt: 'asc' },
  });

  return res.json({
    month: range.month,
    timezone: range.timezone,
    posts: posts.map(serializeCalendarPost),
  });
});

router.get('/calendar/day', requireAuth, async (req, res) => {
  const dateParam = req.query.date;
  const timezoneParam = req.query.timezone;

  if (typeof dateParam !== 'string' || !dateParam.trim()) {
    return res.status(400).json({ error: 'Missing date query parameter. Use YYYY-MM-DD.' });
  }

  if (typeof timezoneParam !== 'string' || !timezoneParam.trim()) {
    return res.status(400).json({ error: 'Missing timezone query parameter.' });
  }

  let range;
  try {
    range = getCalendarDayUtcRange({
      date: dateParam,
      timezone: timezoneParam,
    });
  } catch (err) {
    if (err instanceof CalendarMonthError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  const posts = await prisma.post.findMany({
    where: {
      userId: req.userId!,
      status: { in: [...CALENDAR_POST_STATUSES] },
      scheduledAt: {
        not: null,
        gte: range.startUtc,
        lt: range.endUtcExclusive,
      },
    },
    select: CALENDAR_POST_SELECT,
    orderBy: { scheduledAt: 'asc' },
  });

  return res.json({
    date: range.date,
    timezone: range.timezone,
    posts: posts.map(serializeCalendarPost),
  });
});

router.get('/queue', requireAuth, async (req, res) => {
  const posts = await prisma.post.findMany({
    where: { userId: req.userId!, status: 'QUEUED' },
    orderBy: { scheduledAt: 'desc' }
  });
  res.json(posts);
});

router.get('/', requireAuth, async (req, res) => {
  const posts = await prisma.post.findMany({
    where: { userId: req.userId! },
    orderBy: { createdAt: 'desc' },
    take: 100
  });
  res.json(posts);
});

router.patch('/:id', requireAuth, async (req, res) => {
  const post = await prisma.post.findUnique({ where: { id: req.params.id } });

  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (post.userId !== req.userId) return res.status(403).json({ error: 'Unauthorized' });
  if (post.status === 'PUBLISHED') return res.status(400).json({ error: 'Cannot edit published posts' });

  const updateData: any = {};
  if (typeof req.body.content === 'string') updateData.content = req.body.content;
  if (typeof req.body.hashtags === 'string') updateData.hashtags = req.body.hashtags;
  if (typeof req.body.scheduledAt === 'string') updateData.scheduledAt = new Date(req.body.scheduledAt);
  if (req.body.scheduledAt === null) updateData.scheduledAt = null;
  if (req.body.mediaUrl === null) { updateData.mediaUrl = null; if (post.attachmentType === 'IMAGE') updateData.attachmentType = 'NONE'; }

  const updated = await prisma.post.update({
    where: { id: post.id },
    data: updateData,
  });

  res.json(updated);
});

router.post('/:id/rewrite', requireAuth, async (req, res) => {
  const suggestions = String(req.body?.suggestions || '').trim();
  if (!suggestions) return res.status(400).json({ error: 'Missing rewrite suggestions' });

  const post = await prisma.post.findUnique({ where: { id: req.params.id } });

  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (post.userId !== req.userId) return res.status(403).json({ error: 'Unauthorized' });
  if (post.status !== 'REVIEW') return res.status(400).json({ error: 'Only review posts can be rewritten' });
  if (!['AI', 'AI_TRENDING'].includes(post.source)) return res.status(400).json({ error: 'Only bot posts can be rewritten' });

  // Per-plan rewrite limit (replaces the previous hardcoded cap of 3).
  try {
    await canRewritePost(req.userId!, post.id);
  } catch (err) {
    if (sendIfPlanLimit(res, err)) return;
    throw err;
  }

  const voice = await getBotVoice(req.userId!);
  const contentService = await getContentServiceForUser(req.userId!);
  const generated = await contentService.rewritePost(
    post.content,
    suggestions,
    'OPENAI',
    voice.tone,
    voice.description,
    voice.strategy,
  );

  const normalized = normalizeGeneratedContent(generated, post.content, {
    topic: post.content.split('\n')[0],
    includeContactInfo: voice.includeContactInfo,
    includeWebsiteLink: voice.includeWebsiteLink,
    contactInfo: voice.contactInfo,
    websiteUrl: voice.websiteUrl,
    description: voice.description,
  });

  // Image regeneration is secondary to the text rewrite. Only regenerate when
  // the plan allows it and the user is under their daily image limit; otherwise
  // keep the existing image so the text rewrite is never blocked.
  const updated = await prisma.post.update({
    where: { id: post.id },
    data: {
      content: normalized.content,
      hashtags: normalized.hashtags || post.hashtags,
      rewriteCount: { increment: 1 },
      errorMessage: null,
    },
  });

  res.json(updated);
});

router.post('/:id/generate-ai-image', requireAuth, async (req, res) => {
  const imageRequestId = randomUUID();
  console.info(JSON.stringify({ scope: 'ai-image', requestId: imageRequestId, stage: 'route', event: 'post_request_received', postId: req.params.id }));
  const post = await prisma.post.findUnique({ where: { id: req.params.id } });

  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (post.userId !== req.userId) return res.status(403).json({ error: 'Unauthorized' });
  if (post.status === 'PUBLISHED') {
    return res.status(400).json({ error: 'Cannot generate images for published posts' });
  }
  if (post.attachmentType === 'CAROUSEL' && req.body?.replaceExistingMedia !== true) {
    return res.status(409).json({ code: 'POST_ATTACHMENT_CONFLICT', message: 'Replace the current carousel before adding an image.', error: 'Replace the current carousel before adding an image.' });
  }

  const instructions =
    typeof req.body?.instructions === 'string' ? req.body.instructions.trim() : undefined;
  const style = typeof req.body?.style === 'string' ? req.body.style.trim() : undefined;
  const aspectRatioRaw = req.body?.aspectRatio;
  const aspectRatio =
    typeof aspectRatioRaw === 'string' && AI_IMAGE_ASPECT_RATIOS.has(aspectRatioRaw as LinkedInImageAspectRatio)
      ? (aspectRatioRaw as LinkedInImageAspectRatio)
      : undefined;

  try {
    await canUseImageGeneration(req.userId!);
  } catch (err) {
    if (sendIfPlanLimit(res, err)) return;
    throw err;
  }

  try {
    const [imageService, voice, botConfig] = await Promise.all([
      getGenerativeImagesServiceForUser(req.userId!),
      getBotVoice(req.userId!),
      prisma.botConfig.findUnique({
        where: { userId: req.userId! },
        select: { brandLogoUrl: true, brandLogoEnabled: true, brandLogoPosition: true },
      }),
    ]);

    const generated = await imageService.generateLinkedInPostImage({
      postText: post.content,
      instructions,
      style,
      aspectRatio,
      brandName: resolveBrandNameFromVoice(voice),
      profileDescription: voice.description,
      ...parseImageCreativeOverrides(req.body),
      requestId: imageRequestId,
    });

    const branded = await applyOptionalBrandLogo({
      buffer: generated.buffer, mimeType: generated.mimeType, userId: req.userId!,
      enabled: botConfig?.brandLogoEnabled, logoUrl: botConfig?.brandLogoUrl,
      position: botConfig?.brandLogoPosition, logContext: 'posts',
    });
    const finalBuffer = branded.buffer;
    const finalMimeType = branded.mimeType;
    const ext = extensionForMimeType(finalMimeType);
    let mediaUrl: string;
    try {
      mediaUrl = await uploadBufferToR2(finalBuffer, `generated/ai-post-${post.id}-${Date.now()}.${ext}`, finalMimeType);
      console.info(JSON.stringify({ scope: 'ai-image', requestId: imageRequestId, stage: 'upload', event: 'upload_succeeded', byteLength: finalBuffer.length, mimeType: finalMimeType }));
    } catch (error) {
      throw new GenerativeImageError(502, 'AI_IMAGE_UPLOAD_FAILED', 'The image was created but could not be stored. Try again.', { stage: 'upload', cause: error });
    }

    let updated;
    try {
      updated = await prisma.post.update({ where: { id: post.id }, data: { mediaUrl, attachmentType: 'IMAGE', carouselProjectId: null, carouselPdfUrl: null, carouselFileName: null, carouselUpdatedAt: null, carouselAttachmentStatus: null } });
    } catch (error) {
      throw new GenerativeImageError(500, 'AI_IMAGE_DB_SAVE_FAILED', 'The image was created but could not be attached to the post. Try again.', { stage: 'database', cause: error });
    }

    await recordImageGeneration(req.userId!);

    return res.json(updated);
  } catch (err: unknown) {
    if (err instanceof GenerativeImageError) {
      console.error(JSON.stringify({ scope: 'ai-image', requestId: imageRequestId, stage: err.stage, event: 'request_failed', code: err.code, provider: err.providerDetails }));
      return res.status(err.status).json({ error: err.message, message: err.message, code: err.code });
    }
    console.error('[posts] generate-ai-image failed:', err instanceof Error ? err.message : err);
    return res.status(500).json({
      error: 'Failed to generate AI image',
      code: 'AI_IMAGE_UNKNOWN_ERROR',
    });
  }
});

router.post('/:id/confirm-schedule', requireAuth, async (req, res) => {
  const post = await prisma.post.findUnique({ where: { id: req.params.id } });

  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (post.userId !== req.userId) return res.status(403).json({ error: 'Unauthorized' });
  if (post.status !== 'REVIEW') return res.status(400).json({ error: 'Only review posts can be confirmed' });
  if (!post.scheduledAt) return res.status(400).json({ error: 'Missing proposed schedule time' });
  if (post.attachmentType === 'CAROUSEL' && (!post.carouselPdfUrl || post.carouselAttachmentStatus !== 'CURRENT')) return res.status(409).json({ code: 'CAROUSEL_ATTACHMENT_OUTDATED', message: 'Update the carousel attachment before scheduling this post.', error: 'Update the carousel attachment before scheduling this post.' });
  try { await validateCarouselAttachmentForScheduling(post); } catch (error) { return res.status(409).json({ code: 'CAROUSEL_ATTACHMENT_OUTDATED', message: error instanceof Error ? error.message : 'Update the carousel attachment before scheduling this post.', error: error instanceof Error ? error.message : 'Update the carousel attachment before scheduling this post.' }); }

  const updated = await prisma.post.update({
    where: { id: post.id },
    data: { status: 'QUEUED' },
  });

  await safeUpdateTopicHistoryStatus(post.id, 'SCHEDULED');

  res.json(updated);
});

router.delete('/:id', requireAuth, async (req, res) => {
  const post = await prisma.post.findUnique({
    where: { id: req.params.id }
  });

  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (post.userId !== req.userId) return res.status(403).json({ error: 'Unauthorized' });

  if (post.status === 'PUBLISHED') {
    return res.status(400).json({ error: 'Cannot delete published posts' });
  }

  await safeUpdateTopicHistoryStatus(post.id, 'REJECTED');

  await prisma.post.delete({
    where: { id: req.params.id }
  });

  res.json({ message: 'Post deleted successfully' });
});

router.post('/:id/publish', requireAuth, async (req, res) => {
  const post = await prisma.post.findUnique({
    where: { id: req.params.id }
  });

  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (post.userId !== req.userId) return res.status(403).json({ error: 'Unauthorized' });

  if (post.status === 'PUBLISHED') return res.status(400).json({ error: 'Already published' });

  const gate = await canPublish(req.userId!);
  if (!gate.allowed) {
    return res.status(403).json({ error: gate.reason, entitlement: gate.entitlement });
  }

  try {
    await canPublishToLinkedIn(req.userId!, 1);
  } catch (err) {
    if (sendIfPlanLimit(res, err)) return;
    throw err;
  }

  try {
    let linkedinAccountId = post.linkedinAccountId;
    if (!linkedinAccountId) {
      const userLi = await getUsableLinkedInAccountForUser(req.userId!);
      if (!userLi) return res.status(400).json({ error: 'No LinkedIn account connected' });
      linkedinAccountId = userLi.id;
      await prisma.post.update({ where: { id: post.id }, data: { linkedinAccountId } });
    }

    await postToLinkedInFromPostId(post.id);

    const updated = await prisma.post.findUnique({ where: { id: post.id } });
    res.json(updated);
  } catch (err: any) {
    console.error(err);
    if (post.attachmentType === 'CAROUSEL') {
      await prisma.post.update({ where: { id: post.id }, data: { status: 'FAILED', errorMessage: err.message || 'Carousel document upload failed' } }).catch(() => undefined);
    }
    return res.status(500).json({ error: err.message || 'Failed to publish' });
  }
});

export default router;
