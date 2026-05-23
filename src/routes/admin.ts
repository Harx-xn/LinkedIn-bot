// Super-admin API: platform-wide management of regions, sub-admins
// (REGIONAL_ADMIN), other super-admins, and users. Every route below is gated
// to SUPER_ADMIN only.
import { Router } from 'express';
import { UserRole } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { prisma } from '../prismaClient';
import { authMiddleware } from '../middleware/authMiddleware';
import { requireRole } from '../middleware/requireRole';

const router = Router();

router.use(authMiddleware);
router.use(requireRole(UserRole.SUPER_ADMIN));

function isValidUsername(username: string) {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.]{2,19}$/.test(username);
}

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------

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

// List all regions (with client/sub-admin counts)
router.get('/regions', async (_req, res) => {
  const regions = await prisma.region.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { users: true, posts: true, subscriptions: true } },
    },
  });

  return res.json(regions);
});

// ---------------------------------------------------------------------------
// Sub-admins (REGIONAL_ADMIN)
// ---------------------------------------------------------------------------

// Create a brand-new sub-admin. Either attach to an existing region (regionId)
// or create the region inline (regionName/regionSlug/regionCode).
router.post('/sub-admins', async (req, res) => {
  try {
    const { email, username, password } = req.body as {
      email?: string;
      username?: string;
      password?: string;
    };
    let { regionId } = req.body as { regionId?: string };
    const { regionName, regionSlug, regionCode } = req.body as {
      regionName?: string;
      regionSlug?: string;
      regionCode?: string;
    };

    if (!email || !username || !password) {
      return res.status(400).json({ message: 'Missing email, username, or password' });
    }
    if (!email.includes('@')) return res.status(400).json({ message: 'Invalid email format' });
    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }
    if (!isValidUsername(username)) {
      return res.status(400).json({ message: 'Invalid username' });
    }

    // Create region inline if not provided
    if (!regionId) {
      if (!regionName || !regionSlug || !regionCode) {
        return res
          .status(400)
          .json({ message: 'Provide regionId, or regionName + regionSlug + regionCode' });
      }
      const region = await prisma.region.create({
        data: { name: regionName, slug: regionSlug, code: regionCode },
      });
      regionId = region.id;
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        email,
        username,
        passwordHash,
        role: UserRole.REGIONAL_ADMIN,
        regionId,
      },
      select: {
        id: true,
        email: true,
        username: true,
        role: true,
        regionId: true,
        isActive: true,
        createdAt: true,
      },
    });

    return res.status(201).json(user);
  } catch (error: any) {
    if (error?.code === 'P2002') {
      const target = error?.meta?.target?.join?.(', ') || 'field';
      return res.status(400).json({ message: `Duplicate ${target}` });
    }
    return res.status(400).json({ message: error.message || 'Failed to create sub-admin' });
  }
});

// List all sub-admins with region + client count
router.get('/sub-admins', async (_req, res) => {
  const subAdmins = await prisma.user.findMany({
    where: { role: UserRole.REGIONAL_ADMIN },
    select: {
      id: true,
      email: true,
      username: true,
      isActive: true,
      createdAt: true,
      region: {
        select: {
          id: true,
          name: true,
          slug: true,
          code: true,
          _count: { select: { users: true, posts: true, subscriptions: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return res.json(subAdmins);
});

// Promote an existing user to sub-admin for a region
router.post('/regions/:regionId/regional-admins', async (req, res) => {
  try {
    const { regionId } = req.params;
    const { userId } = req.body;

    const user = await prisma.user.update({
      where: { id: userId },
      data: { role: UserRole.REGIONAL_ADMIN, regionId },
    });

    return res.json({ message: 'Regional admin assigned successfully', user });
  } catch (error: any) {
    return res.status(400).json({ message: error.message || 'Failed to assign regional admin' });
  }
});

// Activate / deactivate / reassign a sub-admin
router.patch('/sub-admins/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { isActive, regionId } = req.body as { isActive?: boolean; regionId?: string };

    const data: any = {};
    if (typeof isActive === 'boolean') data.isActive = isActive;
    if (regionId) data.regionId = regionId;

    const user = await prisma.user.update({
      where: { id: userId },
      data,
      select: { id: true, email: true, username: true, isActive: true, regionId: true, role: true },
    });

    return res.json(user);
  } catch (error: any) {
    return res.status(400).json({ message: error.message || 'Failed to update sub-admin' });
  }
});

// Revoke sub-admin (demote to USER)
router.patch('/users/:userId/revoke-regional-admin', async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await prisma.user.update({
      where: { id: userId },
      data: { role: UserRole.USER },
    });

    return res.json({ message: 'Regional admin revoked successfully', user });
  } catch (error: any) {
    return res.status(400).json({ message: error.message || 'Failed to revoke regional admin' });
  }
});

// ---------------------------------------------------------------------------
// Super-admins
// ---------------------------------------------------------------------------

// Create a new super-admin, or promote an existing user (pass userId)
router.post('/super-admins', async (req, res) => {
  try {
    const { userId, email, username, password } = req.body as {
      userId?: string;
      email?: string;
      username?: string;
      password?: string;
    };

    if (userId) {
      const user = await prisma.user.update({
        where: { id: userId },
        data: { role: UserRole.SUPER_ADMIN, regionId: null },
        select: { id: true, email: true, username: true, role: true, isActive: true },
      });
      return res.json({ message: 'User promoted to super-admin', user });
    }

    if (!email || !username || !password) {
      return res
        .status(400)
        .json({ message: 'Provide userId to promote, or email + username + password to create' });
    }
    if (!email.includes('@')) return res.status(400).json({ message: 'Invalid email format' });
    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }
    if (!isValidUsername(username)) {
      return res.status(400).json({ message: 'Invalid username' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { email, username, passwordHash, role: UserRole.SUPER_ADMIN },
      select: { id: true, email: true, username: true, role: true, isActive: true, createdAt: true },
    });

    return res.status(201).json(user);
  } catch (error: any) {
    if (error?.code === 'P2002') {
      const target = error?.meta?.target?.join?.(', ') || 'field';
      return res.status(400).json({ message: `Duplicate ${target}` });
    }
    return res.status(400).json({ message: error.message || 'Failed to create super-admin' });
  }
});

// List super-admins
router.get('/super-admins', async (_req, res) => {
  const superAdmins = await prisma.user.findMany({
    where: { role: UserRole.SUPER_ADMIN },
    select: { id: true, email: true, username: true, isActive: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });

  return res.json(superAdmins);
});

// Demote a super-admin to USER (cannot demote yourself)
router.patch('/super-admins/:userId/demote', async (req, res) => {
  try {
    const { userId } = req.params;

    if (userId === req.user!.id) {
      return res.status(400).json({ message: 'You cannot demote yourself' });
    }

    const remaining = await prisma.user.count({
      where: { role: UserRole.SUPER_ADMIN, id: { not: userId } },
    });
    if (remaining === 0) {
      return res.status(400).json({ message: 'Cannot demote the last super-admin' });
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: { role: UserRole.USER },
      select: { id: true, email: true, username: true, role: true },
    });

    return res.json({ message: 'Super-admin demoted', user });
  } catch (error: any) {
    return res.status(400).json({ message: error.message || 'Failed to demote super-admin' });
  }
});

// ---------------------------------------------------------------------------
// Users (platform-wide)
// ---------------------------------------------------------------------------

// Super admin can see all users
router.get('/users', async (_req, res) => {
  const users = await prisma.user.findMany({
    include: {
      region: true,
      subscriptions: { include: { plan: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  return res.json(users);
});

export default router;
