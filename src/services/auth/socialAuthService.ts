import axios from 'axios';
import { google } from 'googleapis';
import { config } from '../../config';
import { prisma } from '../../prismaClient';
import {
  AuthValidationError,
  createSocialUser,
  findUserForAuthResponse,
  issueJwt,
  linkAuthProviderAccount,
  validateRegistrationContext,
  type AuthUserResponse,
} from './authHelpers';
import { consumeOAuthState, type OAuthStatePayload } from './oauthStateService';

export type SocialProvider = 'google' | 'linkedin';

export type SocialProfile = {
  providerAccountId: string;
  email: string;
  emailVerified: boolean;
  name?: string;
};

export type SocialAuthSuccess = {
  token: string;
  user: AuthUserResponse;
  isNewUser: boolean;
  effectivePromoCode?: string;
  inviteCode?: string;
  redirectTo?: string;
};

const GOOGLE_AUTH_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

const LINKEDIN_SIGNIN_SCOPES = ['openid', 'profile', 'email'];

function getGoogleAuthClient() {
  return new google.auth.OAuth2(
    config.googleAuth.clientId,
    config.googleAuth.clientSecret,
    config.googleAuth.redirectUri,
  );
}

export function assertGoogleAuthConfigured() {
  if (!config.googleAuth.clientId || !config.googleAuth.clientSecret || !config.googleAuth.redirectUri) {
    throw new Error('Google sign-in is not configured');
  }
}

export function assertLinkedInAuthConfigured() {
  if (
    !config.linkedinAuth.clientId ||
    !config.linkedinAuth.clientSecret ||
    !config.linkedinAuth.redirectUri
  ) {
    throw new Error('LinkedIn sign-in is not configured');
  }
}

export function getGoogleSignInUrl(state: string): string {
  assertGoogleAuthConfigured();
  const client = getGoogleAuthClient();
  return client.generateAuthUrl({
    access_type: 'online',
    prompt: 'select_account',
    scope: GOOGLE_AUTH_SCOPES,
    state,
  });
}

export function getLinkedInSignInUrl(state: string): string {
  assertLinkedInAuthConfigured();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.linkedinAuth.clientId,
    redirect_uri: config.linkedinAuth.redirectUri,
    scope: LINKEDIN_SIGNIN_SCOPES.join(' '),
    state,
  });
  return `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`;
}

export async function fetchGoogleProfile(code: string): Promise<SocialProfile> {
  assertGoogleAuthConfigured();
  const client = getGoogleAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.access_token) {
    throw new Error('Google did not return an access token');
  }

  const { data } = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  const email = typeof data.email === 'string' ? data.email : '';
  const providerAccountId = typeof data.sub === 'string' ? data.sub : '';
  const emailVerified = data.email_verified === true;

  if (!providerAccountId || !email) {
    throw new Error('Google profile is missing required account information');
  }

  return {
    providerAccountId,
    email,
    emailVerified,
    name: typeof data.name === 'string' ? data.name : undefined,
  };
}

export async function fetchLinkedInProfile(code: string): Promise<SocialProfile> {
  assertLinkedInAuthConfigured();
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.linkedinAuth.redirectUri,
    client_id: config.linkedinAuth.clientId,
    client_secret: config.linkedinAuth.clientSecret,
  });

  const tokenRes = await axios.post(
    'https://www.linkedin.com/oauth/v2/accessToken',
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );

  const accessToken = tokenRes.data?.access_token as string | undefined;
  if (!accessToken) {
    throw new Error('LinkedIn did not return an access token');
  }

  const { data } = await axios.get('https://api.linkedin.com/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const email = typeof data.email === 'string' ? data.email : '';
  const providerAccountId = typeof data.sub === 'string' ? data.sub : '';
  const emailVerified = data.email_verified === true || !!email;

  if (!providerAccountId) {
    throw new Error('LinkedIn profile is missing required account information');
  }

  if (!email) {
    throw new Error('LinkedIn did not return an email address for this account');
  }

  return {
    providerAccountId,
    email,
    emailVerified,
    name: typeof data.name === 'string' ? data.name : undefined,
  };
}

async function loadExistingProviderUser(provider: SocialProvider, providerAccountId: string) {
  const account = await prisma.authProviderAccount.findUnique({
    where: {
      provider_providerAccountId: {
        provider,
        providerAccountId,
      },
    },
    select: { userId: true },
  });

  if (!account) return null;
  return findUserForAuthResponse(account.userId);
}

