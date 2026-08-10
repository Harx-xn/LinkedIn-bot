import { prisma } from '../prismaClient';
import { ContentService } from './contentService';
import { GenerativeImagesService } from './generativeImagesService';
import { decryptSecret, decryptSecretArray } from './secretCrypto';
import { finalizeGeneratedPostContent } from './postContentFormatting';
import type { GeneratedPostContent } from './generationTypes';
import { buildEffectiveBotStrategy, type EffectiveBotStrategy } from './botStrategyService';

export type BotVoice = {
  tone: string;
  description: string;
  backgroundImageUrl?: string;
  contactInfo: string | null;
  websiteUrl: string | null;
  includeContactInfo: boolean;
  includeWebsiteLink: boolean;
  niches: string[];
  sources?: string | null;
  strategy?: EffectiveBotStrategy;
};

export type NormalizeGeneratedOptions = {
  topic?: string;
  includeContactInfo?: boolean;
  includeWebsiteLink?: boolean;
  contactInfo?: string | null;
  websiteUrl?: string | null;
  description?: string | null;
};

export async function getDecryptedGeminiKeysForUser(userId: string): Promise<string[]> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { region: { select: { geminiApiKeys: true } } },
  });

  return decryptSecretArray(user?.region?.geminiApiKeys);
}

export async function getContentServiceForUser(userId: string): Promise<ContentService> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { region: { select: { openaiApiKey: true, geminiApiKeys: true } } },
  });

  return new ContentService({
    openaiApiKey: decryptSecret(user?.region?.openaiApiKey),
    geminiApiKeys: decryptSecretArray(user?.region?.geminiApiKeys),
  });
}

export async function getGenerativeImagesServiceForUser(
  userId: string,
): Promise<GenerativeImagesService> {
  const geminiApiKeys = await getDecryptedGeminiKeysForUser(userId);
  return new GenerativeImagesService({ geminiApiKeys });
}

export async function getBotVoice(userId: string): Promise<BotVoice> {
  const config = await prisma.botConfig.findUnique({
    where: { userId },
    select: {
      tone: true,
      description: true,
      backgroundImageUrl: true,
      contactInfo: true,
      websiteUrl: true,
      includeContactInfo: true,
      includeWebsiteLink: true,
      niches: true,
      sources: true,
      profilePositioning: true,
      targetAudience: true,
      contentGoals: true,
      contentPillars: true,
      topicRules: true,
      writingStyle: true,
    },
  });

  const strategy = buildEffectiveBotStrategy(config);
  const niches = [
    ...strategy.contentPillars.primaryPillars.map((pillar) => pillar.name),
    ...strategy.legacy.niches,
  ].filter((value, index, values) => value && values.indexOf(value) === index);

  return {
    tone: strategy.writingStyle.tone[0] || config?.tone || 'Conversational',
    description: strategy.profilePositioning.positioningStatement || config?.description || '',
    backgroundImageUrl: config?.backgroundImageUrl || undefined,
    contactInfo: config?.contactInfo || null,
    websiteUrl: config?.websiteUrl || null,
    includeContactInfo: config?.includeContactInfo ?? false,
    includeWebsiteLink: config?.includeWebsiteLink ?? false,
    niches,
    sources: config?.sources ?? null,
    strategy,
  };
}

export function normalizeGeneratedContent(
  generatedContent: GeneratedPostContent | unknown,
  fallbackContent: string,
  options: NormalizeGeneratedOptions = {},
) {
  return finalizeGeneratedPostContent(generatedContent, fallbackContent, {
    topic: options.topic,
    includeContactInfo: !!options.includeContactInfo,
    includeWebsiteLink: !!options.includeWebsiteLink,
    contactInfo: options.contactInfo,
    websiteUrl: options.websiteUrl,
    description: options.description,
  });
}

export function deriveTopicFromContent(content: string): string {
  const line = content
    .split('\n')
    .map((value) => value.trim())
    .find(Boolean);
  return (line ?? 'LinkedIn post').slice(0, 200);
}
