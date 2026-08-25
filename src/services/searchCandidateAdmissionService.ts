import type { EffectiveBotStrategy } from './botStrategyService';
import type { CandidateCoherence } from './candidateCoherenceService';
import type { CandidateNicheMatch, NicheExpansionPlan, TrendCandidate } from './generationTypes';

export type SearchDisposition =
  | 'NEW_IDEA_CANDIDATE'
  | 'EVIDENCE_ONLY'
  | 'REJECTED_FOR_CREATOR_FIT'
  | 'REJECTED_FOR_WEAK_TRANSFORMABILITY';

export type SearchAdmissionDecision = {
  subjectRelevance: number;
  creatorContentFit: number;
  audienceIdeaNaturalness: number;
  sourceClaimTransformability: number;
  candidateCoherence: CandidateCoherence;
  searchDisposition: SearchDisposition;
  searchRejectionReason: string | null;
  evidenceOnly: boolean;
};

const STOP_WORDS = new Set('a an and are as at be been best but by can do does for from guide how if in into is it its may more most of on or should than that the their them this to was we what when where which while will with without industry business development company content'.split(' '));
const CHANGE = /\b(?:release[ds]?|launch(?:es|ed)?|introduc(?:e|es|ed)|update[ds]?|change[sd]?|deprecat(?:e|es|ed|ion)|migrat(?:e|es|ed|ion)|revis(?:e|es|ed|ion)|policy|regulation|framework|version|standard|guidance|study|research|benchmark|report|discovers?|finds?|adds?|removes?)\b/i;
const IMPACT = /\b(?:workflow|architecture|implementation|migration|compatibility|performance|security|reliability|cost|risk|load|latency|quality|retention|conversion|revenue|deadline|compliance|approval|handoff|bottleneck|constraint|decision|process|practice|invalidation|deployment|operation)\b/i;
const CAUSAL = /\b(?:causes?|creates?|changes?|reduces?|increases?|moves?|shifts?|prevents?|requires?|forces?|allows?|blocks?|affects?|means?|because|therefore|so that|leads? to)\b/i;
const WEAK_EVENT = /\b(?:mixer|meetup|networking|conference|summit|expo|gala|awards?|celebration|festival|social event|community event)\b/i;
const FINANCIAL_ONLY = /\b(?:valuation|stock price|market cap|share price|funding round|acquisition price|earnings call)\b/i;
const AUDIENCE_IMPACT = /\b(?:avoid|reduce|increase|ship|choose|decide|budget|prioriti[sz]e|operate|adopt|migrate|comply|save|improve|prevent|manage|measure)\b/i;

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : 0)));
}

function tokens(value?: string | null, ignored = new Set<string>()): Set<string> {
  return new Set(((value ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .map((token) => token.replace(/ies$/i, 'y').replace(/(?:ing|ed|es|s)$/i, ''))
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token) && !ignored.has(token)));
}

function coverage(value: string, reference?: string | null, ignored = new Set<string>()): number {
  const source = tokens(value, ignored);
  const target = tokens(reference, ignored);
  if (!source.size || !target.size) return 0;
  return [...target].filter((token) => source.has(token)).length / Math.max(2, target.size);
}

function maximumCoverage(value: string, references: Array<string | null | undefined>, ignored = new Set<string>()): number {
  return Math.max(0, ...references.map((reference) => coverage(value, reference, ignored)));
}

function sourceText(candidate: TrendCandidate): string {
  return [candidate.rawTitle, candidate.topic, candidate.summary, ...(candidate.keyPoints ?? [])].filter(Boolean).join(' ');
}

function relevantPillars(strategy: EffectiveBotStrategy, match?: CandidateNicheMatch) {
  const pillars = [
    ...strategy.contentPillars.primaryPillars,
    ...strategy.contentPillars.secondaryPillars,
    ...(strategy.contentPillars.experimentalPillars ?? []),
  ];
  if (!match?.matchedPillar) return pillars;
  return pillars.filter((pillar) => pillar.name.toLowerCase() === match.matchedPillar?.toLowerCase());
}

function goalFit(text: string, strategy: EffectiveBotStrategy): number {
  const informational = CHANGE.test(text) || IMPACT.test(text) || CAUSAL.test(text);
  if ((strategy.contentGoals.primaryGoal === 'education' || strategy.contentGoals.primaryGoal === 'authority') && informational) return 8;
  if (strategy.contentGoals.primaryGoal === 'community' && /\b(?:survey|debate|practice|community|adoption)\b/i.test(text)) return 8;
  if ((strategy.contentGoals.primaryGoal === 'product_awareness' || strategy.contentGoals.primaryGoal === 'leads') && IMPACT.test(text)) return 6;
  return 0;
}

