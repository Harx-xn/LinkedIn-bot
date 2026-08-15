import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { BillingAccessStatus } from '@prisma/client';
import { config } from '../../config';
import { prisma } from '../../prismaClient';
import { getBooleanSetting } from '../settingsService';
import { findValidPromotion } from '../promotionService';
import { findValidInvite, redeemInvite } from '../inviteService';

const signOptions: jwt.SignOptions = {
  expiresIn: config.jwtExpiresIn as jwt.SignOptions['expiresIn'],
};

const USER_SELECT = {
  id: true,
  email: true,
  username: true,
  role: true,
  isActive: true,
  regionId: true,
  trialEndsAt: true,
  isBillingExempt: true,
  hasCompletedProfileOnboarding: true,
  needsIdentityOnboarding: true,
  botConfigs: { select: { description: true, niches: true } },
  region: {
    select: {
      id: true,
      name: true,
      slug: true,
      code: true,
    },
  },
} as const;

export type AuthUserResponse = {
  id: string;
  email: string;
  username: string;
  role: string;
  regionId: string | null;
  trialEndsAt?: Date | null;
  isBillingExempt: boolean;
  hasCompletedProfileOnboarding: boolean;
  needsIdentityOnboarding: boolean;
  effectiveAccess: {
    hasAccess: boolean;
    unlimited: boolean;
    billingExempt: boolean;
    accessSource: 'BILLING_EXEMPT' | 'PRIVILEGED_ROLE' | 'STANDARD';
  };
  region: {
    id: string;
    name: string;
    slug: string;
    code: string;
  } | null;
};

export class AuthValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthValidationError';
  }
}

export function isValidUsername(username: string): boolean {
  const value = username.trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9_. ]{2,19}$/.test(value);
}

export function issueJwt(userId: string): string {
  return jwt.sign({ userId }, config.jwtSecret, signOptions);
}

export function buildAuthUserResponse(user: {
  id: string;
  email: string;
  username: string;
  role: string;
  regionId: string | null;
  trialEndsAt?: Date | null;
  isBillingExempt: boolean;
  region: AuthUserResponse['region'];
  hasCompletedProfileOnboarding: boolean;
  needsIdentityOnboarding: boolean;
  botConfigs?: { description?: string | null; niches?: string | null } | null;
}): AuthUserResponse {
  const meaningfulProfile = Boolean(
    user.botConfigs && (user.botConfigs.description?.trim().length ?? 0) >= 20 &&
    user.botConfigs.niches && user.botConfigs.niches !== '[]',
  );
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    role: user.role,
    regionId: user.regionId,
    trialEndsAt: user.trialEndsAt ?? null,
    isBillingExempt: user.isBillingExempt,
    hasCompletedProfileOnboarding: user.hasCompletedProfileOnboarding || meaningfulProfile,
    needsIdentityOnboarding: user.needsIdentityOnboarding,
    effectiveAccess: user.isBillingExempt
      ? { hasAccess: true, unlimited: true, billingExempt: true, accessSource: 'BILLING_EXEMPT' }
      : {
          hasAccess: user.role !== 'USER',
          unlimited: user.role !== 'USER',
          billingExempt: false,
          accessSource: user.role !== 'USER' ? 'PRIVILEGED_ROLE' : 'STANDARD',
        },
    region: user.region,
  };
}

export async function createUniqueUsernameFromEmail(email: string): Promise<string> {
  const localPart = email.split('@')[0] || 'user';
  let base = localPart
    .toLowerCase()
    .replace(/[^a-z0-9_.]/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!base || !/^[a-z0-9]/.test(base)) {
    base = `user_${base}`;
  }
  if (base.length < 3) {
    base = `${base}_user`.slice(0, 20);
  }
  if (base.length > 20) {
    base = base.slice(0, 20);
  }

  for (let attempt = 0; attempt < 25; attempt += 1) {
    const suffix = attempt === 0 ? '' : `_${attempt}`;
    const trimmedBase = base.slice(0, Math.max(3, 20 - suffix.length));
    const candidate = `${trimmedBase}${suffix}`;
    if (!isValidUsername(candidate)) continue;

    const existing = await prisma.user.findUnique({ where: { username: candidate } });
    if (!existing) return candidate;
  }

  const fallback = `user_${crypto.randomBytes(4).toString('hex')}`;
  return fallback.slice(0, 20);
}

type PromoOrder = 'register' | 'social';

export type RegistrationContextInput = {
  username?: string;
  regionId?: string;
  inviteCode?: string;
  promoCode?: string;
  providerEmail?: string;
  requireUsername?: boolean;
  promoOrder?: PromoOrder;
};

