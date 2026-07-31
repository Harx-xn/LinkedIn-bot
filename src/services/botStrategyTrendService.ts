import type { ContentPillar, EffectiveBotStrategy } from './botStrategyService';
import type { CandidateNicheMatch, NicheExpansionPlan, TopicFingerprint, TrendCandidate } from './generationTypes';
import type { TopicHistoryRow } from './topicHistoryService';
import { buildFallbackExpansionPlan, buildQueryBucketsFromQueries } from './nicheExpansionService';
import { createHash } from 'node:crypto';
import { NICHE_EXPANSION_PLAN_VERSION } from '../config/topicDiversityConfig';

export type StrategyTrendSeed = {
  query: string;
  pillarName?: string;
  priority: number;
  source: 'primary_pillar' | 'secondary_pillar' | 'experimental_pillar' | 'legacy_niche';
};

export interface ActiveNicheStrategyContext {
  niche: string;
  profileFingerprint: string;
  pillarNames: string[];
  pillarSearchTerms: string[];
  entities: string[];
  entityAliases: string[];
  platforms: string[];
  dynamicCategories: string[];
  monitoredTopics: string[];
  audienceSignals: string[];
  goalSignals: string[];
  positioningSignals: string[];
}

export type StrategyTrendScore = {
  score: number;
  accepted: boolean;
  reasons: string[];
  matchedPillar?: string;
  suggestedAngle?: string;
  audienceRelevance?: string;
  riskFlags?: string[];
  breakdown: {
    pillarMatch: number;
    audienceMatch: number;
    goalMatch: number;
    positioningMatch: number;
    freshness: number;
    exclusionPenalty: number;
    finalScore: number;
    directNicheEvidence?: number;
    categoryMatchScore?: number;
    monitoredTopicScore?: number;
    ambiguityPenalty?: number;
  };
  nicheMatch?: CandidateNicheMatch;
};

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const MATCH_STOP_WORDS = new Set(['and', 'the', 'for', 'with', 'from', 'into', 'about', 'development', 'industry', 'business', 'services', 'solutions']);

function normalizedTokens(value: string): string[] {
  return normalizeText(value).split(' ').filter((token) => token.length >= 2 && !MATCH_STOP_WORDS.has(token)).map((token) => {
    if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
    if (token.length > 4 && token.endsWith('s')) return token.slice(0, -1);
    return token;
  });
}

function matchesProfileTerm(text: string, term: string): boolean {
  const normalized = normalizeText(text);
  const key = normalizeText(term);
  if (key.length < 2) return false;
  if (normalized.includes(key)) return true;
  const textTokens = new Set(normalizedTokens(text));
  const termTokens = normalizedTokens(term);
  if (!termTokens.length) return false;
  const overlap = termTokens.filter((token) => textTokens.has(token)).length;
  return termTokens.length === 1 ? overlap === 1 && termTokens[0].length >= 4 : overlap >= Math.ceil(termTokens.length * 0.6);
}

function firstMatchingTerm(text: string, values: string[]): string | undefined {
  return unique(values).find((value) => matchesProfileTerm(text, value));
}

