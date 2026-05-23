import { Router } from 'express';
import { prisma } from '../prismaClient';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { TRIAL_DAYS } from '../services/entitlementService';

const router = Router();

// Shared JWT signing options. The cast satisfies @types/jsonwebtoken, which
// types `expiresIn` as a narrow string-literal/number rather than `string`.
const signOptions: jwt.SignOptions = {
  expiresIn: config.jwtExpiresIn as jwt.SignOptions['expiresIn'],
};

function isValidUsername(username: string) {
  // 3–20 chars, letters/numbers/underscore/dot, must start with letter or number
  return /^[a-zA-Z0-9][a-zA-Z0-9_.]{2,19}$/.test(username);
}

router.post('/register', async (req, res) => {
  const { email, password, username, regionId } = req.body as {
    email?: string;
    password?: string;
    username?: string;
    regionId?: string;
  };

  if (!email || !password || !username) {
    return res
      .status(400)
      .json({ error: 'Missing email, password, or username' });
  }

  if (!regionId) {
    return res.status(400).json({ error: 'Please select a region' });
  }

  if (!email.includes('@')) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  if (password.length < 6) {
    return res
      .status(400)
      .json({ error: 'Password must be at least 6 characters' });
  }

  if (!isValidUsername(username)) {
    return res.status(400).json({
      error:
        'Invalid username (3–20 chars, letters/numbers/underscore/dot; must start with letter/number)',
    });
  }

  const region = await prisma.region.findFirst({
    where: {
      id: regionId,
      isActive: true,
    },
    select: {
      id: true,
      name: true,
      slug: true,
      code: true,
    },
  });

  if (!region) {
    return res.status(400).json({ error: 'Invalid region selected' });
  }

  // Check email uniqueness
  const existingEmail = await prisma.user.findUnique({ where: { email } });
  if (existingEmail) {
    return res.status(400).json({ error: 'Email already in use' });
  }

  // Check username uniqueness
  const existingUsername = await prisma.user.findUnique({ where: { username } });
  if (existingUsername) {
    return res.status(400).json({ error: 'Username already in use' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);

    // Start a 14-day free trial (no card). Enforcement lives in entitlementService.
    const trialStartedAt = new Date();
    const trialEndsAt = new Date(
      trialStartedAt.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000
    );

    const user = await prisma.user.create({
      data: {
        email,
        username,
        passwordHash,
        regionId: region.id,
        trialStartedAt,
        trialEndsAt,
      },
      select: {
        id: true,
        email: true,
        username: true,
        role: true,
        regionId: true,
        trialEndsAt: true,
        region: {
          select: {
            id: true,
            name: true,
            slug: true,
            code: true,
          },
        },
      },
    });

    const token = jwt.sign({ userId: user.id }, config.jwtSecret, signOptions);

    res.json({
      token,
      user,
    });
  } catch (err: any) {
    // Prisma unique constraint fallback (race condition protection)
    if (err?.code === 'P2002') {
      const target = err?.meta?.target?.join?.(', ') || 'field';
      return res.status(400).json({ error: `Duplicate ${target}` });
    }

    console.error(err);
    return res.status(500).json({ error: 'Failed to register' });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body as {
    email?: string;
    password?: string;
  };

  if (!email || !password) {
    return res.status(400).json({ error: 'Missing email or password' });
  }

  const user = await prisma.user.findUnique({
    where: { email },
    include: {
      region: {
        select: {
          id: true,
          name: true,
          slug: true,
          code: true,
        },
      },
    },
  });

  if (!user) {
    return res.status(400).json({ error: 'Invalid credentials' });
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    return res.status(400).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign({ userId: user.id }, config.jwtSecret, signOptions);

  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
      regionId: user.regionId,
      region: user.region,
    },
  });
});

export default router;