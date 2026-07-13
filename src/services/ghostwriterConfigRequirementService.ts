import { prisma } from '../prismaClient';
import { buildEffectiveBotStrategy } from './botStrategyService';
import { getStrategyNiches, hasStrategyGenerationContext } from './botStrategyTrendService';

export const GHOSTWRITER_CONFIG_REQUIRED_CODE =
  'GHOSTWRITER_CONFIG_REQUIRED';
export const GHOSTWRITER_CONFIG_REQUIRED_MESSAGE =
  'Save your ghostwriter profile with a description before generating content.';
export const GHOSTWRITER_NICHES_REQUIRED_MESSAGE =
  'Save at least one ghostwriter niche before fetching trends or generating a batch.';

export function hasGhostwriterDescription(
  description?: string | null,
): boolean {
  return Boolean(description?.trim());
}

export function parseSavedGhostwriterNiches(
  niches?: string | null,
): string[] {
  if (!niches?.trim()) return [];

  try {
    const parsed = JSON.parse(niches);
    const values = Array.isArray(parsed) ? parsed : [parsed];
    return values
      .filter((value): value is string => typeof value === 'string')
      .map(value => value.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function getSavedGhostwriterRequirements(userId: string) {
  const config = await prisma.botConfig.findUnique({
    where: { userId },
  });
  const strategy = buildEffectiveBotStrategy(config);

  return {
    hasDescription: hasStrategyGenerationContext(strategy),
    niches: getStrategyNiches(strategy),
  };
}

export async function hasSavedGhostwriterDescription(
  userId: string,
): Promise<boolean> {
  const config = await prisma.botConfig.findUnique({
    where: { userId },
  });
  const strategy = buildEffectiveBotStrategy(config);

  return hasStrategyGenerationContext(strategy);
}