export type ValidatedRegistrationContext = {
  username?: string;
  region: {
    id: string;
    name: string;
    slug: string;
    code: string;
  };
  invite: Awaited<ReturnType<typeof findValidInvite>>;
  effectivePromoCode?: string;
  resolvedRegionId: string;
};

function resolveEffectivePromoCode(
  promoOrder: PromoOrder,
  promoCode?: string,
  invitePromoCode?: string | null,
): string | undefined {
  if (promoOrder === 'social') {
    return invitePromoCode || promoCode || undefined;
  }
  return promoCode || invitePromoCode || undefined;
}

export { resolveEffectivePromoCode };

export async function validateRegistrationContext(
  input: RegistrationContextInput,
): Promise<ValidatedRegistrationContext> {
  const invite = await findValidInvite(input.inviteCode);
  const resolvedRegionId = invite?.regionId || input.regionId;

  if (!resolvedRegionId) {
    throw new AuthValidationError('Please select a region or use a valid invite link');
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
    throw new AuthValidationError('Invalid region selected');
  }

  const inviteOnly = await getBooleanSetting('auth.inviteOnly', region.id, false);
  if (inviteOnly && !invite) {
    throw new AuthValidationError('This region currently requires an invite link to register');
  }

  if (input.providerEmail && invite?.email) {
    if (invite.email.toLowerCase() !== input.providerEmail.toLowerCase()) {
      throw new AuthValidationError('This invite link is restricted to another email address');
    }
  }

  const promoOrder = input.promoOrder || 'register';
  const effectivePromoCode = resolveEffectivePromoCode(
    promoOrder,
    input.promoCode,
    invite?.promoCode,
  );

  if (effectivePromoCode) {
    const promo = await findValidPromotion(effectivePromoCode, { regionId: region.id });
    if (!promo) {
      throw new AuthValidationError('Promotion code is not valid');
    }
  }

  if (input.username) {
    if (!isValidUsername(input.username)) {
      throw new AuthValidationError(
        'Invalid username (3–20 chars; letters, numbers, spaces, underscore, or dot; must start with a letter or number)',
      );
    }

    const existingUsername = await prisma.user.findUnique({
      where: { username: input.username },
    });
    if (existingUsername) {
      throw new AuthValidationError('Username already in use');
    }
  } else if (input.requireUsername) {
    throw new AuthValidationError('Username is required');
  }

  return {
    username: input.username,
    region,
    invite,
    effectivePromoCode,
    resolvedRegionId: region.id,
  };
}

export async function createSocialUser(params: {
  email: string;
  username?: string;
  regionId?: string | null;
  invite: Awaited<ReturnType<typeof findValidInvite>>;
}): Promise<AuthUserResponse> {
  const existingEmail = await prisma.user.findUnique({ where: { email: params.email } });
  if (existingEmail) {
    throw new AuthValidationError('Email already in use');
  }

  const username =
    params.username || (await createUniqueUsernameFromEmail(params.email));

  if (!isValidUsername(username)) {
    throw new AuthValidationError('Could not derive a valid username for this account');
  }

  const existingUsername = await prisma.user.findUnique({ where: { username } });
  if (existingUsername) {
    throw new AuthValidationError('Username already in use');
  }

  const user = await prisma.user.create({
    data: {
      email: params.email,
      username,
      passwordHash: null,
      regionId: params.regionId,
      needsIdentityOnboarding: true,
      role: params.invite?.roleToAssign || undefined,
      billingAccessStatus: BillingAccessStatus.BILLING_REQUIRED,
    },
    select: USER_SELECT,
  });

  if (params.invite) {
    await redeemInvite(params.invite.id, user.id);
  }

  return buildAuthUserResponse(user);
}

export async function linkAuthProviderAccount(params: {
  userId: string;
  provider: string;
  providerAccountId: string;
  email?: string | null;
}) {
  return prisma.authProviderAccount.upsert({
    where: {
      provider_providerAccountId: {
        provider: params.provider,
        providerAccountId: params.providerAccountId,
      },
    },
    create: {
      userId: params.userId,
      provider: params.provider,
      providerAccountId: params.providerAccountId,
      email: params.email || null,
    },
    update: {
      userId: params.userId,
      email: params.email || null,
    },
  });
}

export async function findUserForAuthResponse(userId: string): Promise<AuthUserResponse | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: USER_SELECT,
  });
  if (!user) return null;
  if (!user.isActive) throw new AuthValidationError('Account inactive or not found');
  return buildAuthUserResponse(user);
}

export { USER_SELECT };
