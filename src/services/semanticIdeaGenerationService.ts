import OpenAI from 'openai';
import { z } from 'zod';
import type { EffectiveBotStrategy } from './botStrategyService';
import type { AuthorityMode, ContentIntelligenceProfile } from './contentIntelligenceService';
import {
  buildStrategyIdeaCandidates,
  scoreContentIdea,
  type ContentIdeaCandidate,
  type IdeaQualityScore,
  type SemanticIdeaCritique,
} from './contentIdeaService';
import type { RecentContentMemory } from './recentContentMemoryService';
import { semanticMemorySimilarity } from './recentContentMemoryService';
import type { TopicHistoryRow } from './topicHistoryService';

const evidenceNeedSchema = z.enum(['NONE', 'CURRENT_FACTS', 'EXTERNAL_VERIFICATION', 'USER_EXPERIENCE']);
const authoritySchema = z.enum(['EXPLICIT_EXPERTISE', 'SUPPORTED_PRACTITIONER', 'INFERRED_FAMILIARITY', 'EXPLORATORY', 'UNKNOWN']);
const personalEvidenceSchema = z.enum(['NONE', 'OPTIONAL', 'STRONGLY_BENEFICIAL']);
const score = z.number().min(0).max(100);
const critiqueSchema = z.object({
  audienceRelevance: score, nonObviousness: score, specificity: score, usefulness: score,
  authorOwnership: score, authorityFit: score, practicalConsequence: score, valueDensity: score,
  shareability: score, discussionPotential: score, noveltyVsRecentContent: score,
  mechanismNovelty: score, defensibility: score,
});
const semanticIdeaSchema = z.object({
  pillar: z.string().min(1).max(160), territory: z.string().min(1).max(200),
  coreClaim: z.string().min(1).max(500), mechanism: z.string().min(1).max(300),
  perspective: z.string().min(1).max(240), audienceConsequence: z.string().min(1).max(400),
  ideaFamily: z.string().min(1).max(160), evidenceNeed: evidenceNeedSchema,
  authorityRequirement: authoritySchema, personalEvidencePotential: personalEvidenceSchema,
  critique: critiqueSchema,
});
const responseSchema = z.object({ ideas: z.array(semanticIdeaSchema).max(48) });

export type SemanticIdeaProvider = (request: {
  system: string;
  payload: Record<string, unknown>;
  maxOutputTokens: number;
}) => Promise<unknown>;

export type SemanticIdeaPoolResult = {
  candidates: ContentIdeaCandidate[];
  source: 'semantic' | 'fallback';
  modelCalls: 0 | 1;
  error?: string;
};

