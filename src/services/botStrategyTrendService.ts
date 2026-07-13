import type { ContentPillar, EffectiveBotStrategy } from './botStrategyService';
import type { NicheExpansionPlan, TopicFingerprint, TrendCandidate } from './generationTypes';
import type { TopicHistoryRow } from './topicHistoryService';
import { buildFallbackExpansionPlan, buildQueryBucketsFromQueries } from './nicheExpansionService';

export type StrategyTrendSeed = {
  query: string;
  pillarName?: string;
  priority: number;
  source: 'primary_pillar' | 'secondary_pillar' | 'experimental_pillar' | 'legacy_niche';
};

export type StrategyTrendScore = {
  score: number;
  accepted: boolean;
  reasons: string[];
  matchedPillar?: string;
  suggestedAngle?: string;
  audienceRelevance?: string;
  riskFlags?: string[];
};

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    const key = normalizeText(trimmed);
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    output.push(trimmed);
  }
  return output;
}

function textMatchesAny(text: string, values: string[]): string | undefined {
  const normalized = normalizeText(text);
  return values.find((value) => {
    const key = normalizeText(value);
    return key.length >= 3 && normalized.includes(key);
  });
}

function pillarSeeds(
  pillars: ContentPillar[],
  source: StrategyTrendSeed['source'],
  priority: number,
): StrategyTrendSeed[] {
  return pillars.flatMap((pillar) => {
    const queries = unique([pillar.name, ...pillar.trendKeywords]);
    return queries.map((query) => ({
      query,
      pillarName: pillar.name,
      priority,
      source,
    }));
  });
}

