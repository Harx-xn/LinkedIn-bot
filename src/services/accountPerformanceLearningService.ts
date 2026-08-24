import { prisma } from '../prismaClient';

export type PerformanceDimension =
  | 'pillar'
  | 'territory'
  | 'ideaFamily'
  | 'contentObjective'
  | 'hookFamily'
  | 'structure'
  | 'lengthBand'
  | 'endingType'
  | 'visualType'
  | 'authorityMode';

export type PerformanceSignalStrength = 'VERY_WEAK' | 'WEAK' | 'MODERATE' | 'STRONG';

export type AccountPerformanceObservation = {
  postId: string;
  publishedAt: Date;
  impressions?: number;
  engagements?: number;
  engagementRate?: number;
  features: Partial<Record<PerformanceDimension, string>>;
};

export type AccountPerformancePreference = {
  dimension: PerformanceDimension;
  value: string;
  sampleSize: number;
  effectiveSampleSize: number;
  confidence: number;
  strength: PerformanceSignalStrength;
  normalizedPerformance: number;
  scoreAdjustment: number;
  averageImpressions?: number;
  averageEngagements?: number;
  engagementRate?: number;
};

export type AccountPerformanceProfile = {
  userId: string;
  postCount: number;
  importCount: number;
  availableMetrics: Array<'IMPRESSIONS' | 'ENGAGEMENTS' | 'ENGAGEMENT_RATE'>;
  unavailableMetrics: Array<'PROFILE_OUTCOMES' | 'ATTRIBUTABLE_FOLLOWER_CHANGE'>;
  baseline: {
    medianImpressions?: number;
    medianEngagements?: number;
    medianEngagementRate?: number;
    recencyHalfLifeDays: number;
  };
  preferences: AccountPerformancePreference[];
};

export type CandidatePerformanceFeatures = Partial<Record<PerformanceDimension, string>>;

export type CandidatePerformanceAdjustment = {
  adjustment: number;
  explorationAdjustment: number;
  matched: AccountPerformancePreference[];
  reasons: string[];
};

const DIMENSIONS: PerformanceDimension[] = [
  'pillar', 'territory', 'ideaFamily', 'contentObjective', 'hookFamily',
  'structure', 'lengthBand', 'endingType', 'visualType', 'authorityMode',
];

const DIMENSION_WEIGHTS: Record<PerformanceDimension, number> = {
  pillar: .8,
  territory: 1,
  ideaFamily: 1,
  contentObjective: .75,
  hookFamily: .55,
  structure: .7,
  lengthBand: .4,
  endingType: .35,
  visualType: .4,
  authorityMode: .35,
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : 0));
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values: number[]): number | undefined {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}

function round(value: number, digits = 4): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function featureKey(value?: string | null): string {
  return (value ?? '').trim().replace(/[\s-]+/g, '_').replace(/[^a-zA-Z0-9_]/g, '').toUpperCase();
}

export function normalizePerformanceFeature(dimension: PerformanceDimension, value?: string | null): string {
  const normalized = featureKey(value);
  if (!normalized) return '';
  const aliases: Partial<Record<PerformanceDimension, Record<string, string>>> = {
    hookFamily: {
      OBSERVATION_HOOK: 'OBSERVATION', PERSONAL_OBSERVATION_HOOK: 'FIRST_PERSON_LESSON',
      CONTRARIAN_OR_TENSION_HOOK: 'CONTRARIAN_CLAIM', DATA_OR_QUANTIFIED_HOOK: 'SPECIFIC_RESULT',
      PROBLEM_SIGNAL_HOOK: 'MISTAKE', QUESTION_HOOK: 'QUESTION', DIRECT_CLAIM_HOOK: 'DIRECT_VALUE_PROMISE',
    },
    structure: {
      COMPACT_ARGUMENT: 'COMPACT_INSIGHT', MULTI_PARAGRAPH_CONTRAST: 'COMPARISON_DISTINCTION_DECISION',
      LIST_OR_WALKTHROUGH: 'FRAMEWORK_EXPLANATION_APPLICATION',
    },
    contentObjective: {
      EXPLAIN_MECHANISM: 'TEACH', GUIDE_IMPLEMENTATION: 'CREATE_REFERENCE_VALUE', PREVENT_ERROR: 'TEACH',
      REFRAME_DECISION: 'CHALLENGE_ASSUMPTION', SHARE_INSIGHT: 'BUILD_AUTHORITY',
    },
    endingType: {
      SYNTHESIS_CLOSE: 'CONCLUSION', REFLECTIVE_CLOSE: 'INSIGHT', PREDICTION_CLOSE: 'PREDICTION',
      OBSERVATION_CLOSE: 'OBSERVATION', CAUTION_CLOSE: 'CHALLENGE', DISCUSSION_QUESTION: 'QUESTION',
      REFLECTIVE_QUESTION: 'QUESTION', PERSONAL_NOTE_CLOSE: 'PERSONAL_NOTE', PROMOTIONAL_CLOSE: 'SOFT_CTA',
      NATURAL_RESOLUTION: 'NO_CTA', NO_EXPLICIT_CTA: 'NO_CTA',
    },
  };
  return aliases[dimension]?.[normalized] ?? normalized;
}

