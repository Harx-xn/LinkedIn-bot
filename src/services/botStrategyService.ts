import { z } from 'zod';

export type ProfilePositioning = {
  role?: string;
  companyOrProduct?: string;
  positioningStatement: string;
  credibilityPoints: string[];
  uniquePointOfView: string;
  topicsToBeKnownFor: string[];
};

export type TargetAudience = {
  primaryAudience: string;
  secondaryAudiences?: string[];
  roles: string[];
  industries: string[];
  companyStage?: string[];
  painPoints: string[];
  desiredOutcomes: string[];
  objectionsOrMisbeliefs: string[];
  knowledgeLevel: 'beginner' | 'intermediate' | 'expert';
};

export type ContentGoals = {
  primaryGoal:
    | 'authority'
    | 'leads'
    | 'education'
    | 'community'
    | 'product_awareness'
    | 'hiring'
    | 'traffic';
  secondaryGoals: string[];
  conversionTarget?: string;
  preferredCTAStyle: 'soft' | 'direct' | 'discussion' | 'no_cta';
};

export type ContentPillar = {
  name: string;
  description: string;
  audienceRelevance: string;
  exampleAngles: string[];
  trendKeywords: string[];
};

export type ContentPillars = {
  primaryPillars: ContentPillar[];
  secondaryPillars: ContentPillar[];
  experimentalPillars?: ContentPillar[];
  excludedTopics: string[];
};

export type TopicRules = {
  minimumRelevanceScore: number;
  requireAudiencePainMatch: boolean;
  requirePillarMatch: boolean;
  avoidDuplicateAngles: boolean;
  avoidRecentTopicsDays: number;
  rejectedPatterns: string[];
};

export type WritingStyle = {
  tone: string[];
  formality: 'casual' | 'balanced' | 'professional';
  postLength: 'short' | 'medium' | 'long';
  preferredFormats: string[];
  avoidStyles: string[];
  examplePosts?: string[];
};

export type BotStrategyConfig = {
  profilePositioning: ProfilePositioning;
  targetAudience: TargetAudience;
  contentGoals: ContentGoals;
  contentPillars: ContentPillars;
  topicRules: TopicRules;
  writingStyle: WritingStyle;
};

export type EffectiveBotStrategy = BotStrategyConfig & {
  legacy: {
    niches: string[];
    sources: string[];
    description?: string;
    tone?: string;
  };
};

export const BOT_STRATEGY_FIELDS = [
  'profilePositioning',
  'targetAudience',
  'contentGoals',
  'contentPillars',
  'topicRules',
  'writingStyle',
] as const;

export type BotStrategyField = (typeof BOT_STRATEGY_FIELDS)[number];

export class BotStrategyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BotStrategyValidationError';
  }
}

type LegacyStrategySource = {
  description?: string | null;
  tone?: string | null;
  niches?: string | null;
  sources?: string | null;
  profilePositioning?: unknown;
  targetAudience?: unknown;
  contentGoals?: unknown;
  contentPillars?: unknown;
  topicRules?: unknown;
  writingStyle?: unknown;
};

const optionalText = z.string().trim().max(500).optional();
const textArray = z.array(z.string().trim().min(1).max(200)).max(30);

const profilePositioningSchema = z
  .object({
    role: optionalText,
    companyOrProduct: optionalText,
    positioningStatement: z.string().trim().max(2000).optional(),
    credibilityPoints: textArray.optional(),
    uniquePointOfView: z.string().trim().max(2000).optional(),
    topicsToBeKnownFor: textArray.optional(),
  })
  .strict();

const targetAudienceSchema = z
  .object({
    primaryAudience: z.string().trim().max(500).optional(),
    secondaryAudiences: textArray.optional(),
    roles: textArray.optional(),
    industries: textArray.optional(),
    companyStage: textArray.optional(),
    painPoints: textArray.optional(),
    desiredOutcomes: textArray.optional(),
    objectionsOrMisbeliefs: textArray.optional(),
    knowledgeLevel: z.enum(['beginner', 'intermediate', 'expert']).optional(),
  })
  .strict();

