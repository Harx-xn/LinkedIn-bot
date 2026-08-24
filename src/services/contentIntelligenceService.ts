import { createHash } from 'crypto';
import OpenAI from 'openai';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../prismaClient';
import type { EffectiveBotStrategy } from './botStrategyService';

export type AuthorityMode = 'EXPLICIT_EXPERTISE' | 'SUPPORTED_PRACTITIONER' | 'INFERRED_FAMILIARITY' | 'EXPLORATORY' | 'UNKNOWN';
export type ContentIntelligenceProfile = {
  identity: { positioningSummary: string; contentPromise: string; identityThemes: string[]; expertiseSignals: string[]; explorationSignals: string[]; credibilityBoundaries: string[] };
  audienceModel: { segments: Array<{ name: string; likelyProblems: string[]; desiredOutcomes: string[]; likelyKnowledgeLevel?: string }> };
  authorityMap: Array<{ territory: string; mode: AuthorityMode; confidence: number; evidence: string[] }>;
  territoryMap: Array<{ pillar: string; territory: string; subterritories: string[]; audienceRelevance: string[]; ideaFamilies: string[]; weight: number }>;
  ideaStrategy: { preferredIdeaFamilies: string[]; avoidedIdeaPatterns: string[]; underusedPerspectives: string[] };
  distributionStrategy: { pillarWeights: Record<string, number>; territoryWeights: Record<string, number> };
  version: number;
  confidence: number;
};

const authorityMode = z.enum(['EXPLICIT_EXPERTISE', 'SUPPORTED_PRACTITIONER', 'INFERRED_FAMILIARITY', 'EXPLORATORY', 'UNKNOWN']);
const profileSchema: z.ZodType<ContentIntelligenceProfile> = z.object({
  identity: z.object({ positioningSummary: z.string(), contentPromise: z.string(), identityThemes: z.array(z.string()).max(12), expertiseSignals: z.array(z.string()).max(12), explorationSignals: z.array(z.string()).max(12), credibilityBoundaries: z.array(z.string()).max(12) }),
  audienceModel: z.object({ segments: z.array(z.object({ name: z.string(), likelyProblems: z.array(z.string()).max(12), desiredOutcomes: z.array(z.string()).max(12), likelyKnowledgeLevel: z.string().optional() })).max(12) }),
  authorityMap: z.array(z.object({ territory: z.string(), mode: authorityMode, confidence: z.number().min(0).max(1), evidence: z.array(z.string()).max(12) })).max(60),
  territoryMap: z.array(z.object({ pillar: z.string(), territory: z.string(), subterritories: z.array(z.string()).max(12), audienceRelevance: z.array(z.string()).max(12), ideaFamilies: z.array(z.string()).max(12), weight: z.number().positive() })).max(80),
  ideaStrategy: z.object({ preferredIdeaFamilies: z.array(z.string()).max(20), avoidedIdeaPatterns: z.array(z.string()).max(20), underusedPerspectives: z.array(z.string()).max(20) }),
  distributionStrategy: z.object({ pillarWeights: z.record(z.string(), z.number()), territoryWeights: z.record(z.string(), z.number()) }),
  version: z.number().int().positive(), confidence: z.number().min(0).max(1),
});

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
  return value;
}

export function contentIntelligenceInputFingerprint(strategy: EffectiveBotStrategy): string {
  const material = {
    profilePositioning: strategy.profilePositioning,
    targetAudience: strategy.targetAudience,
    contentGoals: strategy.contentGoals,
    contentPillars: strategy.contentPillars,
    topicRules: strategy.topicRules,
    tone: strategy.writingStyle.tone,
  };
  return createHash('sha256').update(JSON.stringify(stable(material))).digest('hex');
}

const genericFamilies = ['decision heuristic', 'hidden constraint', 'unexpected interaction', 'trade-off', 'misleading best practice', 'implementation lesson'];

