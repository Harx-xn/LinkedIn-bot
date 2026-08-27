import { Prisma, UserRole } from '@prisma/client';
import { prisma } from '../prismaClient';
import { hasDashboardAccess } from './billing/billingAccessService';
import { buildEffectiveBotStrategy, syncPrimaryPillarsToNiches } from './botStrategyService';
import { checkSafeForWorkText } from '../utils/contentSafety';
import OpenAI from 'openai';
import { extractOpenAiUsage, trackAiProviderCall, withAiCostContext, createGenerationId } from './costIntelligence/aiCostTrackingService';
import { decryptSecret } from './secretCrypto';
import { AuthValidationError, isValidUsername, validateRegistrationContext } from './auth/authHelpers';
import { redeemInvite } from './inviteService';

export const PROFILE_GOALS = [
  'Build authority', 'Generate leads', 'Educate my audience',
  'Grow my professional network', 'Promote my services or product',
  'Attract partnerships', 'Recruit talent',
] as const;

export interface ProfileOnboardingPayload {
  username?: string;
  regionId?: string;
  inviteCode?: string;
  promoCode?: string;
  description: string;
  goals: string[];
  customGoal?: string;
  targetAudience: string[];
  niches: string[];
}

export class ProfileOnboardingError extends Error {
  constructor(public status: number, public code: string, public fields: Record<string, string>) {
    super(code === 'UNSAFE_ONBOARDING_CONTENT'
      ? 'Some profile information contains language that is not allowed.'
      : 'Please correct the highlighted fields.');
  }
}

function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }

export function validateProfileOnboarding(raw: unknown): ProfileOnboardingPayload {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const description = text(body.description);
  const customGoal = text(body.customGoal);
  const rawAudience = Array.isArray(body.targetAudience)
    ? body.targetAudience.map(text).filter(Boolean)
    : text(body.targetAudience).split(',').map((item) => item.trim()).filter(Boolean);
  const targetAudience = Array.from(new Map(rawAudience.map((item) => [item.toLocaleLowerCase(), item])).values());
  const goals = Array.isArray(body.goals)
    ? body.goals.map(text).filter((goal) => (PROFILE_GOALS as readonly string[]).includes(goal))
    : [];
  const rawNiches = Array.isArray(body.niches) ? body.niches.map(text).filter(Boolean) : [];
  const niches = Array.from(new Map(rawNiches.map((niche) => [niche.toLocaleLowerCase(), niche])).values());
  const fields: Record<string, string> = {};

  if (description.length < 20) fields.description = 'Please describe what you do using at least 20 characters.';
  else if (description.length > 600) fields.description = 'Description must be 600 characters or fewer.';
  if (goals.length === 0 && !customGoal) fields.goals = 'Select at least one LinkedIn goal.';
  if (customGoal.length > 200) fields.goals = 'Other goal must be 200 characters or fewer.';
  if (rawAudience.length === 0) fields.targetAudience = 'Add at least one target audience.';
  else if (rawAudience.length > 3) fields.targetAudience = 'You can add a maximum of three audiences.';
  else if (targetAudience.length !== rawAudience.length) fields.targetAudience = 'Remove duplicate audiences.';
  else if (targetAudience.some((item) => item.length > 100)) fields.targetAudience = 'Each audience must be 100 characters or fewer.';
  if (rawNiches.length === 0) fields.niches = 'Add at least one niche.';
  else if (rawNiches.length > 3) fields.niches = 'You can add a maximum of three niches.';
  else if (niches.length !== rawNiches.length) fields.niches = 'Remove duplicate niches.';
  else if (niches.some((niche) => niche.length > 60)) fields.niches = 'Each niche must be 60 characters or fewer.';
  if (Object.keys(fields).length) throw new ProfileOnboardingError(400, 'INVALID_ONBOARDING_PROFILE', fields);

  const safetyFields: Record<string, string> = {};
  const check = (field: string, value: string) => {
    if (value && !checkSafeForWorkText(value).safe) safetyFields[field] = 'Please remove inappropriate or explicit language.';
  };
  check('description', description); check('goals', customGoal); targetAudience.forEach((item) => check('targetAudience', item));
  niches.forEach((niche) => check('niches', niche));
  if (Object.keys(safetyFields).length) throw new ProfileOnboardingError(422, 'UNSAFE_ONBOARDING_CONTENT', safetyFields);
  return { description, goals, ...(customGoal ? { customGoal } : {}), targetAudience, niches };
}