const contentGoalsSchema = z
  .object({
    primaryGoal: z
      .enum(['authority', 'leads', 'education', 'community', 'product_awareness', 'hiring', 'traffic'])
      .optional(),
    secondaryGoals: textArray.optional(),
    conversionTarget: optionalText,
    preferredCTAStyle: z.enum(['soft', 'direct', 'discussion', 'no_cta']).optional(),
  })
  .strict();

const contentPillarSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(1000).optional(),
    audienceRelevance: z.string().trim().max(1000).optional(),
    exampleAngles: textArray.optional(),
    trendKeywords: textArray.optional(),
  })
  .strict();

const contentPillarsSchema = z
  .object({
    primaryPillars: z.array(contentPillarSchema).max(20).optional(),
    secondaryPillars: z.array(contentPillarSchema).max(20).optional(),
    experimentalPillars: z.array(contentPillarSchema).max(20).optional(),
    excludedTopics: textArray.optional(),
  })
  .strict();

const topicRulesSchema = z
  .object({
    minimumRelevanceScore: z.number().int().min(0).max(100).optional(),
    requireAudiencePainMatch: z.boolean().optional(),
    requirePillarMatch: z.boolean().optional(),
    avoidDuplicateAngles: z.boolean().optional(),
    avoidRecentTopicsDays: z.number().int().min(0).max(365).optional(),
    rejectedPatterns: textArray.optional(),
  })
  .strict();

const writingStyleSchema = z
  .object({
    tone: textArray.optional(),
    formality: z.enum(['casual', 'balanced', 'professional']).optional(),
    postLength: z.enum(['short', 'medium', 'long']).optional(),
    preferredFormats: textArray.optional(),
    avoidStyles: textArray.optional(),
    examplePosts: z.array(z.string().trim().min(1).max(3000)).max(10).optional(),
  })
  .strict();

function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item).trim()).filter(Boolean);
    }
  } catch {
    // Fall back to comma-separated legacy text.
  }
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseTone(raw: string | null | undefined): string[] {
  const tones = parseStringArray(raw);
  if (tones.length > 0) return tones;
  const value = raw?.trim();
  return value ? [value] : ['Conversational'];
}

function pillarFromNiche(niche: string): ContentPillar {
  return {
    name: niche,
    description: '',
    audienceRelevance: '',
    exampleAngles: [],
    trendKeywords: [niche],
  };
}

/**
 * Keep the structured primary pillars aligned with the legacy niche editor.
 * Matching pillars retain their richer metadata; removed niches cannot remain
 * behind as stale generation inputs.
 */
export function syncPrimaryPillarsToNiches(
  current: ContentPillars,
  niches: string[],
): ContentPillars {
  const uniqueNiches = Array.from(new Set(niches.map((niche) => niche.trim()).filter(Boolean)));
  const existingByName = new Map(
    current.primaryPillars.map((pillar) => [pillar.name.trim().toLowerCase(), pillar]),
  );

  return {
    ...current,
    primaryPillars: uniqueNiches.map((niche) =>
      existingByName.get(niche.toLowerCase()) ?? pillarFromNiche(niche)),
  };
}

function defaultProfilePositioning(source: LegacyStrategySource): ProfilePositioning {
  const niches = parseStringArray(source.niches);
  return {
    positioningStatement: source.description?.trim() ?? '',
    credibilityPoints: [],
    uniquePointOfView: '',
    topicsToBeKnownFor: niches,
  };
}

function defaultTargetAudience(): TargetAudience {
  return {
    primaryAudience: '',
    secondaryAudiences: [],
    roles: [],
    industries: [],
    companyStage: [],
    painPoints: [],
    desiredOutcomes: [],
    objectionsOrMisbeliefs: [],
    knowledgeLevel: 'intermediate',
  };
}

function defaultContentGoals(): ContentGoals {
  return {
    primaryGoal: 'authority',
    secondaryGoals: [],
    preferredCTAStyle: 'soft',
  };
}