const PERSONAL_ACHIEVEMENT = /\b(i|we|my|our)\s+(built|created|achieved|grew|increased|reduced|saved|earned|led|managed|shipped|implemented|helped|advised|worked with|have seen|learned)\b|\bmy\s+(clients?|patients?|candidates?|team|company|business|practice)\b/i;
const EXPERT_FRAMING = /\b(in my experience|from my work|my clients?|my patients?|i recommend|we found|i have seen|as an expert)\b/i;
const CLICKBAIT = /\b(shocking|secret nobody|will blow your mind|everyone is wrong|never fails|guaranteed|destroy(?:ing)?|terrified|game[- ]changer|you won't believe|100%)\b|!{2,}/i;

type TerritoryInput = ContentIntelligenceProfile['territoryMap'][number] & { authorityMode: AuthorityMode };

export function selectTerritoriesForSemanticIdeas(profile: ContentIntelligenceProfile, maxTerritories = 12): TerritoryInput[] {
  const byPillar = new Map<string, TerritoryInput[]>();
  for (const territory of profile.territoryMap) {
    const authorityMode = profile.authorityMap.find((entry) => entry.territory.toLowerCase() === territory.territory.toLowerCase())?.mode ?? 'EXPLORATORY';
    const list = byPillar.get(territory.pillar) ?? [];
    list.push({ ...territory, authorityMode });
    list.sort((a, b) => b.weight - a.weight);
    byPillar.set(territory.pillar, list);
  }
  const selected: TerritoryInput[] = [];
  let offset = 0;
  while (selected.length < maxTerritories) {
    let added = false;
    for (const list of byPillar.values()) {
      if (list[offset]) { selected.push(list[offset]); added = true; }
      if (selected.length >= maxTerritories) break;
    }
    if (!added) break;
    offset++;
  }
  return selected;
}

function criticToQuality(critique: SemanticIdeaCritique, deterministic: IdeaQualityScore, clickbait: boolean): IdeaQualityScore {
  const shareability = clickbait ? Math.min(25, critique.shareability) : critique.shareability;
  const audienceValue = (critique.audienceRelevance + critique.usefulness + critique.practicalConsequence + critique.valueDensity) / 4;
  const compositeCritic = critique.audienceRelevance * .11 + critique.nonObviousness * .10 + critique.specificity * .11
    + critique.usefulness * .11 + critique.authorOwnership * .08 + critique.authorityFit * .09
    + critique.practicalConsequence * .09 + critique.valueDensity * .10 + shareability * .05
    + critique.discussionPotential * .04 + critique.noveltyVsRecentContent * .05
    + critique.mechanismNovelty * .04 + critique.defensibility * .03;
  return {
    strategyFit: Math.round((critique.authorOwnership + critique.audienceRelevance) / 2),
    audienceValue: Math.round(audienceValue),
    novelty: Math.round((critique.noveltyVsRecentContent + critique.mechanismNovelty) / 2),
    nonObviousness: Math.round(critique.nonObviousness), authorityFit: Math.round(critique.authorityFit),
    specificityPotential: Math.round((critique.specificity + deterministic.specificityPotential) / 2),
    usefulTension: Math.round((critique.nonObviousness + critique.defensibility) / 2),
    practicalValue: Math.round((critique.usefulness + critique.practicalConsequence + critique.valueDensity) / 3),
    discussionPotential: Math.round((critique.discussionPotential + shareability) / 2),
    freshnessWhenRelevant: deterministic.freshnessWhenRelevant,
    recentSimilarityRisk: deterministic.recentSimilarityRisk,
    composite: Math.round(compositeCritic * .65 + deterministic.composite * .35),
  };
}

function balancedCandidates(candidates: ContentIdeaCandidate[], limit: number): ContentIdeaCandidate[] {
  const byPillar = new Map<string, ContentIdeaCandidate[]>();
  for (const candidate of candidates.sort((a, b) => b.score.composite - a.score.composite)) {
    const list = byPillar.get(candidate.pillar) ?? [];
    list.push(candidate); byPillar.set(candidate.pillar, list);
  }
  const output: ContentIdeaCandidate[] = [];
  let offset = 0;
  while (output.length < limit) {
    let added = false;
    for (const list of byPillar.values()) {
      if (list[offset]) { output.push(list[offset]); added = true; }
      if (output.length >= limit) break;
    }
    if (!added) break;
    offset++;
  }
  return output;
}

function parseProviderResponse(value: unknown): z.infer<typeof responseSchema> {
  const parsedValue = typeof value === 'string' ? JSON.parse(value) : value;
  return responseSchema.parse(parsedValue);
}

async function defaultProvider(apiKey: string, request: Parameters<SemanticIdeaProvider>[0]): Promise<unknown> {
  const response = await new OpenAI({ apiKey }).chat.completions.create({
    model: process.env.OPENAI_CONTENT_MODEL || 'gpt-4o-mini',
    temperature: 0.45,
    max_completion_tokens: request.maxOutputTokens,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: request.system }, { role: 'user', content: JSON.stringify(request.payload) }],
  });
  return response.choices[0]?.message?.content || '{}';
}

