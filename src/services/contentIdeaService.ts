import type { ContentIntelligenceProfile } from './contentIntelligenceService';
import type { EffectiveBotStrategy } from './botStrategyService';
import type { IdeaOrigin, RankedTrendCandidate, TopicFingerprint, TrendCandidate } from './generationTypes';
import type { TopicHistoryRow } from './topicHistoryService';
import { jaccardSimilarity } from './ghostwriterTextUtils';
import {
  createRecentContentMemory,
  scoreAgainstRecentContentMemory,
  updateRecentContentMemory,
  type RecentContentMemory,
} from './recentContentMemoryService';
import { classifyHookType } from './finalPostFingerprintClassifier';
import {
  evaluateCandidateCoherence,
  type CandidateCoherenceContext,
  type CandidateCoherenceDecision,
} from './candidateCoherenceService';
import { classifyConceptualMotif } from './conceptualMotifService';

export type IdeaQualityScore = {
  strategyFit: number; audienceValue: number; novelty: number; nonObviousness: number;
  authorityFit: number; specificityPotential: number; usefulTension: number; practicalValue: number;
  discussionPotential: number; freshnessWhenRelevant: number; recentSimilarityRisk: number; composite: number;
};

export type PersonalEvidencePotential = 'NONE' | 'OPTIONAL' | 'STRONGLY_BENEFICIAL';
export type SemanticIdeaCritique = {
  audienceRelevance: number; nonObviousness: number; specificity: number; usefulness: number;
  authorOwnership: number; authorityFit: number; practicalConsequence: number; valueDensity: number;
  shareability: number; discussionPotential: number; noveltyVsRecentContent: number;
  mechanismNovelty: number; defensibility: number;
  audienceIdeaNaturalness?: number;
  creatorContentFit?: number;
};

export type ContentIdeaCandidate = {
  id: string; pillar: string; territory: string; coreClaim: string; mechanism: string;
  perspective: string; ideaFamily: string; origin: IdeaOrigin; authorityMode: import('./contentIntelligenceService').AuthorityMode;
  searchRequired: boolean; score: IdeaQualityScore; saturationPenalty: number; rejectedReasons: string[];
  memoryPenalty?: number; memoryReasons?: string[];
  audienceConsequence?: string;
  evidenceNeed?: 'NONE' | 'CURRENT_FACTS' | 'EXTERNAL_VERIFICATION' | 'USER_EXPERIENCE';
  authorityRequirement?: import('./contentIntelligenceService').AuthorityMode;
  personalEvidencePotential?: PersonalEvidencePotential;
  generationMode?: 'SEMANTIC' | 'DETERMINISTIC_FALLBACK';
  semanticCritique?: SemanticIdeaCritique;
  audienceIdeaNaturalness?: number;
  creatorContentFit?: number;
  candidateCoherence?: CandidateCoherenceDecision['candidateCoherence'];
  coherencePenalty?: number;
  coherenceRejectionReason?: string | null;
  resolvedAudience?: string[];
};

const OBVIOUS = /\b(is important|matters|should be considered|best practices are important|need optimization|testing before launch|adapt(?:s)? as (?:you|the (?:team|company|product)) grow|depends? on context)\b/i;
const BROAD = /^(?:the importance of |an introduction to |understanding )/i;
const GENERIC_FALLBACK = /\b(?:can be challenging|requires careful planning|should evolve over time|adapt(?:s)? as (?:you|the (?:team|company|product)) grow|best practices? should depend on context|it depends on context)\b/i;
const DECISION_SIGNAL = /\b(?:decide|decision|choose|choice|prioriti[sz]e|select|adopt|avoid|stop|start|first|before|after|only when|threshold|criterion)\b/i;
const MECHANISM_SIGNAL = /\b(?:because|causes?|creates?|dictates?|drives?|moves?|shifts?|removes?|reduces?|increases?|prevents?|exposes?|dominates?|amplifies?|constrains?|invalidat(?:e|ion)|bottleneck|feedback loop|handoff|checkpoint|boundary)\b/i;
const PROCESS_SIGNAL = /\b(?:process|workflow|sequence|step|review|measure|monitor|test|validate|compare|diagnostic|signal|check|policy|rule)\b/i;
const CONSEQUENCE_SIGNAL = /\b(?:cost|risk|delay|load|quality|reliability|retention|conversion|revenue|performance|complexity|coordination|rework|failure|outcome|trade-?off|time|capacity)\b/i;
const BOUNDED_SIGNAL = /\b(?:first|before|after|when|unless|only|small|recurring|repeated|per |each |during|at the point|under )\b/i;
const CONTRAST_SIGNAL = /\b(?:but|rather than|instead of|versus|while|until|unless|trade-?off|at the cost of)\b/i;

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function substantiveTokens(value?: string): string[] {
  const stop = new Set('a an and are as at be been but by can for from has have if in is it its may not of on or should than that the their this to was when which will with without'.split(' '));
  return (value ?? '').toLowerCase().match(/[a-z0-9]+/g)?.filter((token) => token.length > 2 && !stop.has(token)) ?? [];
}

