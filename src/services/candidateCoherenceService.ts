import type { EffectiveBotStrategy } from './botStrategyService';
import type { AuthorityMode, ContentIntelligenceProfile } from './contentIntelligenceService';
import type { RecentContentFingerprint } from './recentContentMemoryService';

export type CandidateCoherence = {
  audienceIdeaNaturalness: number;
  creatorContentFit: number;
  pillarClaimFit: number;
  sourceClaimFit: number;
  authorityFramingFit: number;
  overall: number;
};

export type CandidateCoherenceDecision = {
  audienceIdeaNaturalness: number;
  creatorContentFit: number;
  candidateCoherence: CandidateCoherence;
  coherencePenalty: number;
  coherenceRejectionReason: string | null;
  resolvedAudience: string[];
};

export type CandidateCoherenceInput = {
  pillar: string;
  territory: string;
  coreClaim: string;
  mechanism?: string | null;
  perspective?: string | null;
  audienceConsequence?: string | null;
  authorityMode: AuthorityMode;
  origin?: string | null;
  sourceType?: string | null;
  sourceText?: string | null;
  semanticAudienceIdeaNaturalness?: number | null;
  semanticCreatorContentFit?: number | null;
};

export type CandidateCoherenceContext = {
  strategy: EffectiveBotStrategy;
  profile: ContentIntelligenceProfile;
  recentContent?: RecentContentFingerprint[];
};

const STOP_WORDS = new Set(
  'a an and are as at be because been best but by can could do does for from generic guide how if in into is it its may more most of on or our should so than that the their them then there these they this tips to under was we what when where which while will with without advice approach business content development industry platform practice solution system technology tool'.split(' '),
);
const CONSEQUENCE_LANGUAGE = /\b(?:decision|choose|prioriti[sz]e|budget|ship|launch|adopt|avoid|reduce|increase|cost|risk|workflow|bottleneck|constraint|outcome|trade-?off|time|revenue|quality|reliability|retention|conversion|performance|maintain|operate|debug|deploy|scale)\b/i;
const FIRST_PERSON_AUTHORITY = /\b(?:i|we|my|our)\s+(?:built|created|achieved|grew|increased|reduced|saved|earned|led|managed|shipped|implemented|helped|advised|found|learned|recommend)\b|\b(?:my|our)\s+(?:clients?|patients?|team|company|projects?|results?)\b/i;

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : 0)));
}

function tokens(value?: string | null, ignored: Set<string> = new Set()): Set<string> {
  const normalized = (value ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ');
  return new Set(normalized.split(/\s+/)
    .map((token) => token.replace(/(?:ies)$/i, 'y').replace(/(?:ed|es|s)$/i, ''))
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token) && !ignored.has(token)));
}

function similarity(left?: string | null, right?: string | null, ignored: Set<string> = new Set()): number {
  const a = tokens(left, ignored);
  const b = tokens(right, ignored);
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  // One shared category word is weak evidence. Multiple contextual matches are
  // required before lexical proximity can look like a semantic relationship.
  return intersection / Math.max(2, Math.min(a.size, b.size));
}

