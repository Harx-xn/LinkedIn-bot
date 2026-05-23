import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { prisma } from '../prismaClient';
import { postToLinkedInFromPostId } from '../services/linkedinService';
import { canPublish } from '../services/entitlementService';

const router = Router();

import { ImageService } from '../services/imageService';
const imageService = new ImageService();

router.post('/', requireAuth, async (req, res) => {
  const { content, hashtags, scheduledAt, source, linkedinAccountId, backgroundImageUrl } = req.body;

  if (!content) return res.status(400).json({ error: 'Missing content' });

  // Auto-fetch user's LinkedIn account if not provided
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
      // For manual posts, use the content as simple text overlay
      // Parse content to extract headline if user provides structured format
      let imageContent;
      try {
        imageContent = JSON.parse(content);
      } catch {
        // If not JSON, use content as headline
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
      source: (source === 'GOOGLE_SHEET' || source === 'AI' || source === 'MANUAL') ? source : 'MANUAL',
      linkedinAccountId: finalLinkedInAccountId,
      mediaUrl: mediaUrl
    }
  });

  res.json(post);
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

router.delete('/:id', requireAuth, async (req, res) => {
  const post = await prisma.post.findUnique({
    where: { id: req.params.id }
  });

  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (post.userId !== req.userId) return res.status(403).json({ error: 'Unauthorized' });

  // Prevent deletion of published posts (optional safety measure)
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

  // If it's already published, don't re-publish
  if (post.status === 'PUBLISHED') return res.status(400).json({ error: 'Already published' });

  // Enforce trial / subscription limits (1 published post per day on trial).
  const gate = await canPublish(req.userId!);
  if (!gate.allowed) {
    return res.status(403).json({ error: gate.reason, entitlement: gate.entitlement });
  }

  // If it's DRAFT or QUEUED or FAILED, try to publish
  try {
    // If it doesn't have a linkedInAccount attached, try to find one for the user?
    // The service requires post.linkedinAccountId.
    // Let's check if we need to update it first.
    let linkedinAccountId = post.linkedinAccountId;
    if (!linkedinAccountId) {
      const userLi = await prisma.linkedInAccount.findFirst({ where: { userId: req.userId! } });
      if (!userLi) return res.status(400).json({ error: 'No LinkedIn account connected' });
      linkedinAccountId = userLi.id;
      await prisma.post.update({ where: { id: post.id }, data: { linkedinAccountId } });
    }

    // Now publish using the service
    await postToLinkedInFromPostId(post.id);

    // Fetch updated post
    const updated = await prisma.post.findUnique({ where: { id: post.id } });
    res.json(updated);
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'Failed to publish' });
  }
});

export default router;
