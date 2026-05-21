import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { prisma } from '../prismaClient';
import { postToLinkedInFromPostId } from '../services/linkedinService';

const router = Router();

import { ImageService } from '../services/imageService';
const imageService = new ImageService();

router.get('/', requireAuth, async (req, res) => {
  const { source, status } = req.query as {
    source?: string;
    status?: string;
  };

  const where: any = {
    userId: req.userId!
  };

  if (source) {
    where.source = source;
  }

  if (status) {
    where.status = status;
  }

  const posts = await prisma.post.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 100
  });

  res.json(posts);
});

router.get('/queue', requireAuth, async (req, res) => {
  const posts = await prisma.post.findMany({
    where: { userId: req.userId!, status: 'QUEUED' },
    orderBy: { scheduledAt: 'desc' }
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
