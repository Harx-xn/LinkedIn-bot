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
};

const OBVIOUS = /\b(is important|matters|should be considered|best practices are important|need optimization|testing before launch)\b/i;
const BROAD = /^(?:the importance of |an introduction to |understanding )/i;

function similarityRisk(claim: string, history: TopicHistoryRow[]): number {
  return Math.round(Math.max(0, ...history.map((row) => jaccardSimilarity(claim, `${row.coreClaim ?? ''} ${row.normalizedTopic}`))) * 100);
}

export function scoreContentIdea(input: Omit<ContentIdeaCandidate, 'score' | 'rejectedReasons'>, history: TopicHistoryRow[] = []): { score: IdeaQualityScore; rejectedReasons: string[] } {
  const similarity = similarityRisk(`${input.coreClaim} ${input.mechanism}`, history);
  const wordCount = input.coreClaim.trim().split(/\s+/).length;
  const nonObviousness = OBVIOUS.test(input.coreClaim) ? 20 : /\b(until|unless|but|instead|rather|only when|cost|trade-off|hidden)\b/i.test(input.coreClaim) ? 85 : 65;
  const categorySummary = wordCount < 7 || (/^[\w\s&/-]+\s+for\s+[\w\s&/-]+[.!]?$/i.test(input.coreClaim) && !/\b(should|cannot|can|fails?|changes?|reduces?|increases?|depends?|creates?|removes?|becomes?|starts?|needs?|wins?|fix(?:es)?)\b/i.test(input.coreClaim));
  const specificityPotential = wordCount >= 8 && wordCount <= 32 && !BROAD.test(input.coreClaim) && !categorySummary ? 80 : 25;
  const authorityFit = input.authorityMode === 'EXPLICIT_EXPERTISE' ? 95 : input.authorityMode === 'SUPPORTED_PRACTITIONER' ? 85 : input.authorityMode === 'INFERRED_FAMILIARITY' ? 70 : input.authorityMode === 'EXPLORATORY' ? 60 : 45;
  const score = {
    strategyFit: 85, audienceValue: 75, novelty: 100 - similarity, nonObviousness, authorityFit,
    specificityPotential, usefulTension: /\b(but|until|instead|trade-off|cost)\b/i.test(input.coreClaim) ? 85 : 55,
    practicalValue: 70, discussionPotential: 65, freshnessWhenRelevant: input.searchRequired ? 70 : 80,
    recentSimilarityRisk: similarity, composite: 0,
  };
  score.composite = Math.round(score.strategyFit * .16 + score.audienceValue * .13 + score.novelty * .14 + score.nonObviousness * .13 + score.authorityFit * .12 + score.specificityPotential * .12 + score.usefulTension * .08 + score.practicalValue * .07 + score.discussionPotential * .03 + score.freshnessWhenRelevant * .02 - input.saturationPenalty);
  const rejectedReasons = [nonObviousness < 40 ? 'obvious_or_generic' : '', specificityPotential < 50 ? 'too_broad' : '', similarity > 72 ? 'recent_claim_or_mechanism_similarity' : '', authorityFit < 50 ? 'unsupported_authority' : ''].filter(Boolean);
  return { score, rejectedReasons };
}

function claimFor(territory: string, family: string, audience: string, problem?: string): { claim: string; mechanism: string } {
  const subject = problem || territory;
  const templates: Record<string, string> = {
    'decision heuristic': `The best ${territory} decision is usually the one that removes a recurring constraint for ${audience}, not the one with the most features.`,
    'hidden constraint': `${territory} looks flexible until ${subject} starts dictating the surrounding workflow.`,
    'unexpected interaction': `A small change in ${territory} can move the bottleneck into ${subject} instead of removing it.`,
    'trade-off': `The simplest ${territory} option often wins until coordination cost becomes larger than implementation cost.`,
    'misleading best practice': `A ${territory} best practice becomes harmful when it is copied without the constraint that originally justified it.`,
    'implementation lesson': `For ${audience}, the first ${territory} improvement should reduce repeated decisions before it adds new capability.`,
  };
  return { claim: templates[family] ?? `${territory} creates value only when it changes a concrete decision for ${audience}.`, mechanism: subject };
}