export function evaluateSearchCandidateAdmission(input: {
  candidate: TrendCandidate;
  strategy: EffectiveBotStrategy;
  profile: NicheExpansionPlan;
  subjectRelevance: number;
  sourceQuality: number;
  nicheMatch?: CandidateNicheMatch;
}): SearchAdmissionDecision {
  const text = sourceText(input.candidate);
  const subjectRelevance = clamp(input.subjectRelevance);
  const pillars = relevantPillars(input.strategy, input.nicheMatch);
  const positioning = [
    input.strategy.profilePositioning.positioningStatement,
    input.strategy.profilePositioning.uniquePointOfView,
  ];
  const monitored = input.strategy.profilePositioning.topicsToBeKnownFor;
  const pillarContext = pillars.flatMap((pillar) => [
    pillar.description, pillar.audienceRelevance, ...pillar.exampleAngles, ...pillar.trendKeywords,
  ]);
  const profileContext = [
    ...(input.profile.subtopics ?? []), ...(input.profile.terminology ?? []),
    ...(input.profile.commonProblems ?? []), ...(input.profile.desiredOutcomes ?? []),
    ...(input.profile.normalizedPillars?.flatMap((pillar) => [pillar.description, ...pillar.subtopics, ...pillar.searchTerms]) ?? []),
  ];
  const sourceHasUsefulChange = CHANGE.test(text);
  const sourceHasImpact = IMPACT.test(text);
  const sourceHasCausality = CAUSAL.test(text);
  const contextualFit = Math.max(maximumCoverage(text, pillarContext), maximumCoverage(text, profileContext));
  const creatorContentFit = clamp(
    maximumCoverage(text, positioning) * 34
    + maximumCoverage(text, monitored) * 26
    + contextualFit * 24
    + (subjectRelevance >= 65 ? 8 : 0)
    + (sourceHasUsefulChange && sourceHasImpact ? 10 : 0)
    + goalFit(text, input.strategy),
  );

  // Audience labels are removed from comparison. Only configured problems,
  // outcomes, roles and source-supported consequences can create naturalness.
  const audienceLabels = tokens([
    input.strategy.targetAudience.primaryAudience,
    ...(input.strategy.targetAudience.secondaryAudiences ?? []),
  ].join(' '));
  const audienceReferences = [
    ...input.strategy.targetAudience.painPoints,
    ...input.strategy.targetAudience.desiredOutcomes,
    ...input.strategy.targetAudience.objectionsOrMisbeliefs,
    ...(input.profile.commonProblems ?? []),
    ...(input.profile.desiredOutcomes ?? []),
  ];
  const audienceRelationship = maximumCoverage(text, audienceReferences, audienceLabels);
  const audienceIdeaNaturalness = clamp(
    audienceRelationship * 78
    + (audienceRelationship > 0 && AUDIENCE_IMPACT.test(text) ? 14 : 0)
    + (audienceRelationship >= .5 && sourceHasCausality ? 8 : 0),
  );

  const detailTokens = tokens(`${input.candidate.summary ?? ''} ${(input.candidate.keyPoints ?? []).join(' ')}`).size;
  const concreteDetail = Math.min(16, detailTokens * 2);
  const boundedChange = /\b(?:\d+(?:\.\d+)*|before|after|from|to|within|effective|deadline|version)\b/i.test(text);
  const eventPenalty = WEAK_EVENT.test(text) ? 45 : 0;
  const financialPenalty = FINANCIAL_ONLY.test(text) && !sourceHasImpact ? 38 : 0;
  const categorySummary = tokens(input.candidate.topic).size < 4 && !sourceHasUsefulChange && !sourceHasCausality;
  const sourceClaimTransformability = clamp(
    8 + (sourceHasUsefulChange ? 24 : 0) + (sourceHasImpact ? 24 : 0)
    + (sourceHasCausality ? 18 : 0) + concreteDetail + (boundedChange ? 10 : 0)
    - eventPenalty - financialPenalty - (categorySummary ? 25 : 0),
  );

  const authorityFramingFit = 70; // Search claims are exploratory until later authority evaluation.
  const sourceClaimFit = sourceClaimTransformability;
  const pillarClaimFit = subjectRelevance;
  const overall = clamp(
    subjectRelevance * .25 + creatorContentFit * .30 + audienceIdeaNaturalness * .15
    + sourceClaimTransformability * .30,
  );
  const candidateCoherence: CandidateCoherence = {
    audienceIdeaNaturalness, creatorContentFit, pillarClaimFit, sourceClaimFit,
    authorityFramingFit, overall,
  };

  const factuallyUseful = subjectRelevance >= 50 && input.sourceQuality >= 45;
  let searchDisposition: SearchDisposition = 'NEW_IDEA_CANDIDATE';
  let searchRejectionReason: string | null = null;
  if (subjectRelevance < 45) {
    searchDisposition = 'REJECTED_FOR_CREATOR_FIT';
    searchRejectionReason = 'SEARCH_SUBJECT_RELEVANCE_SUPERFICIAL';
  } else if (creatorContentFit < 22) {
    searchDisposition = factuallyUseful ? 'EVIDENCE_ONLY' : 'REJECTED_FOR_CREATOR_FIT';
    searchRejectionReason = 'SEARCH_CREATOR_CONTENT_FIT_TOO_LOW';
  } else if (sourceClaimTransformability < 30) {
    searchDisposition = factuallyUseful ? 'EVIDENCE_ONLY' : 'REJECTED_FOR_WEAK_TRANSFORMABILITY';
    searchRejectionReason = 'SEARCH_SOURCE_CLAIM_TRANSFORMABILITY_TOO_LOW';
  } else if (overall < 30 || creatorContentFit < 30) {
    searchDisposition = factuallyUseful ? 'EVIDENCE_ONLY' : 'REJECTED_FOR_CREATOR_FIT';
    searchRejectionReason = 'SEARCH_CANDIDATE_COHERENCE_TOO_LOW';
  }
  return {
    subjectRelevance, creatorContentFit, audienceIdeaNaturalness, sourceClaimTransformability,
    candidateCoherence, searchDisposition, searchRejectionReason,
    evidenceOnly: searchDisposition === 'EVIDENCE_ONLY',
  };
}
