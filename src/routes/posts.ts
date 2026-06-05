import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { prisma } from '../prismaClient';
import { postToLinkedInFromPostId } from '../services/linkedinService';
import { canPublish } from '../services/entitlementService';
import { ImageService } from '../services/imageService';
import { ContentService } from '../services/contentService';
import { decryptSecret, decryptSecretArray } from '../services/secretCrypto';
import { finalizeGeneratedPostContent } from '../services/postContentFormatting';

const router = Router();
const imageService = new ImageService();

async function getContentServiceForUser(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { region: { select: { openaiApiKey: true, geminiApiKeys: true } } },
  });

  return new ContentService({
    openaiApiKey: decryptSecret(user?.region?.openaiApiKey),
    geminiApiKeys: decryptSecretArray(user?.region?.geminiApiKeys),
  });
}

async function getBotVoice(userId: string) {
  const config = await prisma.botConfig.findUnique({
    where: { userId },
    select: {
      tone: true,
      description: true,
      backgroundImageUrl: true,
      customLinks: true,
      contactInfo: true,
      websiteUrl: true,
      includeContactInfo: true,
      includeWebsiteLink: true,
    },
  });

  return {
    tone: config?.tone || 'Professional',
    description: config?.description || '',
    backgroundImageUrl: config?.backgroundImageUrl || undefined,
    customLinks: config?.customLinks || null,
    contactInfo: config?.contactInfo || null,
    websiteUrl: config?.websiteUrl || null,
    includeContactInfo: config?.includeContactInfo ?? false,
    includeWebsiteLink: config?.includeWebsiteLink ?? false,
  };
}

interface NormalizeOptions {
  topic?: string;
  includeContactInfo?: boolean;
  includeWebsiteLink?: boolean;
  contactInfo?: string | null;
  websiteUrl?: string | null;
  description?: string | null;
  customLinks?: string | null;
}

function normalizeGeneratedContent(
  generatedContent: any,
  fallbackContent: string,
  options: NormalizeOptions = {},
) {
  return finalizeGeneratedPostContent(generatedContent, fallbackContent, {
    topic: options.topic,
    includeContactInfo: !!options.includeContactInfo,
    includeWebsiteLink: !!options.includeWebsiteLink,
    contactInfo: options.contactInfo,
    websiteUrl: options.websiteUrl,
    description: options.description,
    customLinks: options.customLinks,
  });
}

router.post('/', requireAuth, async (req, res) => {
  const { content, hashtags, scheduledAt, source, linkedinAccountId, backgroundImageUrl } = req.body;

  if (!content) return res.status(400).json({ error: 'Missing content' });

  let finalLinkedInAccountId = linkedinAccountId;
  if (!finalLinkedInAccountId) {
    const linkedInAccount = await prisma.linkedInAccount.findFirst({
      where: { userId: req.userId! }
    });
    finalLinkedInAccountId = linkedInAccount?.id || null;
  }

  let mediaUrl = null;
  if (backgroundImageUrl) {
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
      mediaUrl: mediaUrl
    }
  });

  res.json(post);
});

// Confirm all generated review posts, or only selected IDs, into the real publishing queue.
router.post('/review/confirm', requireAuth, async (req, res) => {
  const postIds = Array.isArray(req.body?.postIds) ? req.body.postIds : undefined;

  const result = await prisma.post.updateMany({
    where: {
      userId: req.userId!,
      status: 'REVIEW',
      source: { in: ['AI', 'AI_TRENDING'] },
      scheduledAt: { not: null },
      ...(postIds ? { id: { in: postIds } } : {}),
    },
    data: { status: 'QUEUED' },
  });

  res.json({ updated: result.count });
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
  if (post.rewriteCount >= 3) return res.status(400).json({ error: 'Rewrite limit reached for this post' });

  const voice = await getBotVoice(req.userId!);
  const contentService = await getContentServiceForUser(req.userId!);
  const generated = await contentService.rewritePost(
    post.content,
    suggestions,
    'OPENAI',
    voice.tone,
    voice.description,
  );

  const normalized = normalizeGeneratedContent(generated, post.content, {
    topic: post.content.split('\n')[0],
    includeContactInfo: voice.includeContactInfo,
    includeWebsiteLink: voice.includeWebsiteLink,
    contactInfo: voice.contactInfo,
    websiteUrl: voice.websiteUrl,
    description: voice.description,
    customLinks: voice.customLinks,
  });

  let mediaUrl = post.mediaUrl;
  try {
    mediaUrl = await imageService.createTopicImage(
      normalized.headline,
      voice.backgroundImageUrl,
      {
        headline: normalized.headline,
        subheadline: normalized.subheadline,
        bulletPoints: normalized.bulletPoints,
      },
    );
  } catch (e) {
    console.error('Rewrite image generation failed:', e);
  }

  const updated = await prisma.post.update({
    where: { id: post.id },
    data: {
      content: normalized.content,
      hashtags: normalized.hashtags || post.hashtags,
      mediaUrl,
      rewriteCount: { increment: 1 },
      errorMessage: null,
    },
  });

  res.json(updated);
});

router.post('/:id/confirm-schedule', requireAuth, async (req, res) => {
  const post = await prisma.post.findUnique({ where: { id: req.params.id } });

  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (post.userId !== req.userId) return res.status(403).json({ error: 'Unauthorized' });
  if (post.status !== 'REVIEW') return res.status(400).json({ error: 'Only review posts can be confirmed' });
  if (!post.scheduledAt) return res.status(400).json({ error: 'Missing proposed schedule time' });

  const updated = await prisma.post.update({
    where: { id: post.id },
    data: { status: 'QUEUED' },
  });

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
    let linkedinAccountId = post.linkedinAccountId;
    if (!linkedinAccountId) {
      const userLi = await prisma.linkedInAccount.findFirst({ where: { userId: req.userId! } });
      if (!userLi) return res.status(400).json({ error: 'No LinkedIn account connected' });
      linkedinAccountId = userLi.id;
      await prisma.post.update({ where: { id: post.id }, data: { linkedinAccountId } });
    }

    await postToLinkedInFromPostId(post.id);

    const updated = await prisma.post.findUnique({ where: { id: post.id } });
    res.json(updated);
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'Failed to publish' });
  }
});

export default router;