export function buildStrategyIdeaCandidates(profile: ContentIntelligenceProfile, strategy: EffectiveBotStrategy, history: TopicHistoryRow[], count: number): ContentIdeaCandidate[] {
  const recentText = history.slice(0, 20).map((h) => `${h.sourceTitle ?? ''} ${h.normalizedTopic}`).join(' ').toLowerCase();
  const audience = strategy.targetAudience.primaryAudience || 'the target audience';
  const candidates: ContentIdeaCandidate[] = [];
  for (const territory of profile.territoryMap) {
    const recentHits = recentText.split(territory.pillar.toLowerCase()).length - 1 + recentText.split(territory.territory.toLowerCase()).length - 1;
    const saturationPenalty = Math.min(28, recentHits * 7);
    const authority = profile.authorityMap.find((a) => a.territory.toLowerCase() === territory.territory.toLowerCase());
    for (const [index, family] of territory.ideaFamilies.slice(0, 6).entries()) {
      const made = claimFor(territory.territory, family, audience, strategy.targetAudience.painPoints[index % Math.max(1, strategy.targetAudience.painPoints.length)]);
      const base = { id: `${territory.pillar}:${territory.territory}:${family}`, pillar: territory.pillar, territory: territory.territory, coreClaim: made.claim, mechanism: made.mechanism, perspective: profile.ideaStrategy.underusedPerspectives[index % Math.max(1, profile.ideaStrategy.underusedPerspectives.length)] || 'audience decision', ideaFamily: family, origin: 'STRATEGY_DERIVED' as const, authorityMode: authority?.mode ?? 'EXPLORATORY' as const, searchRequired: false, saturationPenalty, generationMode: 'DETERMINISTIC_FALLBACK' as const, personalEvidencePotential: 'NONE' as const };
      const evaluated = scoreContentIdea(base, history);
      candidates.push({ ...base, ...evaluated });
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
      const penalty = scoreAgainstRecentContentMemory({
        topic: candidate.territory, pillar: candidate.pillar, territory: candidate.territory,
        coreClaim: candidate.coreClaim, mechanism: candidate.mechanism, perspective: candidate.perspective,
        ideaFamily: candidate.ideaFamily, argumentPattern: candidate.ideaFamily, contentIntent: candidate.ideaFamily,
        authorityMode: candidate.authorityMode, hookType: classifyHookType(candidate.coreClaim), origin: 'STRATEGY_DERIVED',
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
    });
    remaining.splice(remaining.indexOf(viable.candidate), 1);
  }
  return selected;
}

export function ideaToRankedCandidate(idea: ContentIdeaCandidate): RankedTrendCandidate {
  const fingerprint: TopicFingerprint = { normalizedTopic: idea.territory.toLowerCase(), topicCluster: idea.territory.toLowerCase().replace(/\W+/g, '_'), coreClaim: idea.coreClaim, entities: [idea.pillar, idea.territory], mechanisms: [idea.mechanism] };
  const trend: TrendCandidate = { topic: idea.coreClaim, niche: idea.pillar, originNiche: idea.pillar, summary: idea.coreClaim, suggestedAngle: idea.ideaFamily, audienceRelevance: idea.perspective, source: 'evergreen', sourceType: 'strategy_derived', ideaOrigin: idea.origin, territory: idea.territory, ideaFamily: idea.ideaFamily, authorityMode: idea.authorityMode, searchRequired: idea.searchRequired, ideaQualityScore: idea.score.composite, saturationPenalty: idea.saturationPenalty, audienceConsequence: idea.audienceConsequence, evidenceNeed: idea.evidenceNeed, personalEvidencePotential: idea.personalEvidencePotential, shareabilityHint: idea.semanticCritique?.shareability, ideaGenerationMode: idea.generationMode, fingerprint };
  return { trend, fingerprint, relevanceScore: idea.score.strategyFit, sourceQualityScore: 70, recencyScore: 70, technicalDepthScore: idea.score.specificityPotential, noveltyScore: idea.score.novelty, totalScore: idea.score.composite, novelty: { allowed: idea.rejectedReasons.length === 0, score: idea.score.novelty, reasons: idea.rejectedReasons }, contentType: 'evergreen', matchedPillar: idea.pillar, suggestedAngle: idea.ideaFamily, audienceRelevance: idea.perspective };
}
