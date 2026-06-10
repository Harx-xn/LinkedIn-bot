import { Router } from 'express';
import { prisma } from '../prismaClient';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { BillingAccessStatus } from '@prisma/client';
import { getBooleanSetting } from '../services/settingsService';
import { findValidPromotion } from '../services/promotionService';
import { findValidInvite, redeemInvite } from '../services/inviteService';

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
  const { email, password, username, regionId, inviteCode, promoCode } = req.body as {
    email?: string;
    password?: string;
    username?: string;
    regionId?: string;
    inviteCode?: string;
    promoCode?: string;
  };

  if (!email || !password || !username) {
    return res
      .status(400)
      .json({ error: 'Missing email, password, or username' });
  }

  const invite = await findValidInvite(inviteCode);
  const resolvedRegionId = invite?.regionId || regionId;

  if (!resolvedRegionId) {
    return res.status(400).json({ error: 'Please select a region or use a valid invite link' });
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
      id: resolvedRegionId,
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

  const inviteOnly = await getBooleanSetting('auth.inviteOnly', region.id, false);
  if (inviteOnly && !invite) {
    return res.status(403).json({ error: 'This region currently requires an invite link to register' });
  }

  if (invite?.email && invite.email.toLowerCase() !== email.toLowerCase()) {
    return res.status(403).json({ error: 'This invite link is restricted to another email address' });
  }

  const effectivePromoCode = promoCode || invite?.promoCode || undefined;
  if (effectivePromoCode) {
    const promo = await findValidPromotion(effectivePromoCode, { regionId: region.id });
    if (!promo) {
      return res.status(400).json({ error: 'Promotion code is not valid' });
    }
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

    const user = await prisma.user.create({
      data: {
        email,
        username,
        passwordHash,
        regionId: region.id,
        role: invite?.roleToAssign || undefined,
        billingAccessStatus: BillingAccessStatus.BILLING_REQUIRED,
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

    if (invite) {
      await redeemInvite(invite.id, user.id);
    }

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