function hasMeaningfulContrast(claim: string, mechanism: string): boolean {
  if (!CONTRAST_SIGNAL.test(claim)) return false;
  const parts = claim.split(CONTRAST_SIGNAL).map((part) => substantiveTokens(part).length).filter(Boolean);
  return parts.length >= 2 && parts[0] >= 3 && parts[1] >= 3
    && (MECHANISM_SIGNAL.test(`${claim} ${mechanism}`) || CONSEQUENCE_SIGNAL.test(`${claim} ${mechanism}`));
}

function deterministicDimensions(input: Omit<ContentIdeaCandidate, 'score' | 'rejectedReasons'>, categorySummary: boolean) {
  const claim = input.coreClaim.trim();
  const mechanism = input.mechanism.trim();
  const consequence = input.audienceConsequence?.trim() ?? '';
  const all = `${claim} ${mechanism} ${consequence}`;
  const generic = OBVIOUS.test(claim) || GENERIC_FALLBACK.test(claim);
  const decision = DECISION_SIGNAL.test(all);
  const causalMechanism = MECHANISM_SIGNAL.test(all) && substantiveTokens(mechanism).length >= 2;
  const process = PROCESS_SIGNAL.test(all);
  const consequencePresent = CONSEQUENCE_SIGNAL.test(all);
  const bounded = BOUNDED_SIGNAL.test(claim);
  const meaningfulContrast = hasMeaningfulContrast(claim, mechanism);
  const contentTokenCount = new Set(substantiveTokens(`${claim} ${mechanism}`)).size;
  const consequenceSubstance = consequence
    ? Math.min(20, substantiveTokens(consequence).length * 2 + (CONSEQUENCE_SIGNAL.test(consequence) ? 8 : 0))
    : 0;

  const specificityPotential = clampScore(
    10 + Math.min(20, contentTokenCount * 2) + (causalMechanism ? 22 : 0) + (decision ? 14 : 0)
    + (consequencePresent ? 12 : 0) + (bounded ? 8 : 0) - (generic ? 32 : 0) - (categorySummary ? 35 : 0),
  );
  const nonObviousness = clampScore(
    12 + (causalMechanism ? 28 : 0) + (meaningfulContrast ? 24 : 0) + (consequencePresent ? 14 : 0)
    + (bounded ? 8 : 0) + (contentTokenCount >= 9 ? 10 : 0) - (generic ? 38 : 0) - (categorySummary ? 25 : 0),
  );
  const practicalValue = clampScore(
    8 + (decision ? 24 : 0) + (causalMechanism ? 24 : 0) + (process ? 16 : 0)
    + (consequencePresent ? 14 : 0) + (bounded ? 8 : 0) - (generic ? 25 : 0),
  );
  const usefulTension = clampScore(
    12 + (meaningfulContrast ? 44 : 0) + (meaningfulContrast && causalMechanism ? 18 : 0)
    + (meaningfulContrast && consequencePresent ? 14 : 0) - (generic ? 20 : 0),
  );
  const discussionPotential = clampScore(
    10 + (meaningfulContrast ? 34 : 0) + (causalMechanism ? 18 : 0)
    + (consequencePresent ? 16 : 0) + (decision ? 10 : 0) - (generic ? 18 : 0),
  );
  return { specificityPotential, nonObviousness, practicalValue, usefulTension, discussionPotential, consequenceSubstance };
}

function similarityRisk(claim: string, history: TopicHistoryRow[]): number {
  return Math.round(Math.max(0, ...history.map((row) => jaccardSimilarity(claim, `${row.coreClaim ?? ''} ${row.normalizedTopic}`))) * 100);
}