function maxSimilarity(value: string, candidates: Array<string | null | undefined>, ignored = new Set<string>()): number {
  return Math.max(0, ...candidates.map((candidate) => similarity(value, candidate, ignored)));
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function allPillars(strategy: EffectiveBotStrategy) {
  return [
    ...strategy.contentPillars.primaryPillars.map((pillar) => ({ ...pillar, kind: 'primary' as const })),
    ...strategy.contentPillars.secondaryPillars.map((pillar) => ({ ...pillar, kind: 'secondary' as const })),
    ...(strategy.contentPillars.experimentalPillars ?? []).map((pillar) => ({ ...pillar, kind: 'experimental' as const })),
  ];
}

function matchingPillar(input: CandidateCoherenceInput, context: CandidateCoherenceContext) {
  const key = input.pillar.trim().toLowerCase();
  return allPillars(context.strategy).find((pillar) => pillar.name.trim().toLowerCase() === key);
}

function matchingTerritory(input: CandidateCoherenceInput, context: CandidateCoherenceContext) {
  const pillar = input.pillar.trim().toLowerCase();
  const territory = input.territory.trim().toLowerCase();
  return context.profile.territoryMap.find((entry) => (
    entry.pillar.trim().toLowerCase() === pillar
    && entry.territory.trim().toLowerCase() === territory
  ));
}

function scorePillarClaimFit(input: CandidateCoherenceInput, context: CandidateCoherenceContext): number {
  const pillar = matchingPillar(input, context);
  const territory = matchingTerritory(input, context);
  const idea = `${input.coreClaim} ${input.mechanism ?? ''}`;
  const categoryFit = maxSimilarity(idea, [input.pillar, input.territory]);
  const configuredDetail = unique([
    pillar?.description,
    pillar?.audienceRelevance,
    ...(pillar?.exampleAngles ?? []),
    ...(pillar?.trendKeywords ?? []),
    ...(territory?.subterritories ?? []),
  ]);
  const detailFit = maxSimilarity(idea, configuredDetail);
  const mappedRelationship = territory ? 28 : pillar ? 18 : 0;
  const mechanismSubstance = tokens(input.mechanism).size >= 2 ? 8 : 0;
  return clamp(mappedRelationship + categoryFit * 32 + detailFit * 32 + mechanismSubstance);
}

type AudienceScore = { name: string; score: number };

function scoreAudiences(input: CandidateCoherenceInput, context: CandidateCoherenceContext): AudienceScore[] {
  const configuredNames = unique([
    context.strategy.targetAudience.primaryAudience,
    ...(context.strategy.targetAudience.secondaryAudiences ?? []),
    ...context.profile.audienceModel.segments.map((segment) => segment.name),
  ]);
  const territory = matchingTerritory(input, context);
  return configuredNames.map((name) => {
    const segment = context.profile.audienceModel.segments.find((item) => item.name.trim().toLowerCase() === name.toLowerCase());
    const ignored = tokens(name);
    const problems = unique([
      ...(segment?.likelyProblems ?? []),
      ...context.strategy.targetAudience.painPoints,
    ]);
    const outcomes = unique([
      ...(segment?.desiredOutcomes ?? []),
      ...context.strategy.targetAudience.desiredOutcomes,
    ]);
    const descriptors = [...problems, ...outcomes];
    const idea = `${input.coreClaim} ${input.mechanism ?? ''} ${input.perspective ?? ''}`;
    const consequence = input.audienceConsequence ?? '';
    const ideaFit = maxSimilarity(idea, descriptors, ignored);
    const consequenceFit = maxSimilarity(consequence, descriptors, ignored);
    const territoryFit = maxSimilarity(
      `${idea} ${consequence}`,
      territory?.audienceRelevance ?? [],
      ignored,
    );
    const consequenceTokens = tokens(consequence, ignored);
    const materialConsequence = consequenceTokens.size >= 3 && CONSEQUENCE_LANGUAGE.test(consequence) ? 12 : 0;
    const knowledgeFit = segment?.likelyKnowledgeLevel
      && context.strategy.targetAudience.knowledgeLevel === segment.likelyKnowledgeLevel ? 4 : 0;
    return {
      name,
      // The audience label itself is explicitly removed from comparison. A
      // label mention can never manufacture audience relevance.
      score: clamp(12 + ideaFit * 26 + consequenceFit * 34 + territoryFit * 12 + materialConsequence + knowledgeFit),
    };
  });
}

function mergeSemanticSignal(deterministic: number, semantic?: number | null): number {
  if (semantic == null || !Number.isFinite(semantic)) return deterministic;
  const blended = deterministic * .65 + clamp(semantic) * .35;
  // A model score may add nuance, but cannot rescue absence of deterministic
  // relationship evidence.
  return deterministic < 25 ? Math.min(45, clamp(blended)) : clamp(blended);
}

function resolveAudience(scores: AudienceScore[]): string[] {
  const ranked = [...scores].sort((a, b) => b.score - a.score);
  if (!ranked[0] || ranked[0].score < 50) return [];
  return ranked.filter((item) => item.score >= 50 && ranked[0].score - item.score <= 4).map((item) => item.name);
}

function scoreCreatorContentFit(input: CandidateCoherenceInput, context: CandidateCoherenceContext): number {
  const pillar = matchingPillar(input, context);
  const territory = matchingTerritory(input, context);
  // Do not include the assigned territory label here: it may itself be the
  // result of a weak lexical match and therefore cannot prove ownership.
  const idea = `${input.coreClaim} ${input.mechanism ?? ''} ${input.perspective ?? ''}`;
  const positioning = unique([
    context.strategy.profilePositioning.positioningStatement,
    context.strategy.profilePositioning.uniquePointOfView,
    context.profile.identity.positioningSummary,
    context.profile.identity.contentPromise,
  ]);
  const monitoredTopics = unique([
    ...context.strategy.profilePositioning.topicsToBeKnownFor,
    ...context.profile.identity.identityThemes,
  ]);
  const pillarDetails = unique([
    pillar?.description,
    ...(pillar?.exampleAngles ?? []),
    ...(pillar?.trendKeywords ?? []),
    ...(territory?.subterritories ?? []),
  ]);
  const configuredOwnership = pillar?.kind === 'primary' ? 22 : pillar?.kind === 'secondary' ? 16 : pillar ? 10 : 0;
  const positioningFit = maxSimilarity(idea, positioning);
  const monitoredFit = maxSimilarity(idea, monitoredTopics);
  const detailFit = maxSimilarity(idea, pillarDetails);
  const recentFit = configuredOwnership > 0
    ? maxSimilarity(idea, (context.recentContent ?? []).map((item) => `${item.pillar ?? ''} ${item.territory ?? ''} ${item.coreClaim}`))
    : 0;
  return clamp(configuredOwnership + positioningFit * 36 + monitoredFit * 30 + detailFit * 24 + recentFit * 5);
}

function scoreSourceClaimFit(input: CandidateCoherenceInput): number {
  const isSearch = input.sourceType === 'searched'
    || input.origin === 'SEARCH_DISCOVERED' || input.origin === 'RECENT_DEVELOPMENT';
  if (!isSearch) return input.sourceText?.trim() ? clamp(45 + similarity(input.coreClaim, input.sourceText) * 45) : 70;
  if (!input.sourceText?.trim()) return 15;
  const claimFit = similarity(`${input.coreClaim} ${input.mechanism ?? ''}`, input.sourceText);
  return clamp(15 + claimFit * 85);
}

function scoreAuthorityFramingFit(input: CandidateCoherenceInput): number {
  const base: Record<AuthorityMode, number> = {
    EXPLICIT_EXPERTISE: 95,
    SUPPORTED_PRACTITIONER: 88,
    INFERRED_FAMILIARITY: 78,
    EXPLORATORY: 70,
    UNKNOWN: 55,
  };
  const text = `${input.coreClaim} ${input.perspective ?? ''} ${input.audienceConsequence ?? ''}`;
  if (!FIRST_PERSON_AUTHORITY.test(text)) return base[input.authorityMode];
  return input.authorityMode === 'EXPLICIT_EXPERTISE' || input.authorityMode === 'SUPPORTED_PRACTITIONER'
    ? 45
    : 15;
}

function rejectionReason(
  input: CandidateCoherenceInput,
  coherence: CandidateCoherence,
  explicitExploration: boolean,
  deterministic: { audience: number; creator: number },
): string | null {
  if (coherence.authorityFramingFit < 25) return 'COHERENCE_AUTHORITY_FRAMING_UNSUPPORTED';
  const search = input.sourceType === 'searched'
    || input.origin === 'SEARCH_DISCOVERED' || input.origin === 'RECENT_DEVELOPMENT';
  if (search && coherence.sourceClaimFit < 30) return 'COHERENCE_SOURCE_CLAIM_DISCONNECTED';
  if (search && deterministic.creator < 25 && deterministic.audience < 40) {
    return 'COHERENCE_SEARCH_CREATOR_FIT_TOO_LOW';
  }
  if (!explicitExploration
    && deterministic.creator <= 25
    && deterministic.audience <= 25
    && coherence.pillarClaimFit <= 55) {
    return 'COHERENCE_NO_CREATOR_AUDIENCE_CLAIM_RELATIONSHIP';
  }
  if (!explicitExploration && coherence.overall < 34) return 'COHERENCE_OVERALL_TOO_LOW';
  return null;
}

export function evaluateCandidateCoherence(
  input: CandidateCoherenceInput,
  context: CandidateCoherenceContext,
): CandidateCoherenceDecision {
  const audienceScores = scoreAudiences(input, context);
  const deterministicAudience = Math.max(0, ...audienceScores.map((item) => item.score));
  const audienceIdeaNaturalness = mergeSemanticSignal(
    deterministicAudience,
    input.semanticAudienceIdeaNaturalness,
  );
  const deterministicCreator = scoreCreatorContentFit(input, context);
  const creatorContentFit = mergeSemanticSignal(
    deterministicCreator,
    input.semanticCreatorContentFit,
  );
  const pillarClaimFit = scorePillarClaimFit(input, context);
  const sourceClaimFit = scoreSourceClaimFit(input);
  const authorityFramingFit = scoreAuthorityFramingFit(input);
  const overall = clamp(
    audienceIdeaNaturalness * .24
    + creatorContentFit * .28
    + pillarClaimFit * .19
    + sourceClaimFit * .14
    + authorityFramingFit * .15,
  );
  const candidateCoherence = {
    audienceIdeaNaturalness,
    creatorContentFit,
    pillarClaimFit,
    sourceClaimFit,
    authorityFramingFit,
    overall,
  };
  const territory = matchingTerritory(input, context);
  const monitored = maxSimilarity(
    `${input.coreClaim} ${input.mechanism ?? ''} ${input.territory}`,
    context.strategy.profilePositioning.topicsToBeKnownFor,
  ) >= .5;
  const explicitExploration = input.authorityMode === 'EXPLORATORY'
    && Boolean(matchingPillar(input, context))
    && Boolean(territory)
    && monitored
    && audienceIdeaNaturalness >= 50;
  const coherenceRejectionReason = rejectionReason(input, candidateCoherence, explicitExploration, {
    audience: deterministicAudience,
    creator: deterministicCreator,
  });
  const coherencePenalty = coherenceRejectionReason
    ? 40
    : clamp(Math.min(35,
      Math.max(0, 65 - overall) * .55
      + Math.max(0, 40 - creatorContentFit) * .2
      + Math.max(0, 40 - audienceIdeaNaturalness) * .1));
  return {
    audienceIdeaNaturalness,
    creatorContentFit,
    candidateCoherence,
    coherencePenalty,
    coherenceRejectionReason,
    resolvedAudience: resolveAudience(audienceScores),
  };
}