export async function buildStrategyIdeaCandidatePool(params: {
  profile: ContentIntelligenceProfile;
  strategy: EffectiveBotStrategy;
  history: TopicHistoryRow[];
  recentMemory: RecentContentMemory;
  count: number;
  apiKey?: string | null;
  provider?: SemanticIdeaProvider;
}): Promise<SemanticIdeaPoolResult> {
  const fallback = buildStrategyIdeaCandidates(params.profile, params.strategy, params.history, params.count);
  const key = params.apiKey || process.env.OPENAI_API_KEY;
  if (!params.provider && !key) return { candidates: fallback, source: 'fallback', modelCalls: 0, error: 'semantic_idea_provider_unavailable' };
  const territories = selectTerritoriesForSemanticIdeas(params.profile);
  const desiredIdeas = Math.min(36, Math.max(params.count * 4, territories.length * 2, 8));
  const recentMemory = params.recentMemory.fingerprints.slice(0, 24).map((item) => ({
    pillar: item.pillar, territory: item.territory, coreClaim: item.coreClaim,
    mechanism: item.mechanism, perspective: item.perspective, ideaFamily: item.ideaFamily,
  }));
  const system = [
    'Generate and critique narrow, publishable LinkedIn thoughts in one bounded response. Return JSON: {"ideas": [...]} matching the requested schema.',
    'A thought must assert a specific causal relationship, decision rule, trade-off, mechanism, or practical consequence. Category labels and topic summaries are poor ideas.',
    'Generate genuinely different mechanisms and perspectives, including multiple abstract idea types when only one niche exists. Keep unrelated pillars balanced.',
    'Never invent or imply biography, achievements, clients, patients, projects, results, statistics, or first-person experience. A configured niche is interest, not expertise.',
    'For EXPLORATORY authority, write analytical or question-led claims without expert/practitioner framing. Respect all credibility boundaries.',
    'Idea-family names may be niche-native and do not need to match a fixed taxonomy.',
    'Value density means useful insight per unit of attention, never length. Shareability means the idea is useful or identity-relevant enough to save/send/repost; do not reward controversy, fear, sensationalism, fake certainty, or engagement bait.',
    'personalEvidencePotential only says whether real user evidence could strengthen the idea. It never licenses invented experience.',
    'Critique honestly on 0-100 scales; generic ideas should score poorly.',
  ].join(' ');
  try {
    const raw = await (params.provider ?? ((request) => defaultProvider(key!, request)))({
      system,
      maxOutputTokens: 4200,
      payload: {
        desiredIdeas,
        schema: {
          idea: ['pillar', 'territory', 'coreClaim', 'mechanism', 'perspective', 'audienceConsequence', 'ideaFamily', 'evidenceNeed', 'authorityRequirement', 'personalEvidencePotential', 'critique'],
          evidenceNeed: evidenceNeedSchema.options, authorityRequirement: authoritySchema.options,
          personalEvidencePotential: personalEvidenceSchema.options, critiqueDimensions: Object.keys(critiqueSchema.shape),
        },
        territories,
        audience: params.strategy.targetAudience,
        positioning: params.strategy.profilePositioning,
        identity: params.profile.identity,
        ideaStrategy: params.profile.ideaStrategy,
        recentContentMemory: recentMemory,
      },
    });
    const generated = parseProviderResponse(raw).ideas;
    const territoryLookup = new Map(territories.map((item) => [`${item.pillar.toLowerCase()}|${item.territory.toLowerCase()}`, item]));
    const semantic: ContentIdeaCandidate[] = [];
    for (const [index, idea] of generated.entries()) {
      const territory = territoryLookup.get(`${idea.pillar.toLowerCase()}|${idea.territory.toLowerCase()}`);
      if (!territory) continue;
      const saturationPenalty = Math.min(28, params.history.filter((item) => `${item.normalizedTopic} ${item.topicCluster}`.toLowerCase().includes(idea.territory.toLowerCase())).length * 7);
      const base = {
        id: `semantic:${idea.pillar}:${idea.territory}:${index}`,
        pillar: idea.pillar, territory: idea.territory, coreClaim: idea.coreClaim.trim(), mechanism: idea.mechanism.trim(),
        perspective: idea.perspective.trim(), ideaFamily: idea.ideaFamily.trim() || 'niche-native insight',
        origin: 'STRATEGY_DERIVED' as const, authorityMode: territory.authorityMode,
        searchRequired: idea.evidenceNeed === 'CURRENT_FACTS' || idea.evidenceNeed === 'EXTERNAL_VERIFICATION',
        saturationPenalty,
        audienceConsequence: idea.audienceConsequence.trim(), evidenceNeed: idea.evidenceNeed,
        authorityRequirement: idea.authorityRequirement, personalEvidencePotential: idea.personalEvidencePotential,
        generationMode: 'SEMANTIC' as const, semanticCritique: idea.critique,
      };
      const deterministic = scoreContentIdea(base, params.history);
      const repeatedMechanism = Math.max(0, ...recentMemory.map((recent) => semanticMemorySimilarity(idea.mechanism, recent.mechanism)));
      const clickbait = CLICKBAIT.test(`${idea.coreClaim} ${idea.audienceConsequence}`);
      const inventedExperience = PERSONAL_ACHIEVEMENT.test(`${idea.coreClaim} ${idea.perspective} ${idea.audienceConsequence}`);
      const exploratoryOverreach = territory.authorityMode === 'EXPLORATORY'
        && (idea.authorityRequirement === 'EXPLICIT_EXPERTISE' || idea.authorityRequirement === 'SUPPORTED_PRACTITIONER' || EXPERT_FRAMING.test(`${idea.coreClaim} ${idea.perspective}`));
      const reasons = [...deterministic.rejectedReasons];
      if (inventedExperience) reasons.push('unsupported_authority:invented_personal_achievement');
      if (exploratoryOverreach) reasons.push('authority_boundary:exploratory_expert_framing');
      if (clickbait) reasons.push('clickbait_or_exaggerated_certainty');
      if (repeatedMechanism >= .45) reasons.push('recent_claim_or_mechanism_similarity');
      const quality = criticToQuality(idea.critique, deterministic.score, clickbait);
      if (deterministic.rejectedReasons.some((reason) => reason === 'obvious_or_generic' || reason === 'too_broad')) {
        quality.nonObviousness = Math.min(quality.nonObviousness, 35);
        quality.specificityPotential = Math.min(quality.specificityPotential, 35);
        quality.composite = Math.min(quality.composite, 45);
      }
      if (clickbait) {
        quality.discussionPotential = Math.min(quality.discussionPotential, 30);
        quality.composite = Math.min(quality.composite, 52);
      }
      if (repeatedMechanism >= .45) {
        const penalty = Math.min(38, Math.round(repeatedMechanism * 38));
        quality.novelty = Math.max(0, quality.novelty - penalty);
        quality.recentSimilarityRisk = Math.max(quality.recentSimilarityRisk, Math.round(repeatedMechanism * 100));
        quality.composite -= penalty;
      }
      semantic.push({ ...base, score: quality, rejectedReasons: [...new Set(reasons)] });
    }
    if (!semantic.length) throw new Error('semantic_idea_response_had_no_valid_territories');
    const safeSemantic = balancedCandidates(semantic, Math.max(params.count * 5, params.count));
    return { candidates: [...safeSemantic, ...fallback], source: 'semantic', modelCalls: 1 };
  } catch (error) {
    return { candidates: fallback, source: 'fallback', modelCalls: 1, error: error instanceof Error ? error.message : String(error) };
  }
}