export function buildFallbackContentIntelligence(strategy: EffectiveBotStrategy): ContentIntelligenceProfile {
  const pillars = [...strategy.contentPillars.primaryPillars, ...strategy.contentPillars.secondaryPillars, ...(strategy.contentPillars.experimentalPillars ?? [])];
  const share = pillars.length ? 1 / pillars.length : 1;
  const description = strategy.profilePositioning.positioningStatement.trim();
  const territoryMap = pillars.flatMap((pillar) => {
    const terms = [...new Set([pillar.name, ...(pillar.trendKeywords ?? []), ...(pillar.exampleAngles ?? [])])].slice(0, 6);
    return [{ pillar: pillar.name, territory: pillar.name, subterritories: terms, audienceRelevance: [pillar.audienceRelevance].filter(Boolean), ideaFamilies: genericFamilies, weight: share }];
  });
  return {
    identity: {
      positioningSummary: description,
      contentPromise: `Useful, specific perspectives for ${strategy.targetAudience.primaryAudience || 'the target audience'}.`,
      identityThemes: strategy.profilePositioning.topicsToBeKnownFor,
      expertiseSignals: description ? [description, ...(strategy.profilePositioning.credibilityPoints ?? [])] : [],
      explorationSignals: pillars.map((p) => p.name),
      credibilityBoundaries: ['Do not imply personal experience, clients, projects, results, or achievements unless explicitly supported.'],
    },
    audienceModel: { segments: [strategy.targetAudience.primaryAudience, ...(strategy.targetAudience.secondaryAudiences ?? [])].filter(Boolean).map((name) => ({ name, likelyProblems: strategy.targetAudience.painPoints ?? [], desiredOutcomes: strategy.targetAudience.desiredOutcomes ?? [], likelyKnowledgeLevel: strategy.targetAudience.knowledgeLevel })) },
    authorityMap: territoryMap.map((t) => ({ territory: t.territory, mode: description.toLowerCase().includes(t.pillar.toLowerCase()) ? 'INFERRED_FAMILIARITY' : 'EXPLORATORY', confidence: description.toLowerCase().includes(t.pillar.toLowerCase()) ? 0.55 : 0.3, evidence: description ? [description] : [`Configured content pillar: ${t.pillar}`] })),
    territoryMap,
    ideaStrategy: { preferredIdeaFamilies: genericFamilies, avoidedIdeaPatterns: ['generic importance claim', 'broad category introduction', 'unsupported first-person story', 'mandatory checklist'], underusedPerspectives: ['operator decision', 'audience misconception', 'constraint-first', 'second-order effect'] },
    distributionStrategy: { pillarWeights: Object.fromEntries(pillars.map((p) => [p.name, share])), territoryWeights: Object.fromEntries(territoryMap.map((t) => [t.territory, t.weight])) },
    version: 1, confidence: description && pillars.length ? 0.6 : 0.35,
  };
}

async function enrich(strategy: EffectiveBotStrategy, apiKey?: string | null): Promise<ContentIntelligenceProfile> {
  const fallback = buildFallbackContentIntelligence(strategy);
  const key = apiKey || process.env.OPENAI_API_KEY;
  if (!key) return fallback;
  const response = await new OpenAI({ apiKey: key }).chat.completions.create({
    model: process.env.OPENAI_CONTENT_MODEL || 'gpt-4o-mini', temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: 'Conservatively enrich a LinkedIn content strategy. Return JSON matching the supplied fallback shape. Expand every pillar into niche-native territories and idea families. A selected niche is interest, not proof of expertise. Never invent biography, achievements, clients, projects, results, or first-person experience.' }, { role: 'user', content: JSON.stringify({ strategy, fallback }) }],
  });
  const parsed = profileSchema.safeParse(JSON.parse(response.choices[0]?.message?.content || '{}'));
  return parsed.success ? { ...parsed.data, version: fallback.version } : fallback;
}

export async function getOrBuildContentIntelligence(userId: string, strategy: EffectiveBotStrategy, apiKey?: string | null): Promise<{ profile: ContentIntelligenceProfile; source: 'cache' | 'rebuilt' | 'fallback'; error?: string }> {
  const inputFingerprint = contentIntelligenceInputFingerprint(strategy);
  const existing = await prisma.userContentIntelligence.findUnique({ where: { userId } });
  if (existing?.inputFingerprint === inputFingerprint) {
    const parsed = profileSchema.safeParse(existing.profile);
    if (parsed.success) return { profile: parsed.data, source: 'cache' };
  }
  try {
    const profile = await enrich(strategy, apiKey);
    const saved = await prisma.userContentIntelligence.upsert({
      where: { userId },
      create: { userId, profile: profile as unknown as Prisma.InputJsonValue, inputFingerprint, version: 1, confidence: profile.confidence },
      update: { profile: profile as unknown as Prisma.InputJsonValue, inputFingerprint, version: { increment: 1 }, confidence: profile.confidence, generatedAt: new Date() },
    });
    return { profile: { ...profile, version: saved.version }, source: 'rebuilt' };
  } catch (error) {
    console.warn('[content-intelligence] enrichment failed; continuing safely', { userId, message: error instanceof Error ? error.message : String(error), previousProfileRetained: !!existing });
    const parsed = existing ? profileSchema.safeParse(existing.profile) : null;
    return { profile: parsed?.success ? parsed.data : buildFallbackContentIntelligence(strategy), source: 'fallback', error: error instanceof Error ? error.message : String(error) };
  }
}