function defaultContentPillars(source: LegacyStrategySource): ContentPillars {
  return {
    primaryPillars: parseStringArray(source.niches).map(pillarFromNiche),
    secondaryPillars: [],
    experimentalPillars: [],
    excludedTopics: [],
  };
}

function defaultTopicRules(): TopicRules {
  return {
    minimumRelevanceScore: 65,
    requireAudiencePainMatch: false,
    requirePillarMatch: true,
    avoidDuplicateAngles: true,
    avoidRecentTopicsDays: 30,
    rejectedPatterns: [],
  };
}

function defaultWritingStyle(source: LegacyStrategySource): WritingStyle {
  return {
    tone: parseTone(source.tone),
    formality: 'balanced',
    postLength: 'medium',
    preferredFormats: [],
    avoidStyles: [],
    examplePosts: [],
  };
}

function parseObject<T>(field: BotStrategyField, value: unknown, schema: z.ZodType<T>): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BotStrategyValidationError(`${field} must be an object`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new BotStrategyValidationError(`Invalid ${field}: ${parsed.error.issues[0]?.message ?? 'invalid value'}`);
  }
  return parsed.data;
}

function normalizeContentPillar(input: z.infer<typeof contentPillarSchema>): ContentPillar {
  return {
    name: input.name,
    description: input.description ?? '',
    audienceRelevance: input.audienceRelevance ?? '',
    exampleAngles: input.exampleAngles ?? [],
    trendKeywords: input.trendKeywords ?? [input.name],
  };
}

export function normalizeProfilePositioning(value: unknown, source: LegacyStrategySource): ProfilePositioning {
  const defaults = defaultProfilePositioning(source);
  if (value == null) return defaults;
  const parsed = parseObject('profilePositioning', value, profilePositioningSchema);
  return {
    ...defaults,
    ...parsed,
    positioningStatement: parsed.positioningStatement ?? defaults.positioningStatement,
    credibilityPoints: parsed.credibilityPoints ?? defaults.credibilityPoints,
    uniquePointOfView: parsed.uniquePointOfView ?? defaults.uniquePointOfView,
    topicsToBeKnownFor: parsed.topicsToBeKnownFor ?? defaults.topicsToBeKnownFor,
  };
}

export function normalizeTargetAudience(value: unknown): TargetAudience {
  const defaults = defaultTargetAudience();
  if (value == null) return defaults;
  const parsed = parseObject('targetAudience', value, targetAudienceSchema);
  return {
    ...defaults,
    ...parsed,
    primaryAudience: parsed.primaryAudience ?? defaults.primaryAudience,
    secondaryAudiences: parsed.secondaryAudiences ?? defaults.secondaryAudiences,
    roles: parsed.roles ?? defaults.roles,
    industries: parsed.industries ?? defaults.industries,
    companyStage: parsed.companyStage ?? defaults.companyStage,
    painPoints: parsed.painPoints ?? defaults.painPoints,
    desiredOutcomes: parsed.desiredOutcomes ?? defaults.desiredOutcomes,
    objectionsOrMisbeliefs: parsed.objectionsOrMisbeliefs ?? defaults.objectionsOrMisbeliefs,
    knowledgeLevel: parsed.knowledgeLevel ?? defaults.knowledgeLevel,
  };
}

export function normalizeContentGoals(value: unknown): ContentGoals {
  const defaults = defaultContentGoals();
  if (value == null) return defaults;
  const parsed = parseObject('contentGoals', value, contentGoalsSchema);
  return {
    ...defaults,
    ...parsed,
    primaryGoal: parsed.primaryGoal ?? defaults.primaryGoal,
    secondaryGoals: parsed.secondaryGoals ?? defaults.secondaryGoals,
    preferredCTAStyle: parsed.preferredCTAStyle ?? defaults.preferredCTAStyle,
  };
}