function metricPerformance(
  observation: AccountPerformanceObservation,
  baseline: AccountPerformanceProfile['baseline'],
): number | null {
  const components: Array<{ value: number; weight: number }> = [];
  if (observation.engagementRate != null && baseline.medianEngagementRate != null) {
    const denominator = Math.max(.05, baseline.medianEngagementRate);
    components.push({ value: clamp(Math.log2((observation.engagementRate + .05) / denominator) / 2, -1, 1), weight: .75 });
  }
  if (observation.impressions != null && baseline.medianImpressions != null) {
    components.push({ value: clamp(Math.log2((observation.impressions + 1) / (baseline.medianImpressions + 1)) / 3, -1, 1), weight: .25 });
  }
  if (!components.length && observation.engagements != null && baseline.medianEngagements != null) {
    components.push({ value: clamp(Math.log2((observation.engagements + 1) / (baseline.medianEngagements + 1)) / 3, -1, 1), weight: .5 });
  }
  if (!components.length) return null;
  return components.reduce((sum, component) => sum + component.value * component.weight, 0)
    / components.reduce((sum, component) => sum + component.weight, 0);
}

function signalStrength(confidence: number): PerformanceSignalStrength {
  if (confidence < .18) return 'VERY_WEAK';
  if (confidence < .38) return 'WEAK';
  if (confidence < .64) return 'MODERATE';
  return 'STRONG';
}

/** Pure aggregation used by generation and tests. No unavailable metric is synthesized. */
export function buildAccountPerformanceProfile(
  userId: string,
  observations: AccountPerformanceObservation[],
  options: { now?: Date; importCount?: number } = {},
): AccountPerformanceProfile {
  const now = options.now ?? new Date();
  const valid = observations.filter((observation) => observation.postId && observation.publishedAt instanceof Date);
  const impressions = valid.flatMap((item) => item.impressions != null ? [item.impressions] : []);
  const engagements = valid.flatMap((item) => item.engagements != null ? [item.engagements] : []);
  const engagementRates = valid.flatMap((item) => item.engagementRate != null ? [item.engagementRate] : []);
  const dates = valid.map((item) => item.publishedAt.getTime()).sort((a, b) => a - b);
  const observedSpanDays = dates.length > 1 ? (dates.at(-1)! - dates[0]) / 86_400_000 : 0;
  const recencyHalfLifeDays = Math.round(clamp(Math.max(120, observedSpanDays * .75), 90, 365));
  const baseline: AccountPerformanceProfile['baseline'] = {
    medianImpressions: median(impressions),
    medianEngagements: median(engagements),
    medianEngagementRate: median(engagementRates),
    recencyHalfLifeDays,
  };
  const normalized = valid.flatMap((observation) => {
    const performance = metricPerformance(observation, baseline);
    if (performance == null) return [];
    const ageDays = Math.max(0, (now.getTime() - observation.publishedAt.getTime()) / 86_400_000);
    return [{ observation, performance, recencyWeight: 0.5 ** (ageDays / recencyHalfLifeDays) }];
  });

  const preferences: AccountPerformancePreference[] = [];
  for (const dimension of DIMENSIONS) {
    const groups = new Map<string, typeof normalized>();
    for (const item of normalized) {
      const value = normalizePerformanceFeature(dimension, item.observation.features[dimension]);
      if (!value) continue;
      groups.set(value, [...(groups.get(value) ?? []), item]);
    }
    for (const [value, items] of groups) {
      const effectiveSampleSize = items.reduce((sum, item) => sum + item.recencyWeight, 0);
      if (effectiveSampleSize <= 0) continue;
      const normalizedPerformance = items.reduce((sum, item) => sum + item.performance * item.recencyWeight, 0) / effectiveSampleSize;
      const variance = items.reduce((sum, item) => sum + ((item.performance - normalizedPerformance) ** 2) * item.recencyWeight, 0) / effectiveSampleSize;
      const sampleConfidence = 1 - Math.exp(-effectiveSampleSize / 4);
      const consistency = 1 / (1 + Math.sqrt(variance));
      const confidence = clamp(sampleConfidence * consistency, 0, .9);
      const scoreAdjustment = clamp(normalizedPerformance * confidence * 10, -6, 6);
      const groupImpressions = items.flatMap((item) => item.observation.impressions != null ? [item.observation.impressions] : []);
      const groupEngagements = items.flatMap((item) => item.observation.engagements != null ? [item.observation.engagements] : []);
      const totalImpressions = groupImpressions.reduce((sum, value) => sum + value, 0);
      const totalEngagements = groupEngagements.reduce((sum, value) => sum + value, 0);
      preferences.push({
        dimension,
        value,
        sampleSize: items.length,
        effectiveSampleSize: round(effectiveSampleSize, 2),
        confidence: round(confidence),
        strength: signalStrength(confidence),
        normalizedPerformance: round(normalizedPerformance),
        scoreAdjustment: round(scoreAdjustment, 2),
        ...(groupImpressions.length ? { averageImpressions: round(mean(groupImpressions)!, 2) } : {}),
        ...(groupEngagements.length ? { averageEngagements: round(mean(groupEngagements)!, 2) } : {}),
        ...(totalImpressions > 0 ? { engagementRate: round(totalEngagements / totalImpressions * 100, 4) } : {}),
      });
    }
  }

  return {
    userId,
    postCount: valid.length,
    importCount: options.importCount ?? 0,
    availableMetrics: [
      ...(impressions.length ? ['IMPRESSIONS' as const] : []),
      ...(engagements.length ? ['ENGAGEMENTS' as const] : []),
      ...(engagementRates.length ? ['ENGAGEMENT_RATE' as const] : []),
    ],
    unavailableMetrics: ['PROFILE_OUTCOMES', 'ATTRIBUTABLE_FOLLOWER_CHANGE'],
    baseline,
    preferences: preferences.sort((a, b) => b.confidence - a.confidence || Math.abs(b.scoreAdjustment) - Math.abs(a.scoreAdjustment)),
  };
}

