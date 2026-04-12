import { Router } from 'express';
import { UserRole } from '@prisma/client';
import { prisma } from '../prismaClient';
import { authMiddleware } from '../middleware/authMiddleware';
import { requireRole } from '../middleware/requireRole';
import { getRegionWhere, assertSameRegion } from '../services/tenancyService';

const router = Router();

router.use(authMiddleware);
router.use(requireRole(UserRole.SUPER_ADMIN, UserRole.REGIONAL_ADMIN));

// Regional admin: get users in own region
router.get('/users', async (req, res) => {
  try {
    const where = getRegionWhere(req.user!);

    const users = await prisma.user.findMany({
      where,
      include: {
        subscriptions: {
          include: { plan: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.json(users);
  } catch (error: any) {
    return res.status(403).json({ message: error.message });
  }
});

// Regional admin: get posts in own region
router.get('/posts', async (req, res) => {
  try {
    const where = getRegionWhere(req.user!);

    const posts = await prisma.post.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    return res.json(posts);
  } catch (error: any) {
    return res.status(403).json({ message: error.message });
  }
});

// Regional admin: update a user only if same region
router.patch('/users/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { isActive } = req.body;

    const targetUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, regionId: true },
    });

    if (!targetUser) {
      return res.status(404).json({ message: 'User not found' });
    }

    assertSameRegion(req.user!, targetUser.regionId);

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { isActive },
    });

    return res.json(updatedUser);
  } catch (error: any) {
    return res.status(403).json({ message: error.message });
  }
});

export default router;