export function normalizeContentPillars(value: unknown, source: LegacyStrategySource): ContentPillars {
  const defaults = defaultContentPillars(source);
  if (value == null) return defaults;
  const parsed = parseObject('contentPillars', value, contentPillarsSchema);
  return {
    primaryPillars: (parsed.primaryPillars ?? defaults.primaryPillars).map(normalizeContentPillar),
    secondaryPillars: (parsed.secondaryPillars ?? defaults.secondaryPillars).map(normalizeContentPillar),
    experimentalPillars: (parsed.experimentalPillars ?? defaults.experimentalPillars)?.map(normalizeContentPillar),
    excludedTopics: parsed.excludedTopics ?? defaults.excludedTopics,
  };
}

export function normalizeTopicRules(value: unknown): TopicRules {
  const defaults = defaultTopicRules();
  if (value == null) return defaults;
  const parsed = parseObject('topicRules', value, topicRulesSchema);
  return {
    ...defaults,
    ...parsed,
    minimumRelevanceScore: parsed.minimumRelevanceScore ?? defaults.minimumRelevanceScore,
    requireAudiencePainMatch: parsed.requireAudiencePainMatch ?? defaults.requireAudiencePainMatch,
    requirePillarMatch: parsed.requirePillarMatch ?? defaults.requirePillarMatch,
    avoidDuplicateAngles: parsed.avoidDuplicateAngles ?? defaults.avoidDuplicateAngles,
    avoidRecentTopicsDays: parsed.avoidRecentTopicsDays ?? defaults.avoidRecentTopicsDays,
    rejectedPatterns: parsed.rejectedPatterns ?? defaults.rejectedPatterns,
  };
}

export function normalizeWritingStyle(value: unknown, source: LegacyStrategySource): WritingStyle {
  const defaults = defaultWritingStyle(source);
  if (value == null) return defaults;
  const parsed = parseObject('writingStyle', value, writingStyleSchema);
  return {
    ...defaults,
    ...parsed,
    tone: parsed.tone ?? defaults.tone,
    formality: parsed.formality ?? defaults.formality,
    postLength: parsed.postLength ?? defaults.postLength,
    preferredFormats: parsed.preferredFormats ?? defaults.preferredFormats,
    avoidStyles: parsed.avoidStyles ?? defaults.avoidStyles,
    examplePosts: parsed.examplePosts ?? defaults.examplePosts,
  };
}

export function buildEffectiveBotStrategy(botConfig: LegacyStrategySource | null | undefined): EffectiveBotStrategy {
  const source = botConfig ?? {};
  return {
    profilePositioning: normalizeProfilePositioning(source.profilePositioning, source),
    targetAudience: normalizeTargetAudience(source.targetAudience),
    contentGoals: normalizeContentGoals(source.contentGoals),
    contentPillars: normalizeContentPillars(source.contentPillars, source),
    topicRules: normalizeTopicRules(source.topicRules),
    writingStyle: normalizeWritingStyle(source.writingStyle, source),
    legacy: {
      niches: parseStringArray(source.niches),
      sources: parseStringArray(source.sources),
      description: source.description?.trim() || undefined,
      tone: source.tone?.trim() || undefined,
    },
  };
}

export function hasAnyStrategyFields(input: Partial<Record<BotStrategyField, unknown>>): boolean {
  return BOT_STRATEGY_FIELDS.some((field) => input[field] != null);
}

export function resolveOnboardingStatus(hasStrategyFields: boolean): 'LEGACY' | 'COMPLETE' {
  if (!hasStrategyFields) return 'LEGACY';
  return 'COMPLETE';
}

export function parseStrategyFieldUpdate(
  field: BotStrategyField,
  value: unknown,
  source: LegacyStrategySource,
): unknown {
  if (value === null) return null;
  switch (field) {
    case 'profilePositioning':
      return normalizeProfilePositioning(value, source);
    case 'targetAudience':
      return normalizeTargetAudience(value);
    case 'contentGoals':
      return normalizeContentGoals(value);
    case 'contentPillars':
      return normalizeContentPillars(value, source);
    case 'topicRules':
      return normalizeTopicRules(value);
    case 'writingStyle':
      return normalizeWritingStyle(value, source);
  }
}