async function linkProviderToExistingUser(
  provider: SocialProvider,
  profile: SocialProfile,
  userId: string,
) {
  await linkAuthProviderAccount({
    userId,
    provider,
    providerAccountId: profile.providerAccountId,
    email: profile.email,
  });
  const user = await findUserForAuthResponse(userId);
  if (!user) {
    throw new Error('Linked user account could not be loaded');
  }
  return user;
}

export async function completeSocialAuth(
  provider: SocialProvider,
  profile: SocialProfile,
  state: OAuthStatePayload,
): Promise<SocialAuthSuccess> {
  if (!profile.emailVerified) {
    throw new AuthValidationError('Your provider email address is not verified');
  }

  const existingProviderUser = await loadExistingProviderUser(provider, profile.providerAccountId);
  if (existingProviderUser) {
    return {
      token: issueJwt(existingProviderUser.id),
      user: existingProviderUser,
      isNewUser: false,
      redirectTo: state.redirectTo,
    };
  }

  const existingEmailUser = await prisma.user.findUnique({
    where: { email: profile.email },
    select: { id: true },
  });

  if (existingEmailUser) {
    const user = await linkProviderToExistingUser(provider, profile, existingEmailUser.id);
    return {
      token: issueJwt(user.id),
      user,
      isNewUser: false,
      redirectTo: state.redirectTo,
    };
  }

  // Google login and signup intentionally share account-creation semantics.
  // Without an invite, identity details are completed after OAuth in onboarding.
  const registration = state.inviteCode
    ? await validateRegistrationContext({
        inviteCode: state.inviteCode,
        promoCode: state.promoCode,
        providerEmail: profile.email,
        requireUsername: false,
        promoOrder: 'social',
      })
    : null;

  let user: AuthUserResponse;
  try {
    user = await createSocialUser({
      email: profile.email,
      regionId: registration?.region.id ?? null,
      invite: registration?.invite ?? null,
    });
  } catch (error) {
    const prismaError = error as { code?: string };
    if (prismaError.code !== 'P2002' && !(error instanceof AuthValidationError && error.message === 'Email already in use')) throw error;
    const raced = await prisma.user.findUnique({ where: { email: profile.email }, select: { id: true } });
    if (!raced) throw error;
    user = await linkProviderToExistingUser(provider, profile, raced.id);
    return { token: issueJwt(user.id), user, isNewUser: false, redirectTo: state.redirectTo };
  }

  await linkAuthProviderAccount({
    userId: user.id,
    provider,
    providerAccountId: profile.providerAccountId,
    email: profile.email,
  });

  return {
    token: issueJwt(user.id),
    user,
    isNewUser: true,
    effectivePromoCode: registration?.effectivePromoCode ?? state.promoCode,
    inviteCode: state.inviteCode,
    redirectTo: state.redirectTo,
  };
}

export function buildSocialSuccessRedirect(result: SocialAuthSuccess): string {
  const basePath = result.redirectTo || '/auth/social/callback';
  const url = new URL(
    basePath.startsWith('http') ? basePath : `${config.frontendUrl}${basePath}`,
  );
  url.searchParams.set('token', result.token);
  if (result.isNewUser) {
    url.searchParams.set('isNewUser', '1');
  }
  if (result.effectivePromoCode) {
    url.searchParams.set('promoCode', result.effectivePromoCode);
  }
  if (result.inviteCode) {
    url.searchParams.set('inviteCode', result.inviteCode);
  }
  return url.toString();
}

export function buildSocialErrorRedirect(message: string): string {
  const url = new URL(`${config.frontendUrl}/login`);
  url.searchParams.set('error', message);
  return url.toString();
}

export async function handleSocialCallback(
  provider: SocialProvider,
  code: string | undefined,
  stateId: string | undefined,
  fetchProfile: (authCode: string) => Promise<SocialProfile>,
): Promise<string> {
  if (!code || !stateId) {
    return buildSocialErrorRedirect('Missing OAuth code or state');
  }

  try {
    const state = await consumeOAuthState(provider, stateId);
    const profile = await fetchProfile(code);
    const result = await completeSocialAuth(provider, profile, state);
    return buildSocialSuccessRedirect(result);
  } catch (err) {
    const message =
      err instanceof AuthValidationError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Social sign-in failed';
    console.error(`[auth/${provider}] callback error:`, message);
    return buildSocialErrorRedirect(message);
  }
}