export function buildStrategyTrendSeeds(strategy: EffectiveBotStrategy): StrategyTrendSeed[] {
  const primary = pillarSeeds(strategy.contentPillars.primaryPillars, 'primary_pillar', 3);
  const secondary = pillarSeeds(strategy.contentPillars.secondaryPillars, 'secondary_pillar', 2);
  const experimental = pillarSeeds(strategy.contentPillars.experimentalPillars ?? [], 'experimental_pillar', 1);
  const strategySeeds = [...primary, ...secondary, ...experimental];

  if (strategySeeds.length > 0) {
    const seen = new Set<string>();
    return strategySeeds
      .sort((a, b) => b.priority - a.priority)
      .filter((seed) => {
        const key = normalizeText(seed.query);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  return unique(strategy.legacy.niches).map((query) => ({
    query,
    pillarName: query,
    priority: 1,
    source: 'legacy_niche',
  }));
}

export function getStrategyNiches(strategy: EffectiveBotStrategy): string[] {
  const pillarNames = unique([
    ...strategy.contentPillars.primaryPillars.map((pillar) => pillar.name),
    ...strategy.contentPillars.secondaryPillars.map((pillar) => pillar.name),
  ]);
  return pillarNames.length > 0 ? pillarNames : unique(strategy.legacy.niches);
}

export function hasStrategyGenerationContext(strategy: EffectiveBotStrategy): boolean {
  return Boolean(
    strategy.profilePositioning.positioningStatement.trim()
      || strategy.legacy.description
      || strategy.contentPillars.primaryPillars.length
      || strategy.legacy.niches.length,
  );
}

export function buildStrategyExpansionPlan(
  strategy: EffectiveBotStrategy,
  niche: string,
): NicheExpansionPlan {
  const allPillars = [
    ...strategy.contentPillars.primaryPillars,
    ...strategy.contentPillars.secondaryPillars,
    ...(strategy.contentPillars.experimentalPillars ?? []),
  ];
  const pillar = allPillars.find((item) => normalizeText(item.name) === normalizeText(niche));
  if (!pillar) {
    const fallback = buildFallbackExpansionPlan(niche);
    return {
      ...fallback,
      exclusions: unique([...fallback.exclusions, ...strategy.contentPillars.excludedTopics]),
    };
  }

  const queries = unique([pillar.name, ...pillar.trendKeywords]);
  const subtopics = unique([
    pillar.name,
    ...pillar.trendKeywords,
    ...pillar.exampleAngles,
  ]).slice(0, 10);
  return {
    niche: pillar.name,
    domain: pillar.name,
    confidence: 0.85,
    subtopics: subtopics.length ? subtopics : [pillar.name],
    queries,
    queryBuckets: buildQueryBucketsFromQueries(queries, pillar.name),
    exclusions: unique([
      ...strategy.contentPillars.excludedTopics,
      ...strategy.topicRules.rejectedPatterns,
    ]),
    generatedAt: new Date(),
  };
}

function candidateText(candidate: TrendCandidate): string {
  return [
    candidate.topic,
    candidate.summary,
    candidate.searchQuery,
    candidate.niche,
    ...(candidate.keyPoints ?? []),
  ].filter(Boolean).join(' ');
}

function matchPillar(text: string, strategy: EffectiveBotStrategy): ContentPillar | undefined {
  const pillars = [
    ...strategy.contentPillars.primaryPillars,
    ...strategy.contentPillars.secondaryPillars,
    ...(strategy.contentPillars.experimentalPillars ?? []),
  ];
  return pillars.find((pillar) => textMatchesAny(text, [pillar.name, ...pillar.trendKeywords, pillar.description]));
}

function withinAvoidanceWindow(row: TopicHistoryRow, days: number): boolean {
  if (days <= 0) return false;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return row.generatedAt >= cutoff;
}

function isDuplicateRecentTopic(
  candidate: TrendCandidate,
  history: TopicHistoryRow[],
  strategy: EffectiveBotStrategy,
): TopicHistoryRow | undefined {
  if (!strategy.topicRules.avoidDuplicateAngles) return undefined;
  const titleKey = normalizeText(candidate.topic);
  const angleKey = normalizeText((candidate as any).suggestedAngle);
  return history.find((row) => {
    if (!withinAvoidanceWindow(row, strategy.topicRules.avoidRecentTopicsDays)) return false;
    if (titleKey && normalizeText(row.normalizedTopic) === titleKey) return true;
    return Boolean(angleKey && normalizeText(row.angle) === angleKey);
  });
}

export function scoreTrendForStrategy(
  candidate: TrendCandidate,
  strategy: EffectiveBotStrategy,
  options: { recentHistory?: TopicHistoryRow[]; fingerprint?: TopicFingerprint } = {},
): StrategyTrendScore {
  const text = candidateText(candidate);
  const reasons: string[] = [];
  const riskFlags: string[] = [];

  const excluded = textMatchesAny(text, [
    ...strategy.contentPillars.excludedTopics,
    ...strategy.topicRules.rejectedPatterns,
  ]);
  if (excluded) {
    riskFlags.push(`excluded:${excluded}`);
  }

  const pillar = matchPillar(text, strategy);
  let score = 0;
  if (pillar) {
    score += 25;
    reasons.push(`pillar_match:${pillar.name}`);
  } else if (strategy.legacy.niches.some((niche) => normalizeText(text).includes(normalizeText(niche)))) {
    score += 15;
    reasons.push('legacy_niche_match');
  }

  const audienceSignals = [
    strategy.targetAudience.primaryAudience,
    ...strategy.targetAudience.roles,
    ...strategy.targetAudience.industries,
    ...strategy.targetAudience.painPoints,
    ...strategy.targetAudience.desiredOutcomes,
    ...strategy.targetAudience.objectionsOrMisbeliefs,
  ].filter(Boolean);
  const hasAudienceStrategy = audienceSignals.some((value) => value.trim());
  const audienceMatch = textMatchesAny(text, audienceSignals);
  if (audienceMatch) {
    score += 35;
    reasons.push(`audience_match:${audienceMatch}`);
  }

  const goalSignals = [
    strategy.contentGoals.primaryGoal,
    ...strategy.contentGoals.secondaryGoals,
    strategy.contentGoals.conversionTarget ?? '',
  ].filter(Boolean);
  if (textMatchesAny(text, goalSignals)) {
    score += 15;
    reasons.push('content_goal_alignment');
  }

  const positioningSignals = [
    strategy.profilePositioning.positioningStatement,
    strategy.profilePositioning.uniquePointOfView,
    ...strategy.profilePositioning.topicsToBeKnownFor,
  ].filter(Boolean);
  const hasPositioningStrategy = positioningSignals.some((value) => value.trim());
  if (textMatchesAny(text, positioningSignals)) {
    score += 10;
    reasons.push('positioning_fit');
  }

  if (candidate.publishedAt) {
    score += 10;
    reasons.push('timely_source');
  } else {
    score += 4;
  }

  const duplicate = isDuplicateRecentTopic(candidate, options.recentHistory ?? [], strategy);
  if (duplicate) {
    riskFlags.push(`recent_duplicate:${duplicate.id}`);
  }

  if (excluded) score -= 5;
  score = Math.max(0, Math.min(100, score));

  const minimumScore = !hasAudienceStrategy && !hasPositioningStrategy
    ? Math.min(strategy.topicRules.minimumRelevanceScore, 35)
    : strategy.topicRules.minimumRelevanceScore;

  const accepted =
    score >= minimumScore
    && !excluded
    && !(strategy.topicRules.requirePillarMatch && !pillar && strategy.contentPillars.primaryPillars.length > 0)
    && !(strategy.topicRules.requireAudiencePainMatch && !audienceMatch)
    && !duplicate;

  if (!accepted) {
    if (score < minimumScore) riskFlags.push('low_relevance');
    if (strategy.topicRules.requirePillarMatch && !pillar) riskFlags.push('missing_pillar_match');
    if (strategy.topicRules.requireAudiencePainMatch && !audienceMatch) riskFlags.push('missing_audience_match');
  }

  return {
    score,
    accepted,
    reasons,
    matchedPillar: pillar?.name,
    suggestedAngle: (pillar?.exampleAngles[0] ?? strategy.profilePositioning.uniquePointOfView) || undefined,
    audienceRelevance: pillar?.audienceRelevance || audienceMatch,
    riskFlags,
  };
}