export function emptyAccountPerformanceProfile(userId: string): AccountPerformanceProfile {
  return buildAccountPerformanceProfile(userId, []);
}

export function scoreCandidateAgainstPerformance(
  profile: AccountPerformanceProfile | undefined,
  features: CandidatePerformanceFeatures,
  options: { explicitUserChoice?: boolean } = {},
): CandidatePerformanceAdjustment {
  if (!profile?.postCount || options.explicitUserChoice) {
    return { adjustment: 0, explorationAdjustment: 0, matched: [], reasons: options.explicitUserChoice ? ['explicit_user_strategy_override'] : [] };
  }
  const matched: AccountPerformancePreference[] = [];
  let weighted = 0;
  let weightTotal = 0;
  for (const dimension of DIMENSIONS) {
    const value = normalizePerformanceFeature(dimension, features[dimension]);
    if (!value) continue;
    const preference = profile.preferences.find((item) => item.dimension === dimension && item.value === value);
    if (!preference) continue;
    const weight = DIMENSION_WEIGHTS[dimension];
    matched.push(preference);
    weighted += preference.scoreAdjustment * weight;
    weightTotal += weight;
  }
  const territory = normalizePerformanceFeature('territory', features.territory);
  const territorySeen = !territory || profile.preferences.some((item) => item.dimension === 'territory' && item.value === territory);
  const maturity = 1 - Math.exp(-profile.postCount / 12);
  const explorationAdjustment = territorySeen ? 0 : round(.75 + maturity * .75, 2);
  const adjustment = clamp((weightTotal ? weighted / weightTotal : 0) + explorationAdjustment, -6, 6);
  return {
    adjustment: round(adjustment, 2),
    explorationAdjustment,
    matched,
    reasons: [
      ...matched.map((item) => `account_performance:${item.dimension}:${item.value}:${item.scoreAdjustment >= 0 ? 'above' : 'below'}_baseline:${item.strength.toLowerCase()}`),
      ...(explorationAdjustment ? ['account_performance:unseen_territory_exploration'] : []),
    ],
  };
}

function objectMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringMetadata(metadata: Record<string, unknown>, key: string): string | undefined {
  return typeof metadata[key] === 'string' ? metadata[key] as string : undefined;
}