export function scoreContentIdea(
  input: Omit<ContentIdeaCandidate, 'score' | 'rejectedReasons'>,
  history: TopicHistoryRow[] = [],
  coherence?: CandidateCoherenceDecision,
): { score: IdeaQualityScore; rejectedReasons: string[] } {
  const similarity = similarityRisk(`${input.coreClaim} ${input.mechanism}`, history);
  const wordCount = input.coreClaim.trim().split(/\s+/).length;
  const categorySummary = wordCount < 7 || (/^[\w\s&/-]+\s+for\s+[\w\s&/-]+[.!]?$/i.test(input.coreClaim) && !/\b(should|cannot|can|fails?|changes?|reduces?|increases?|depends?|creates?|removes?|becomes?|starts?|needs?|wins?|fix(?:es)?)\b/i.test(input.coreClaim));
  const dimensions = deterministicDimensions(input, categorySummary || BROAD.test(input.coreClaim));
  const authorityFit = coherence?.candidateCoherence.authorityFramingFit
    ?? (input.authorityMode === 'EXPLICIT_EXPERTISE' ? 95 : input.authorityMode === 'SUPPORTED_PRACTITIONER' ? 85 : input.authorityMode === 'INFERRED_FAMILIARITY' ? 70 : input.authorityMode === 'EXPLORATORY' ? 60 : 45);
  // Strategy fit deliberately excludes authority. The coherence layer has already
  // evaluated creator positioning/monitored topics and pillar/territory details.
  const strategyFit = coherence
    ? clampScore(coherence.creatorContentFit * .62 + coherence.candidateCoherence.pillarClaimFit * .38)
    : 0;
  // Missing coherence is missing relationship evidence, not a neutral score.
  const audienceNaturalness = coherence?.audienceIdeaNaturalness ?? 0;
  const audienceValue = clampScore(audienceNaturalness * .78 + dimensions.consequenceSubstance * 1.1);
  // Evergreen fallback has no time-sensitive freshness requirement by definition;
  // a claim marked as requiring search is incomplete until evidence is attached.
  const freshnessWhenRelevant = input.searchRequired ? 35 : 100;
  const score = {
    strategyFit, audienceValue,
    novelty: 100 - similarity, nonObviousness: dimensions.nonObviousness, authorityFit,
    specificityPotential: dimensions.specificityPotential, usefulTension: dimensions.usefulTension,
    practicalValue: dimensions.practicalValue, discussionPotential: dimensions.discussionPotential, freshnessWhenRelevant,
    recentSimilarityRisk: similarity, composite: 0,
  };
  // Active weights: strategy .18, audience .14, practical .14, specificity .13,
  // non-obviousness .12, novelty .10, authority .09, tension .05,
  // discussion .03, and freshness-when-relevant .02.
  score.composite = clampScore(score.strategyFit * .18 + score.audienceValue * .14 + score.practicalValue * .14
    + score.specificityPotential * .13 + score.nonObviousness * .12 + score.novelty * .10
    + score.authorityFit * .09 + score.usefulTension * .05 + score.discussionPotential * .03
    + score.freshnessWhenRelevant * .02 - input.saturationPenalty);
  const rejectedReasons = [
    score.nonObviousness < 25 ? 'obvious_or_generic' : '',
    score.specificityPotential < 25 ? 'too_broad' : '',
    similarity > 72 ? 'recent_claim_or_mechanism_similarity' : '',
    authorityFit < 50 ? 'unsupported_authority' : '',
    coherence && coherence.audienceIdeaNaturalness < 20 ? 'audience_naturalness_too_low' : '',
    coherence && coherence.creatorContentFit < 20 ? 'creator_content_fit_too_low' : '',
    coherence?.coherenceRejectionReason ?? '',
  ].filter(Boolean);
  return { score, rejectedReasons };
}

