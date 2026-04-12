import { Router } from 'express';
import { UserRole } from '@prisma/client';
import { prisma } from '../prismaClient';
import { authMiddleware } from '../middleware/authMiddleware';
import { requireRole } from '../middleware/requireRole';

const router = Router();

router.use(authMiddleware);
router.use(requireRole(UserRole.SUPER_ADMIN));

// Create region
router.post('/regions', async (req, res) => {
  try {
    const {
      name,
      slug,
      code,
      logoUrl,
      primaryColor,
      secondaryColor,
      customDomain,
      subdomain,
      language,
      currency,
      frontendVariant,
    } = req.body;

    const region = await prisma.region.create({
      data: {
        name,
        slug,
        code,
        logoUrl,
        primaryColor,
        secondaryColor,
        customDomain,
        subdomain,
        language,
        currency,
        frontendVariant,
      },
    });

    return res.status(201).json(region);
  } catch (error: any) {
    return res.status(400).json({ message: error.message || 'Failed to create region' });
  }
});

// List all regions
router.get('/regions', async (_req, res) => {
  const regions = await prisma.region.findMany({
    orderBy: { createdAt: 'desc' },
  });

  return res.json(regions);
});

// Create or promote regional admin
router.post('/regions/:regionId/regional-admins', async (req, res) => {
  try {
    const { regionId } = req.params;
    const { userId } = req.body;

    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        role: UserRole.REGIONAL_ADMIN,
        regionId,
      },
    });

    return res.json({
      message: 'Regional admin assigned successfully',
      user,
    });
  } catch (error: any) {
    return res.status(400).json({ message: error.message || 'Failed to assign regional admin' });
  }
});

// Revoke regional admin
router.patch('/users/:userId/revoke-regional-admin', async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        role: UserRole.USER,
      },
    });

    return res.json({
      message: 'Regional admin revoked successfully',
      user,
    });
  } catch (error: any) {
    return res.status(400).json({ message: error.message || 'Failed to revoke regional admin' });
  }
});

// Super admin can see all users
router.get('/users', async (_req, res) => {
  const users = await prisma.user.findMany({
    include: {
      region: true,
      subscriptions: {
        include: {
          plan: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return res.json(users);
});

export default router;