function lengthBand(content: string, metadata: Record<string, unknown>): string {
  const stored = stringMetadata(metadata, 'depthBand');
  if (stored) return stored;
  if (content.length < 700) return 'COMPACT';
  if (content.length < 1600) return 'STANDARD';
  return 'DEEP';
}

function visualType(post: { attachmentType: string; mediaUrl: string | null; carouselProjectId: string | null }, metadata: Record<string, unknown>): string {
  const stored = stringMetadata(metadata, 'visualType');
  if (stored) return stored;
  if (post.carouselProjectId || post.attachmentType === 'DOCUMENT') return 'CAROUSEL';
  if (post.mediaUrl || post.attachmentType !== 'NONE') return post.attachmentType === 'VIDEO' ? 'VIDEO' : 'IMAGE';
  return 'NONE';
}

/** Loads a bounded, account-scoped set of matched imports. Failures are handled by the caller. */
export async function loadAccountPerformanceProfile(userId: string, limit = 320): Promise<AccountPerformanceProfile> {
  const metrics = await prisma.linkedInAnalyticsPostMetric.findMany({
    where: {
      matchedPostId: { not: null },
      analyticsImport: { userId, status: { in: ['READY', 'ANALYZING'] } },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      matchedPostId: true,
      impressions: true,
      engagements: true,
      engagementRate: true,
      publishedAt: true,
      createdAt: true,
      analyticsImport: { select: { id: true, periodEnd: true } },
    },
  });
  const latestByPost = new Map<string, typeof metrics[number]>();
  for (const metric of metrics) {
    if (!metric.matchedPostId) continue;
    const existing = latestByPost.get(metric.matchedPostId);
    if (!existing || metric.analyticsImport.periodEnd > existing.analyticsImport.periodEnd) latestByPost.set(metric.matchedPostId, metric);
  }
  const posts = await prisma.post.findMany({
    where: { userId, id: { in: [...latestByPost.keys()] } },
    select: {
      id: true, content: true, publishedAt: true, scheduledAt: true, attachmentType: true, mediaUrl: true, carouselProjectId: true,
      contentFingerprint: { select: {
        pillar: true, territory: true, contentIntent: true, hookType: true, structure: true, ctaType: true,
        authorityMode: true, keywords: true,
      } },
    },
  });
  const observations: AccountPerformanceObservation[] = posts.flatMap((post) => {
    const metric = latestByPost.get(post.id);
    const fingerprint = post.contentFingerprint;
    if (!metric || !fingerprint) return [];
    const metadata = objectMetadata(fingerprint.keywords);
    const impressions = metric.impressions >= 0 ? metric.impressions : undefined;
    const engagements = metric.engagements >= 0 ? metric.engagements : undefined;
    const engagementRate = impressions != null && impressions > 0
      ? engagements! / impressions * 100
      : undefined;
    return [{
      postId: post.id,
      publishedAt: metric.publishedAt ?? post.publishedAt ?? post.scheduledAt ?? metric.createdAt,
      impressions,
      engagements,
      engagementRate,
      features: {
        pillar: fingerprint.pillar ?? undefined,
        territory: fingerprint.territory ?? undefined,
        ideaFamily: stringMetadata(metadata, 'ideaFamily') ?? fingerprint.contentIntent ?? undefined,
        contentObjective: stringMetadata(metadata, 'contentObjective') ?? fingerprint.contentIntent ?? undefined,
        hookFamily: stringMetadata(metadata, 'hookFamily') ?? fingerprint.hookType ?? undefined,
        structure: stringMetadata(metadata, 'rhetoricalStructure') ?? fingerprint.structure ?? undefined,
        lengthBand: lengthBand(post.content, metadata),
        endingType: stringMetadata(metadata, 'endingType') ?? fingerprint.ctaType ?? undefined,
        visualType: visualType(post, metadata),
        authorityMode: fingerprint.authorityMode ?? undefined,
      },
    }];
  });
  return buildAccountPerformanceProfile(userId, observations, {
    importCount: new Set(metrics.map((metric) => metric.analyticsImport.id)).size,
  });
}

/** Analytics are advisory: an import/database failure must never block generation. */
export async function loadAccountPerformanceProfileSafe(
  userId: string,
  loader: (userId: string) => Promise<AccountPerformanceProfile> = loadAccountPerformanceProfile,
): Promise<AccountPerformanceProfile> {
  try {
    return await loader(userId);
  } catch (error) {
    console.warn('[account-performance] analytics learning unavailable; continuing without preferences', {
      userId,
      message: error instanceof Error ? error.message : String(error),
    });
    return emptyAccountPerformanceProfile(userId);
  }
}