function claimFor(territory: string, family: string, problem?: string, outcome?: string): { claim: string; mechanism: string; audienceConsequence?: string } {
  const subject = problem || territory;
  const templates: Record<string, string> = {
    'decision heuristic': `The best ${territory} decision is usually the one that removes ${subject}, not the one with the most features.`,
    'hidden constraint': `${territory} looks flexible until ${subject} starts dictating the surrounding workflow.`,
    'unexpected interaction': `A small change in ${territory} can move the bottleneck into ${subject} instead of removing it.`,
    'trade-off': `The simplest ${territory} option often wins until coordination cost becomes larger than implementation cost.`,
    'misleading best practice': `A ${territory} best practice becomes harmful when it is copied without the constraint that originally justified it.`,
    'implementation lesson': `The first ${territory} improvement should reduce ${subject} before it adds new capability.`,
  };
  return {
    claim: templates[family] ?? `${territory} creates value only when it changes the decision behind ${subject}.`,
    mechanism: subject,
    audienceConsequence: outcome ? `This reduces ${subject} so the reader can ${outcome}.` : undefined,
  };
}

export function buildStrategyIdeaCandidates(profile: ContentIntelligenceProfile, strategy: EffectiveBotStrategy, history: TopicHistoryRow[], count: number): ContentIdeaCandidate[] {
  const recentText = history.slice(0, 20).map((h) => `${h.sourceTitle ?? ''} ${h.normalizedTopic}`).join(' ').toLowerCase();
  const candidates: ContentIdeaCandidate[] = [];
  for (const territory of profile.territoryMap) {
    const recentHits = recentText.split(territory.pillar.toLowerCase()).length - 1 + recentText.split(territory.territory.toLowerCase()).length - 1;
    const saturationPenalty = Math.min(28, recentHits * 7);
    const authority = profile.authorityMap.find((a) => a.territory.toLowerCase() === territory.territory.toLowerCase());
    for (const [index, family] of territory.ideaFamilies.slice(0, 6).entries()) {
      const made = claimFor(
        territory.territory,
        family,
        strategy.targetAudience.painPoints[index % Math.max(1, strategy.targetAudience.painPoints.length)],
        strategy.targetAudience.desiredOutcomes[index % Math.max(1, strategy.targetAudience.desiredOutcomes.length)],
      );
      const base = { id: `${territory.pillar}:${territory.territory}:${family}`, pillar: territory.pillar, territory: territory.territory, coreClaim: made.claim, mechanism: made.mechanism, perspective: profile.ideaStrategy.underusedPerspectives[index % Math.max(1, profile.ideaStrategy.underusedPerspectives.length)] || 'audience decision', ideaFamily: family, origin: 'STRATEGY_DERIVED' as const, authorityMode: authority?.mode ?? 'EXPLORATORY' as const, searchRequired: false, saturationPenalty, audienceConsequence: made.audienceConsequence, generationMode: 'DETERMINISTIC_FALLBACK' as const, personalEvidencePotential: 'NONE' as const };
      const coherence = evaluateCandidateCoherence({
        ...base,
        sourceType: 'strategy_derived',
      }, { strategy, profile });
      const evaluated = scoreContentIdea(base, history, coherence);
      candidates.push({ ...base, ...coherence, ...evaluated });
    }
  }
  return candidates.sort((a, b) => b.score.composite - a.score.composite).slice(0, Math.max(count * 6, count));
}

