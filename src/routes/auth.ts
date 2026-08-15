import { Router, Request, Response } from 'express';
import { prisma } from '../prismaClient';
import bcrypt from 'bcryptjs';
import { BillingAccessStatus } from '@prisma/client';
import { redeemInvite } from '../services/inviteService';
import {
  AuthValidationError,
  buildAuthUserResponse,
  issueJwt,
  USER_SELECT,
  validateRegistrationContext,
} from '../services/auth/authHelpers';
import {
  createOAuthState,
  parseSocialStartQuery,
} from '../services/auth/oauthStateService';
import {
  assertGoogleAuthConfigured,
  // assertLinkedInAuthConfigured,
  buildSocialErrorRedirect,
  fetchGoogleProfile,
  // fetchLinkedInProfile,
  getGoogleSignInUrl,
  // getLinkedInSignInUrl,
  handleSocialCallback,
} from '../services/auth/socialAuthService';

const router = Router();

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

  if (!email.includes('@')) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  if (password.length < 6) {
    return res
      .status(400)
      .json({ error: 'Password must be at least 6 characters' });
  }

  try {
    const registration = await validateRegistrationContext({
      username,
      regionId,
      inviteCode,
      promoCode,
      providerEmail: email,
      requireUsername: true,
      promoOrder: 'register',
    });

    const existingEmail = await prisma.user.findUnique({ where: { email } });
    if (existingEmail) {
      return res.status(400).json({ error: 'Email already in use' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        email,
        username: registration.username!,
        passwordHash,
        regionId: registration.region.id,
        role: registration.invite?.roleToAssign || undefined,
        billingAccessStatus: BillingAccessStatus.BILLING_REQUIRED,
      },
      select: USER_SELECT,
    });

    if (registration.invite) {
      await redeemInvite(registration.invite.id, user.id);
    }

    res.json({
      token: issueJwt(user.id),
      user: buildAuthUserResponse(user),
    });
  } catch (err: unknown) {
    if (err instanceof AuthValidationError) {
      const status = err.message.includes('invite link to register') ? 403 : 400;
      if (err.message.includes('restricted to another email')) {
        return res.status(403).json({ error: err.message });
      }
      return res.status(status).json({ error: err.message });
    }

    const anyErr = err as { code?: string; meta?: { target?: string[] } };
    if (anyErr?.code === 'P2002') {
      const target = anyErr?.meta?.target?.join?.(', ') || 'field';
      return res.status(400).json({ error: `Duplicate ${target}` });
    }

    console.error('[auth/register] error:', err);
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
      botConfigs: { select: { description: true, niches: true } },
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

  if (!user.passwordHash) {
    return res.status(400).json({
      error: 'This account uses social login. Please sign in with Google.',
    });
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    return res.status(400).json({ error: 'Invalid credentials' });
  }

  res.json({
    token: issueJwt(user.id),
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
      isBillingExempt: user.isBillingExempt,
      hasCompletedProfileOnboarding:
        user.hasCompletedProfileOnboarding ||
        Boolean(user.botConfigs && (user.botConfigs.description?.trim().length ?? 0) >= 20 && user.botConfigs.niches !== '[]'),
      needsIdentityOnboarding: user.needsIdentityOnboarding,
      effectiveAccess: user.isBillingExempt
        ? { hasAccess: true, unlimited: true, billingExempt: true, accessSource: 'BILLING_EXEMPT' }
        : { hasAccess: user.role !== 'USER', unlimited: user.role !== 'USER', billingExempt: false, accessSource: user.role !== 'USER' ? 'PRIVILEGED_ROLE' : 'STANDARD' },
      regionId: user.regionId,
      region: user.region,
    },
  });
});

async function startSocialAuth(
  req: Request,
  res: Response,
  provider: 'google' | 'linkedin',
  getUrl: (state: string) => string,
  assertConfigured: () => void,
) {
  try {
    assertConfigured();
    const query = parseSocialStartQuery(req.query as Record<string, unknown>);
    const stateId = await createOAuthState(provider, query);
    const url = getUrl(stateId);
    return res.redirect(url);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : `${provider} sign-in is not available`;
    console.error(`[auth/${provider}/start] error:`, message);
    return res.redirect(buildSocialErrorRedirect(message));
  }
}

router.get('/google/start', (req, res) =>
  startSocialAuth(req, res, 'google', getGoogleSignInUrl, assertGoogleAuthConfigured),
);

router.get('/google/callback', async (req, res) => {
  const { code, state } = req.query as { code?: string; state?: string };
  const redirectUrl = await handleSocialCallback('google', code, state, fetchGoogleProfile);
  return res.redirect(redirectUrl);
});

// LinkedIn sign-in disabled for now — re-enable when LINKEDIN_AUTH_REDIRECT_URI is configured.
// router.get('/linkedin/start', (req, res) =>
//   startSocialAuth(req, res, 'linkedin', getLinkedInSignInUrl, assertLinkedInAuthConfigured),
// );
//
// router.get('/linkedin/callback', async (req, res) => {
//   const { code, state } = req.query as { code?: string; state?: string };
//   const redirectUrl = await handleSocialCallback('linkedin', code, state, fetchLinkedInProfile);
//   return res.redirect(redirectUrl);
// });

export default router;