const GOAL_MAP: Record<string, string> = {
  'Build authority': 'authority', 'Generate leads': 'leads', 'Educate my audience': 'education',
  'Grow my professional network': 'community', 'Promote my services or product': 'product_awareness',
  'Recruit talent': 'hiring', 'Attract partnerships': 'leads',
};

export async function saveProfileOnboarding(userId: string, raw: unknown) {
  const payload = validateProfileOnboarding(raw);
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, regionId: true, username: true, email: true, needsIdentityOnboarding: true },
  });
  if (!user) throw new ProfileOnboardingError(404, 'USER_NOT_FOUND', {});
  if (user.role !== UserRole.USER) throw new ProfileOnboardingError(403, 'PROFILE_ONBOARDING_NOT_AVAILABLE', {});
  let identity: { username: string; regionId: string; inviteId?: string } | null = null;
  if (user.needsIdentityOnboarding) {
    const username = text(body.username);
    const requestedRegionId = text(body.regionId);
    const inviteCode = text(body.inviteCode);
    const promoCode = text(body.promoCode);
    const fields: Record<string, string> = {};
    if (!username || !isValidUsername(username)) fields.username = 'Choose a valid username using 3–20 allowed characters.';
    if (!user.regionId && !requestedRegionId && !inviteCode) fields.regionId = 'Select your billing region.';
    if (Object.keys(fields).length) throw new ProfileOnboardingError(400, 'INVALID_ONBOARDING_IDENTITY', fields);
    try {
      const registration = await validateRegistrationContext({
        username: username !== user.username ? username : undefined,
        regionId: user.regionId ?? requestedRegionId,
        inviteCode: user.regionId ? undefined : inviteCode || undefined,
        promoCode: promoCode || undefined,
        requireUsername: false,
        providerEmail: user.email,
        promoOrder: 'social',
      });
      identity = { username, regionId: registration.region.id, inviteId: registration.invite?.id };
    } catch (error) {
      if (error instanceof AuthValidationError) {
        const field = error.message.toLowerCase().includes('username') ? 'username' : 'regionId';
        throw new ProfileOnboardingError(400, 'INVALID_ONBOARDING_IDENTITY', { [field]: error.message });
      }
      throw error;
    }
  }
  const dashboardAccess = await hasDashboardAccess(userId);

  await prisma.$transaction(async (tx) => {
    const existing = await tx.botConfig.findUnique({ where: { userId } });
    const effective = buildEffectiveBotStrategy(existing ?? { niches: '[]', sources: '["automatic"]' });
    const allGoals = [...payload.goals, ...(payload.customGoal ? [payload.customGoal] : [])];
    const primaryGoal = (GOAL_MAP[payload.goals[0]] ?? 'authority') as any;
    const pillars = syncPrimaryPillarsToNiches(effective.contentPillars, payload.niches);
    const configData = {
      regionId: identity?.regionId ?? user.regionId,
      description: payload.description,
      niches: JSON.stringify(payload.niches),
      sources: '["automatic"]',
      profilePositioning: { ...effective.profilePositioning, positioningStatement: payload.description, topicsToBeKnownFor: payload.niches } as Prisma.InputJsonValue,
      targetAudience: {
        ...effective.targetAudience,
        primaryAudience: payload.targetAudience[0] ?? '',
        secondaryAudiences: payload.targetAudience.slice(1),
        roles: payload.targetAudience,
      } as Prisma.InputJsonValue,
      contentGoals: { ...effective.contentGoals, primaryGoal, secondaryGoals: allGoals.slice(1), conversionTarget: allGoals.join('; ') } as Prisma.InputJsonValue,
      contentPillars: pillars as Prisma.InputJsonValue,
      topicRules: effective.topicRules as Prisma.InputJsonValue,
      writingStyle: effective.writingStyle as Prisma.InputJsonValue,
      onboardingStatus: 'COMPLETE',
    };
    await tx.botConfig.upsert({
      where: { userId },
      create: {
        userId,
        timeSlots: ['09:00'],
        imageMode: 'none',
        backgroundImageUrl: null,
        brandLogoEnabled: false,
        includeContactInfo: false,
        includeWebsiteLink: false,
        contactInfo: null,
        websiteUrl: null,
        ...configData,
      },
      update: configData,
    });
    await tx.user.update({
      where: { id: userId },
      data: {
        hasCompletedProfileOnboarding: true,
        ...(identity ? { username: identity.username, regionId: identity.regionId, needsIdentityOnboarding: false } : {}),
      },
    });
  });
  if (identity?.inviteId) await redeemInvite(identity.inviteId, userId);
  return {
    success: true,
    hasCompletedProfileOnboarding: true,
    redirectTo: dashboardAccess ? '/dashboard' : '/billing?startTrial=1',
  } as const;
}