export function selectDiverseIdeas(
  candidates: ContentIdeaCandidate[],
  count: number,
  memory: RecentContentMemory = createRecentContentMemory(),
): ContentIdeaCandidate[] {
  const selected: ContentIdeaCandidate[] = [];
  const remaining = [...candidates];
  while (selected.length < count && remaining.length) {
    const evaluated = remaining.map((candidate) => {
      const motif = classifyConceptualMotif({
        claim: candidate.coreClaim, mechanism: candidate.mechanism, perspective: candidate.perspective,
        audienceConsequence: candidate.audienceConsequence, ideaFamily: candidate.ideaFamily,
      });
      const penalty = scoreAgainstRecentContentMemory({
        topic: candidate.territory, pillar: candidate.pillar, territory: candidate.territory,
        coreClaim: candidate.coreClaim, mechanism: candidate.mechanism, perspective: candidate.perspective,
        ideaFamily: candidate.ideaFamily, argumentPattern: candidate.ideaFamily, contentIntent: candidate.ideaFamily,
        authorityMode: candidate.authorityMode, hookType: classifyHookType(candidate.coreClaim), origin: 'STRATEGY_DERIVED',
        ...motif,
      }, memory);
      return { candidate, penalty, adjusted: candidate.score.composite - penalty.total };
    }).sort((a, b) => b.adjusted - a.adjusted);
    const viable = evaluated.find(({ candidate }) => (
      (!candidate.rejectedReasons.length || !remaining.some((item) => item.rejectedReasons.length === 0))
      && !selected.some((prior) => (
        jaccardSimilarity(prior.coreClaim, candidate.coreClaim) > .78
        && jaccardSimilarity(prior.mechanism, candidate.mechanism) > .7
      ))
    ));
    if (!viable) break;
    const chosen = {
      ...viable.candidate,
      memoryPenalty: viable.penalty.total,
      memoryReasons: [...viable.penalty.strong, ...viable.penalty.medium, ...viable.penalty.light],
    };
    selected.push(chosen);
    updateRecentContentMemory(memory, {
      topic: chosen.territory, pillar: chosen.pillar, territory: chosen.territory,
      coreClaim: chosen.coreClaim, mechanism: chosen.mechanism, perspective: chosen.perspective,
      ideaFamily: chosen.ideaFamily, argumentPattern: chosen.ideaFamily, contentIntent: chosen.ideaFamily,
      authorityMode: chosen.authorityMode, hookType: classifyHookType(chosen.coreClaim), origin: 'CURRENT_BATCH',
      ...classifyConceptualMotif({ claim: chosen.coreClaim, mechanism: chosen.mechanism, perspective: chosen.perspective, audienceConsequence: chosen.audienceConsequence, ideaFamily: chosen.ideaFamily }),
    });
    remaining.splice(remaining.indexOf(viable.candidate), 1);
  }
  return selected;
}

export function ideaToRankedCandidate(idea: ContentIdeaCandidate): RankedTrendCandidate {
  const fingerprint: TopicFingerprint = { normalizedTopic: idea.territory.toLowerCase(), topicCluster: idea.territory.toLowerCase().replace(/\W+/g, '_'), coreClaim: idea.coreClaim, entities: [idea.pillar, idea.territory], mechanisms: [idea.mechanism] };
  const motif = classifyConceptualMotif({ claim: idea.coreClaim, mechanism: idea.mechanism, perspective: idea.perspective, audienceConsequence: idea.audienceConsequence, ideaFamily: idea.ideaFamily });
  const trend: TrendCandidate = { topic: idea.coreClaim, niche: idea.pillar, originNiche: idea.pillar, summary: idea.coreClaim, suggestedAngle: idea.ideaFamily, audienceRelevance: idea.perspective, source: 'evergreen', sourceType: 'strategy_derived', ideaOrigin: idea.origin, territory: idea.territory, ideaFamily: idea.ideaFamily, authorityMode: idea.authorityMode, searchRequired: idea.searchRequired, ideaQualityScore: idea.score.composite, ideaScoreBreakdown: { strategyFit: idea.score.strategyFit, audienceValue: idea.score.audienceValue, practicalValue: idea.score.practicalValue, discussionPotential: idea.score.discussionPotential, specificity: idea.score.specificityPotential, nonObviousness: idea.score.nonObviousness, authorityFit: idea.score.authorityFit, novelty: idea.score.novelty, fallbackFamily: idea.generationMode === 'DETERMINISTIC_FALLBACK' ? idea.ideaFamily : null }, saturationPenalty: idea.saturationPenalty, audienceConsequence: idea.audienceConsequence, evidenceNeed: idea.evidenceNeed, personalEvidencePotential: idea.personalEvidencePotential, shareabilityHint: idea.semanticCritique?.shareability, ideaGenerationMode: idea.generationMode, audienceIdeaNaturalness: idea.audienceIdeaNaturalness, creatorContentFit: idea.creatorContentFit, candidateCoherence: idea.candidateCoherence, coherencePenalty: idea.coherencePenalty, coherenceRejectionReason: idea.coherenceRejectionReason, resolvedAudience: idea.resolvedAudience, ...motif, fingerprint };
  return { trend, fingerprint, relevanceScore: idea.score.strategyFit, sourceQualityScore: 70, recencyScore: 70, technicalDepthScore: idea.score.specificityPotential, noveltyScore: idea.score.novelty, totalScore: idea.score.composite, novelty: { allowed: idea.rejectedReasons.length === 0, score: idea.score.novelty, reasons: idea.rejectedReasons }, contentType: 'evergreen', matchedPillar: idea.pillar, suggestedAngle: idea.ideaFamily, audienceRelevance: idea.perspective };
}