function firstMatchingAlias(text: string, profile?: NicheExpansionPlan): string | undefined {
  const aliases = unique(profile?.entityAliases ?? []);
  const normalized = normalizeText(text);
  return aliases.find((alias) => {
    if (!matchesProfileTerm(text, alias)) return false;
    const tokens = normalizedTokens(alias);
    if (tokens.length !== 1) return true;
    const token = tokens[0];
    // Single-word aliases are ambiguous unless the evidence supplies a version
    // number or another profile-specific entity/category/platform term.
    if (new RegExp(`\\b${token}\\s+\\d+\\b`, 'i').test(normalized)) return true;
    const context = unique([
      ...(profile?.requiredContextTerms ?? []), ...(profile?.terminology ?? []),
      ...(profile?.productsAndPlatforms ?? []),
      ...(profile?.contentCategories?.flatMap((category) => [category.label, ...category.terms]) ?? []),
    ]).filter((term) => normalizeText(term) !== normalizeText(alias));
    return Boolean(firstMatchingTerm(text, context));
  });
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

const GENERIC_TREND_KEYWORDS = new Set([
  'trend',
  'trends',
  'news',
  'latest news',
  'best practice',
  'best practices',
  'industry trend',
  'industry trends',
  'recent development',
  'recent developments',
]);

/** Keep search seeds topical; audience labels and generic discovery words do not narrow results. */
export function isUsefulTrendKeyword(value: string, niche?: string): boolean {
  const nicheKey = normalizeText(niche);
  const key = normalizeText(value);
  if (!key || key === nicheKey) return false;

  // Admin-generated keywords are sometimes stored as "<pillar> trends" or
  // "<pillar> for <audience>". Judge the meaningful suffix, not the prefix.
  const focusedKey = nicheKey && key.startsWith(`${nicheKey} `)
    ? key.slice(nicheKey.length).trim()
    : key;
  if (!focusedKey || GENERIC_TREND_KEYWORDS.has(focusedKey)) return false;
  if (/^(for|by|from|with)\b/.test(focusedKey)) return false;
  return focusedKey.split(' ').some((token) => token.length >= 4);
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
  cachedPlan?: NicheExpansionPlan,
): NicheExpansionPlan {
  const allPillars = [
    ...strategy.contentPillars.primaryPillars,
    ...strategy.contentPillars.secondaryPillars,
    ...(strategy.contentPillars.experimentalPillars ?? []),
  ];
  const pillar = allPillars.find((item) => normalizeText(item.name) === normalizeText(niche));
  if (!pillar) {
    const fallback = cachedPlan ?? buildFallbackExpansionPlan(niche);
    return {
      ...fallback,
      exclusions: unique([...fallback.exclusions, ...strategy.contentPillars.excludedTopics]),
    };
  }

  const focusedKeywords = unique(pillar.trendKeywords)
    .filter((keyword) => isUsefulTrendKeyword(keyword, pillar.name));
  const queries = unique([
    ...(cachedPlan?.queries ?? []),
    ...(cachedPlan?.normalizedPillars?.flatMap((item) => item.searchTerms) ?? []),
    ...focusedKeywords,
  ]);
  const subtopics = unique([
    pillar.name,
    ...focusedKeywords,
    ...pillar.exampleAngles,
  ]).slice(0, 10);
  const normalizedPillar = {
    originalPillar: pillar.name,
    normalizedPillar: pillar.description.trim() || pillar.name,
    description: pillar.description,
    subtopics: unique([...focusedKeywords, ...pillar.exampleAngles]),
    relatedEntities: cachedPlan?.importantEntities ?? [],
    searchTerms: focusedKeywords,
    excludedTopics: unique(strategy.contentPillars.excludedTopics),
  };
  const normalizeStable = (value: string) => normalizeText(value);
  const strategyFingerprint = createHash('sha256').update(JSON.stringify({
    version: NICHE_EXPANSION_PLAN_VERSION,
    niche: normalizeStable(pillar.name),
    audience: unique([
      strategy.targetAudience.primaryAudience,
      ...strategy.targetAudience.roles,
      ...strategy.targetAudience.industries,
      ...strategy.targetAudience.painPoints,
      ...strategy.targetAudience.desiredOutcomes,
    ].map(normalizeStable).filter(Boolean)).sort(),
    pillars: allPillars.map((item) => ({
      name: normalizeStable(item.name),
      keywords: unique(item.trendKeywords.map(normalizeStable).filter(Boolean)).sort(),
    })).sort((a, b) => a.name.localeCompare(b.name)),
    topicsToMonitor: unique(strategy.profilePositioning.topicsToBeKnownFor.map(normalizeStable).filter(Boolean)).sort(),
    topicsToAvoid: unique([
      ...strategy.contentPillars.excludedTopics,
      ...strategy.topicRules.rejectedPatterns,
    ].map(normalizeStable).filter(Boolean)).sort(),
  })).digest('hex').slice(0, 20);
  return {
    ...(cachedPlan ?? {}),
    niche: pillar.name,
    domain: cachedPlan?.domain || pillar.name,
    confidence: Math.max(cachedPlan?.confidence ?? 0, 0.85),
    subtopics: unique([...(cachedPlan?.subtopics ?? []), ...subtopics]).slice(0, 10),
    queries,
    queryBuckets: buildQueryBucketsFromQueries(queries, pillar.name),
    exclusions: unique([
      ...strategy.contentPillars.excludedTopics,
      ...strategy.topicRules.rejectedPatterns,
    ]),
    generatedAt: new Date(),
    normalizedPillars: [normalizedPillar],
    requiredContextTerms: cachedPlan?.requiredContextTerms ?? pillar.name.split(/\s+/).filter((term) => term.length >= 3),
    preferredTerms: unique([...(cachedPlan?.preferredTerms ?? []), ...focusedKeywords]),
    excludedTerms: unique([...(cachedPlan?.excludedTerms ?? []), ...strategy.contentPillars.excludedTopics]),
    queryOrigin: 'strategy_enriched',
    inputFingerprint: strategyFingerprint,
  };
}

function candidateText(candidate: TrendCandidate): string {
  // Only score source evidence. `niche`, `searchQuery`, and the strategy
  // metadata fields are attached by our own pipeline; including them would
  // let an unrelated result pass merely because it was fetched for a niche.
  return [
    candidate.topic,
    candidate.summary,
    ...(candidate.keyPoints ?? []),
  ].filter(Boolean).join(' ');
}

function queryContext(candidate: TrendCandidate): string {
  return [candidate.searchQuery, candidate.discoverySource, candidate.source, candidate.publisher, candidate.link]
    .filter(Boolean).join(' ');
}

function hasDistinctivePillarToken(text: string, pillarName: string): boolean {
  const textTokens = new Set(normalizeText(text).split(' ').filter(Boolean));
  const pillarTokens = normalizeText(pillarName)
    .split(' ')
    .filter((token) => token.length >= 2);
  if (pillarTokens.length === 0) return false;

  const matchingTokens = pillarTokens.filter((token) =>
    textTokens.has(token)
    || (token.length >= 4 && textTokens.has(`${token}s`))
    || (token.endsWith('s') && textTokens.has(token.slice(0, -1))),
  ).length;

  // Domain-independent rule: a single-word pillar must match that word; a
  // multi-word pillar needs at least half of its words represented.
  return matchingTokens >= Math.ceil(pillarTokens.length / 2);
}

function allPillars(strategy: EffectiveBotStrategy): ContentPillar[] {
  return [
    ...strategy.contentPillars.primaryPillars,
    ...strategy.contentPillars.secondaryPillars,
    ...(strategy.contentPillars.experimentalPillars ?? []),
  ];
}

export function buildActiveNicheStrategyContext(
  strategy: EffectiveBotStrategy,
  profile: NicheExpansionPlan,
): ActiveNicheStrategyContext {
  const activeName = normalizeText(profile.normalizedNiche ?? profile.niche);
  const activePillars = allPillars(strategy).filter((pillar) => normalizeText(pillar.name) === activeName);
  const profileTerms = unique([
    profile.normalizedNiche ?? profile.niche,
    ...(profile.importantEntities ?? []), ...(profile.entityAliases ?? []), ...(profile.productsAndPlatforms ?? []),
    ...(profile.contentCategories?.flatMap((category) => [category.label, ...category.terms]) ?? []),
    ...(profile.normalizedPillars?.flatMap((pillar) => [pillar.originalPillar, pillar.normalizedPillar, ...pillar.searchTerms]) ?? []),
  ]);
  const belongsToActiveNiche = (value: string) => profileTerms.some((term) =>
    matchesProfileTerm(value, term) || matchesProfileTerm(term, value),
  );
  return {
    niche: profile.niche,
    profileFingerprint: profile.inputFingerprint ?? '',
    pillarNames: activePillars.map((pillar) => pillar.name),
    pillarSearchTerms: unique(activePillars.flatMap((pillar) => [pillar.description, ...pillar.trendKeywords])),
    entities: profile.importantEntities ?? [],
    entityAliases: profile.entityAliases ?? [],
    platforms: profile.productsAndPlatforms ?? [],
    dynamicCategories: profile.contentCategories?.flatMap((category) => [category.label, ...category.terms]) ?? [],
    monitoredTopics: strategy.profilePositioning.topicsToBeKnownFor.filter(belongsToActiveNiche),
    audienceSignals: unique([...(profile.audienceTypes ?? []), ...(profile.commonProblems ?? []), ...(profile.desiredOutcomes ?? [])]),
    goalSignals: [],
    positioningSignals: [],
  };
}

function matchPillar(text: string, strategy: EffectiveBotStrategy, active?: ActiveNicheStrategyContext): ContentPillar | undefined {
  const pillars = [
    ...strategy.contentPillars.primaryPillars,
    ...strategy.contentPillars.secondaryPillars,
    ...(strategy.contentPillars.experimentalPillars ?? []),
  ];
  const eligible = active ? pillars.filter((pillar) => active.pillarNames.some((name) => normalizeText(name) === normalizeText(pillar.name))) : pillars;
  return eligible.find((pillar) =>
    textMatchesAny(
      text,
      [pillar.name, ...pillar.trendKeywords.filter((keyword) => isUsefulTrendKeyword(keyword, pillar.name)), pillar.description],
    )
    || hasDistinctivePillarToken(text, pillar.name),
  );
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
  options: { recentHistory?: TopicHistoryRow[]; fingerprint?: TopicFingerprint; profile?: NicheExpansionPlan } = {},
): StrategyTrendScore {
  const text = candidateText(candidate);
  const evidenceText = [text, candidate.publisher, candidate.link].filter(Boolean).join(' ');
  const active = options.profile ? buildActiveNicheStrategyContext(strategy, options.profile) : undefined;
  const reasons: string[] = [];
  const riskFlags: string[] = [];
  const breakdown = {
    pillarMatch: 0,
    audienceMatch: 0,
    goalMatch: 0,
    positioningMatch: 0,
    freshness: 0,
    exclusionPenalty: 0,
    finalScore: 0,
    directNicheEvidence: 0,
    categoryMatchScore: 0,
    monitoredTopicScore: 0,
    ambiguityPenalty: 0,
  };

  const excluded = textMatchesAny(text, [
    ...strategy.contentPillars.excludedTopics,
    ...strategy.topicRules.rejectedPatterns,
  ]);
  const profileExcluded = textMatchesAny(text, [
    ...(options.profile?.excludedTerms ?? []),
    ...(options.profile?.excludedInterpretations ?? []),
  ]);
  if (excluded) {
    riskFlags.push(`excluded:${excluded}`);
  }

  const pillar = matchPillar(text, strategy, active);
  const foreignPillars = active
    ? allPillars(strategy).filter((candidatePillar) => !active.pillarNames.includes(candidatePillar.name)
      && (textMatchesAny(text, [candidatePillar.name, ...candidatePillar.trendKeywords]) || hasDistinctivePillarToken(text, candidatePillar.name)))
    : [];
  const category = options.profile?.contentCategories?.find((item) =>
    firstMatchingTerm(evidenceText, [item.label, ...item.terms]),
  );
  const entity = firstMatchingTerm(evidenceText, options.profile?.importantEntities ?? []);
  const alias = firstMatchingAlias(evidenceText, options.profile);
  const platform = firstMatchingTerm(evidenceText, options.profile?.productsAndPlatforms ?? []);
  const problem = firstMatchingTerm(evidenceText, options.profile?.commonProblems ?? []);
  const normalizedPillarTerm = firstMatchingTerm(evidenceText, options.profile?.normalizedPillars?.flatMap((item) => [
    item.originalPillar, item.normalizedPillar, ...item.searchTerms, ...item.relatedEntities, ...item.subtopics,
  ]) ?? []);
  const normalizedEvidence = normalizeText(evidenceText);
  const requiredTerms = options.profile?.requiredContextTerms?.length
    ? options.profile.requiredContextTerms
    : pillar?.name.split(/\s+/).filter((term) => term.length >= 2) ?? [];
  const requiredHits = requiredTerms.filter((term) => matchesProfileTerm(evidenceText, term)).length;
  const normalizedNiche = normalizeText(options.profile?.normalizedNiche ?? options.profile?.niche ?? pillar?.name);
  const directEvidence = unique([
    ...(normalizedNiche && normalizedEvidence.includes(normalizedNiche) ? [`niche:${normalizedNiche}`] : []),
    ...(pillar ? [`pillar:${pillar.name}`] : []),
    ...(category ? [`category:${category.label}`] : []),
    ...(entity ? [`entity:${entity}`] : []),
    ...(platform ? [`platform:${platform}`] : []),
    ...(problem ? [`problem:${problem}`] : []),
    ...(normalizedPillarTerm ? [`profile_pillar_term:${normalizedPillarTerm}`] : []),
  ]);
  const queryEvidence = firstMatchingTerm(queryContext(candidate), [
    ...(options.profile?.importantEntities ?? []),
    ...(options.profile?.productsAndPlatforms ?? []),
    ...(options.profile?.contentCategories?.flatMap((item) => [item.label, ...item.terms]) ?? []),
    ...(options.profile?.commonProblems ?? []),
  ]);
  let directNicheEvidence = 0;
  if (normalizedNiche && normalizedEvidence.includes(normalizedNiche)) directNicheEvidence = 35;
  if (pillar) directNicheEvidence = Math.max(directNicheEvidence, 30);
  if (entity || alias || platform) directNicheEvidence = Math.max(directNicheEvidence, 30);
  if (category || problem || normalizedPillarTerm) directNicheEvidence = Math.max(directNicheEvidence, 25);
  if (directEvidence.length >= 2) directNicheEvidence = Math.min(40, directNicheEvidence + 10);
  if (directNicheEvidence > 0 && queryEvidence) {
    directNicheEvidence = Math.min(40, directNicheEvidence + 5);
    directEvidence.push(`query_context:${queryEvidence}`);
  }
  const monitoredTopics = active?.monitoredTopics ?? strategy.profilePositioning.topicsToBeKnownFor ?? [];
  const monitoredTopic = textMatchesAny(text, monitoredTopics);
  let score = directNicheEvidence;
  breakdown.directNicheEvidence = directNicheEvidence;
  if (pillar) {
    score += 40;
    breakdown.pillarMatch = 40;
    reasons.push(`pillar_match:${pillar.name}`);
  } else if (strategy.legacy.niches.some((niche) => normalizeText(text).includes(normalizeText(niche)))) {
    score += 15;
    breakdown.pillarMatch = 15;
    reasons.push('legacy_niche_match');
  }
  if (category) {
    score += 20;
    breakdown.categoryMatchScore = 20;
    reasons.push(`category_match:${category.id}`);
  }
  if (monitoredTopic) {
    score += 15;
    breakdown.monitoredTopicScore = 15;
    reasons.push(`monitored_topic:${monitoredTopic}`);
  }

  const audienceSignals = active ? active.audienceSignals : [
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
    score += 10;
    breakdown.audienceMatch = 10;
    reasons.push(`audience_match:${audienceMatch}`);
  }

  const goalSignals = active ? active.goalSignals : [
    strategy.contentGoals.primaryGoal,
    ...strategy.contentGoals.secondaryGoals,
    strategy.contentGoals.conversionTarget ?? '',
  ].filter(Boolean);
  if (textMatchesAny(text, goalSignals)) {
    score += 5;
    breakdown.goalMatch = 5;
    reasons.push('content_goal_alignment');
  }

  const positioningSignals = active ? active.positioningSignals : [
    strategy.profilePositioning.positioningStatement,
    strategy.profilePositioning.uniquePointOfView,
    ...strategy.profilePositioning.topicsToBeKnownFor,
  ].filter(Boolean);
  const hasPositioningStrategy = positioningSignals.some((value) => value.trim());
  if (textMatchesAny(text, positioningSignals)) {
    score += 5;
    breakdown.positioningMatch = 5;
    reasons.push('positioning_fit');
  }

  if (candidate.publishedAt) {
    score += 5;
    breakdown.freshness = 5;
    reasons.push('timely_source');
  } else {
    score += 0;
    breakdown.freshness = 0;
  }

  const duplicate = isDuplicateRecentTopic(candidate, options.recentHistory ?? [], strategy);
  if (duplicate) {
    riskFlags.push(`recent_duplicate:${duplicate.id}`);
  }
  if (candidate.discoveryIntent === 'verified_solution'
    && (candidate.evidenceRole === 'problem_discovery' || candidate.evidenceRole === 'question_discovery')
    && !(candidate.supportingSources ?? []).some((source) => source.evidenceRole === 'primary' || source.evidenceRole === 'strong_secondary')) {
    riskFlags.push('community_source_cannot_verify_solution');
  }

  if (excluded) {
    score -= 50;
    breakdown.exclusionPenalty = -50;
  }
  const ambiguityConfigured = Boolean(options.profile?.excludedInterpretations?.length)
    || (normalizedTokens(options.profile?.originalNiche ?? options.profile?.niche ?? '').length === 1 && requiredTerms.length > 1);
  const ambiguousAnchorPresent = normalizedNiche
    ? normalizedTokens(normalizedNiche).some((token) => normalizedTokens(text).includes(token))
    : false;
  const ambiguityResolved = !ambiguityConfigured || !ambiguousAnchorPresent
    || directEvidence.length >= 2 || Boolean(pillar || entity || platform || problem || normalizedPillarTerm || monitoredTopic);
  if (ambiguityConfigured && ambiguousAnchorPresent && !ambiguityResolved && requiredHits === 0) {
    score -= 40;
    breakdown.ambiguityPenalty = -40;
    riskFlags.push('missing_ambiguity_context');
  }
  score = Math.max(0, Math.min(100, score));
  breakdown.finalScore = score;

  const minimumScore = Math.max(65, strategy.topicRules.minimumRelevanceScore);

  const accepted =
    score >= minimumScore
    && !excluded
    && !profileExcluded
    && !(strategy.topicRules.requirePillarMatch && !pillar && strategy.contentPillars.primaryPillars.length > 0)
    && !(strategy.topicRules.requireAudiencePainMatch && !audienceMatch)
    && !duplicate;

  if (!accepted) {
    if (score < minimumScore) riskFlags.push('low_relevance');
    if (strategy.topicRules.requirePillarMatch && !pillar) riskFlags.push('missing_pillar_match');
    if (strategy.topicRules.requireAudiencePainMatch && !audienceMatch) riskFlags.push('missing_audience_match');
  }

  if (profileExcluded) riskFlags.push(`excluded_profile_term:${profileExcluded}`);
  if (options.profile && directNicheEvidence === 0 && !category && !pillar && !entity && !platform && !monitoredTopic) {
    riskFlags.push('niche_classification_failed');
  }

  const nicheMatch: CandidateNicheMatch = {
    relevant: !excluded && !profileExcluded && directNicheEvidence >= 25,
    relevanceScore: score,
    confidence: Math.min(1, (directNicheEvidence + (category ? 20 : 0) + (pillar ? 35 : 0) + (entity || alias || platform ? 20 : 0) + (monitoredTopic ? 15 : 0)) / 100),
    matchedCategory: category?.id ?? null,
    categoryConfidence: category ? 0.8 : 0,
    matchedPillar: pillar?.name ?? null,
    pillarConfidence: pillar ? 0.8 : 0,
    matchedMonitorTopic: monitoredTopic ?? null,
    avoidTopicMatch: excluded ?? profileExcluded ?? null,
    reasons,
    rejectionCodes: [...new Set(riskFlags)],
    directEvidence,
    matchedTerms: directEvidence.map((item) => item.split(':').slice(1).join(':')),
    matchedPlatform: platform ?? null,
    matchedEntity: entity ?? null,
    matchedAlias: alias ?? null,
    matchedForeignPillars: foreignPillars.map((item) => item.name),
    queryIntent: options.profile?.searchIntents?.find((intent) => intent.terms.some((term) => normalizeText(candidate.searchQuery).includes(normalizeText(term))))?.id ?? null,
    ambiguityResolved,
  };

  return {
    score,
    accepted,
    reasons,
    matchedPillar: pillar?.name,
    suggestedAngle: (pillar?.exampleAngles[0] ?? strategy.profilePositioning.uniquePointOfView) || undefined,
    audienceRelevance: pillar?.audienceRelevance || audienceMatch,
    riskFlags,
    breakdown,
    nicheMatch,
  };
}