export function hasMeaningfulGhostwriterProfile(config: { description?: string | null; niches?: string | null } | null): boolean {
  if (!config || (config.description?.trim().length ?? 0) < 20) return false;
  try { return Array.isArray(JSON.parse(config.niches || '[]')) && JSON.parse(config.niches || '[]').length > 0; }
  catch { return Boolean(config.niches?.trim()); }
}

export async function enhanceProfileDescription(userId: string, rawDescription: unknown): Promise<string> {
  const description = text(rawDescription);
  if (description.length < 20 || description.length > 600) {
    throw new ProfileOnboardingError(400, 'INVALID_ONBOARDING_PROFILE', {
      description: 'Enter at least 20 characters before enhancing your description.',
    });
  }
  if (!checkSafeForWorkText(description).safe) {
    throw new ProfileOnboardingError(422, 'UNSAFE_ONBOARDING_CONTENT', {
      description: 'Please remove inappropriate or explicit language.',
    });
  }
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, region: { select: { openaiApiKey: true } } },
  });
  if (!user || user.role !== UserRole.USER) throw new ProfileOnboardingError(403, 'PROFILE_ONBOARDING_NOT_AVAILABLE', {});
  const apiKey = decryptSecret(user.region?.openaiApiKey) || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('AI provider is not configured');
  const client = new OpenAI({ apiKey });
  const model = process.env.OPENAI_CONTENT_MODEL || 'gpt-4.1-mini';
  const response = await withAiCostContext({ userId, feature: 'CONTENT_INTELLIGENCE', operation: 'PROFILE_ENHANCE', agent: 'STRATEGY_ANALYZER', generationId: createGenerationId() }, () => trackAiProviderCall({
    provider: 'OPENAI', model, identity: { userId },
    invoke: () => client.chat.completions.create({
    model,
    temperature: 0.35,
    max_completion_tokens: 180,
    messages: [
      { role: 'system', content: 'Improve a short professional profile for a LinkedIn GhostWriter. Preserve the facts and first-person perspective. Make it clear, specific, natural, and concise. Do not invent credentials, results, clients, numbers, or claims. Return only the improved description, with no labels or quotation marks.' },
      { role: 'user', content: description },
    ],
    }), extractUsage: extractOpenAiUsage,
  }));
  const enhanced = response.choices[0]?.message?.content?.trim() || '';
  if (enhanced.length < 20 || enhanced.length > 600 || !checkSafeForWorkText(enhanced).safe) {
    throw new Error('AI returned an invalid profile description');
  }
  return enhanced;
}
