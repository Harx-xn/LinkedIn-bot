import crypto from 'crypto';
import { prisma } from '../../prismaClient';

export type OAuthStatePayload = {
  mode: 'login' | 'register';
  username?: string;
  regionId?: string;
  inviteCode?: string;
  promoCode?: string;
  redirectTo?: string;
  csrf: string;
};

const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

export async function createOAuthState(
  provider: string,
  payload: Omit<OAuthStatePayload, 'csrf'> & { csrf?: string },
): Promise<string> {
  const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS);
  const fullPayload: OAuthStatePayload = {
    ...payload,
    csrf: payload.csrf || crypto.randomBytes(16).toString('hex'),
  };

  const record = await prisma.oAuthState.create({
    data: {
      provider,
      payload: fullPayload,
      expiresAt,
    },
  });

  return record.id;
}

export async function consumeOAuthState(
  provider: string,
  stateId: string,
): Promise<OAuthStatePayload> {
  const record = await prisma.oAuthState.findUnique({ where: { id: stateId } });
  if (!record) {
    throw new Error('Invalid or expired OAuth state');
  }

  if (record.provider !== provider) {
    throw new Error('OAuth provider mismatch');
  }

  if (record.expiresAt.getTime() < Date.now()) {
    await prisma.oAuthState.delete({ where: { id: stateId } }).catch(() => undefined);
    throw new Error('OAuth state expired');
  }

  await prisma.oAuthState.delete({ where: { id: stateId } });

  return record.payload as OAuthStatePayload;
}

export function parseSocialStartQuery(query: Record<string, unknown>): {
  mode: 'login' | 'register';
  username?: string;
  regionId?: string;
  inviteCode?: string;
  promoCode?: string;
  redirectTo?: string;
} {
  const modeRaw = typeof query.mode === 'string' ? query.mode.trim().toLowerCase() : 'login';
  const mode = modeRaw === 'register' ? 'register' : 'login';

  const pick = (key: string) => {
    const value = query[key];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };

  return {
    mode,
    username: pick('username'),
    regionId: pick('regionId'),
    inviteCode: pick('inviteCode'),
    promoCode: pick('promoCode'),
    redirectTo: pick('redirectTo'),
  };
}
