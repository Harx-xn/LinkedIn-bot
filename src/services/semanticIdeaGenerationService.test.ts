import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildEffectiveBotStrategy } from './botStrategyService';
import { buildFallbackContentIntelligence, type ContentIntelligenceProfile } from './contentIntelligenceService';
import { scoreContentIdea, type ContentIdeaCandidate, type SemanticIdeaCritique } from './contentIdeaService';
import { createRecentContentMemory } from './recentContentMemoryService';
import { buildStrategyIdeaCandidatePool, selectTerritoriesForSemanticIdeas, type SemanticIdeaProvider } from './semanticIdeaGenerationService';

function strategy(niches = ['Mycology']) {
  return buildEffectiveBotStrategy({
    description: 'I explain practical decision systems without claiming specialist credentials.', tone: 'Direct', niches: JSON.stringify(niches),
    targetAudience: { primaryAudience: 'independent operators', painPoints: ['unclear decisions'], desiredOutcomes: ['make safer choices'] },
  });
}

const highCritique: SemanticIdeaCritique = {
  audienceRelevance: 88, nonObviousness: 86, specificity: 90, usefulness: 91, authorOwnership: 82,
  authorityFit: 86, practicalConsequence: 89, valueDensity: 92, shareability: 78,
  discussionPotential: 72, noveltyVsRecentContent: 90, mechanismNovelty: 91, defensibility: 87,
};

function profile(niches = ['Mycology']): ContentIntelligenceProfile {
  const built = buildFallbackContentIntelligence(strategy(niches));
  built.authorityMap = built.authorityMap.map((item) => ({ ...item, mode: 'EXPLORATORY' }));
  return built;
}

function idea(input: Partial<Record<string, unknown>> = {}) {
  return {
    pillar: 'Mycology', territory: 'Mycology',
    coreClaim: 'A field log becomes useful only when it records failed observations alongside successful identifications.',
    mechanism: 'negative observations narrow later identification choices', perspective: 'decision quality under uncertainty',
    audienceConsequence: 'Operators can avoid repeating an attractive but unsupported identification.',
    ideaFamily: 'negative evidence log', evidenceNeed: 'NONE', authorityRequirement: 'EXPLORATORY',
    personalEvidencePotential: 'OPTIONAL', critique: highCritique, ...input,
  };
}

function provider(ideas: unknown[]): SemanticIdeaProvider {
  return async () => ({ ideas });
}

async function pool(ideas: unknown[], overrides: Partial<Parameters<typeof buildStrategyIdeaCandidatePool>[0]> = {}) {
  const s = strategy(); const p = profile();
  return buildStrategyIdeaCandidatePool({ profile: p, strategy: s, history: [], recentMemory: createRecentContentMemory(), count: 3, provider: provider(ideas), ...overrides });
}

function semantic(result: Awaited<ReturnType<typeof pool>>) {
  return result.candidates.filter((candidate) => candidate.generationMode === 'SEMANTIC');
}

describe('semantic strategy idea generation', () => {
  it('scores generic category claims poorly', async () => {
    const result = await pool([idea({ coreClaim: 'Mycology for independent operators', mechanism: 'general education' })]);
    const generated = semantic(result)[0];
    assert.ok(generated.score.composite <= 45);
    assert.ok(generated.rejectedReasons.includes('too_broad'));
  });

  it('ranks a narrow useful claim above a category summary', async () => {
    const result = await pool([
      idea({ coreClaim: 'Mycology for independent operators', mechanism: 'general education' }),
      idea(),
    ]);
    const generated = semantic(result);
    assert.ok(generated.find((item) => item.coreClaim.startsWith('A field log'))!.score.composite
      > generated.find((item) => item.coreClaim.startsWith('Mycology for'))!.score.composite);
  });

  it('retains genuinely different mechanisms from different territories', async () => {
    const s = strategy(['Mycology', 'Contract Negotiation']);
    const p = profile(['Mycology', 'Contract Negotiation']);
    const result = await pool([
      idea(),
      idea({ pillar: 'Contract Negotiation', territory: 'Contract Negotiation', coreClaim: 'A renewal clause changes leverage before it changes price.', mechanism: 'renewal timing shifts exit leverage' }),
    ], { strategy: s, profile: p });
    assert.equal(new Set(semantic(result).map((item) => item.mechanism)).size, 2);
  });

  it('marks invented personal achievements as an unsupported-authority violation', async () => {
    const result = await pool([idea({ coreClaim: 'I increased identification accuracy by 80% for my clients.', mechanism: 'my proprietary review process' })]);
    assert.ok(semantic(result)[0].rejectedReasons.some((reason) => reason.startsWith('unsupported_authority')));
  });

  it('restricts expert framing under exploratory authority', async () => {
    const result = await pool([idea({ coreClaim: 'In my experience, this is the only identification method that works.', authorityRequirement: 'EXPLICIT_EXPERTISE' })]);
    assert.ok(semantic(result)[0].rejectedReasons.some((reason) => reason.startsWith('authority_boundary')));
  });

  it('reduces rank when a recent mechanism is repeated', async () => {
    const memory = createRecentContentMemory([{ topic: 'Logs', coreClaim: 'Record failures as well as successes', mechanism: 'negative observations narrow later identification choices' }]);
    const result = await pool([
      idea(),
      idea({ coreClaim: 'An explicit uncertainty range prevents teams from making an irreversible classification before the evidence can support it.', mechanism: 'confidence ranges delay irreversible classification' }),
    ], { recentMemory: memory });
    const generated = semantic(result);
    const repeated = generated.find((item) => item.mechanism.startsWith('negative observations'))!;
    const novel = generated.find((item) => item.mechanism.startsWith('confidence ranges'))!;
    assert.ok(repeated.score.composite < novel.score.composite);
    assert.ok(repeated.rejectedReasons.includes('recent_claim_or_mechanism_similarity'));
  });

  it('does not reward clickbait as shareability', async () => {
    const result = await pool([
      idea({ coreClaim: 'This shocking mycology secret will blow your mind!!', mechanism: 'sensational framing' }),
      idea(),
    ]);
    const generated = semantic(result);
    const clickbait = generated.find((item) => item.coreClaim.startsWith('This shocking'))!;
    const useful = generated.find((item) => item.coreClaim.startsWith('A field log'))!;
    assert.ok(clickbait.score.composite < useful.score.composite);
    assert.ok(clickbait.rejectedReasons.includes('clickbait_or_exaggerated_certainty'));
  });

  it('keeps an unknown niche-native family usable', async () => {
    const result = await pool([idea({ ideaFamily: 'specimen ambiguity budget' })]);
    assert.equal(semantic(result)[0].ideaFamily, 'specimen ambiguity budget');
    assert.equal(semantic(result)[0].rejectedReasons.length, 0);
  });

  it('uses marked deterministic fallbacks when the single semantic call fails', async () => {
    let calls = 0;
    const failing: SemanticIdeaProvider = async () => { calls++; throw new Error('provider unavailable'); };
    const s = strategy();
    const result = await buildStrategyIdeaCandidatePool({ profile: profile(), strategy: s, history: [], recentMemory: createRecentContentMemory(), count: 3, provider: failing });
    assert.equal(calls, 1);
    assert.equal(result.source, 'fallback');
    assert.ok(result.candidates.length >= 3);
    assert.ok(result.candidates.every((candidate) => candidate.generationMode === 'DETERMINISTIC_FALLBACK'));
  });

  it('produces multiple distinct idea types for a one-niche strategy in one call', async () => {
    let calls = 0;
    const p: SemanticIdeaProvider = async () => { calls++; return { ideas: [
      idea({ ideaFamily: 'decision threshold', mechanism: 'confidence threshold delays classification' }),
      idea({ coreClaim: 'Preservation choices determine which later observations remain possible.', ideaFamily: 'path dependency', mechanism: 'preservation removes future evidence' }),
      idea({ coreClaim: 'A comparison set is more useful than a single confident label.', ideaFamily: 'comparative diagnosis', mechanism: 'alternatives expose discriminating evidence' }),
    ] }; };
    const s = strategy();
    const result = await buildStrategyIdeaCandidatePool({ profile: profile(), strategy: s, history: [], recentMemory: createRecentContentMemory(), count: 3, provider: p });
    assert.equal(calls, 1);
    assert.equal(new Set(semantic(result).map((item) => item.ideaFamily)).size, 3);
  });

  it('keeps three unrelated pillars balanced', async () => {
    const niches = ['Mycology', 'Contract Negotiation', 'Athletic Recovery'];
    const selected = selectTerritoriesForSemanticIdeas(profile(niches), 3);
    assert.deepEqual(new Set(selected.map((item) => item.pillar)), new Set(niches));
    const s = strategy(niches); const p = profile(niches);
    const result = await pool([
      idea(),
      idea({ pillar: 'Contract Negotiation', territory: 'Contract Negotiation', coreClaim: 'Renewal timing changes leverage before price.', mechanism: 'renewal timing shifts exit leverage' }),
      idea({ pillar: 'Athletic Recovery', territory: 'Athletic Recovery', coreClaim: 'Training volume is productive only while recovery preserves the next session.', mechanism: 'recovery capacity constrains useful volume' }),
    ], { strategy: s, profile: p });
    assert.equal(new Set(semantic(result).slice(0, 3).map((item) => item.pillar)).size, 3);
  });

  it('remains niche-generic for an arbitrary configured domain', async () => {
    const niche = 'Ceramic Glaze Documentation';
    const s = strategy([niche]); const p = profile([niche]);
    const custom = idea({ pillar: niche, territory: niche, coreClaim: 'A firing note is useful only when it records the conditions that could falsify the recipe.', mechanism: 'falsifiable process records isolate variation' });
    const result = await pool([custom], { strategy: s, profile: p });
    assert.equal(semantic(result)[0].pillar, niche);
    assert.equal(semantic(result)[0].mechanism, 'falsifiable process records isolate variation');
  });
});

describe('deterministic generic scoring guard', () => {
  it('keeps topic labels below narrow claims without a semantic provider', () => {
    const base = { id: 'x', pillar: 'Any', territory: 'Any', mechanism: 'mechanism', perspective: 'audience', ideaFamily: 'custom', origin: 'STRATEGY_DERIVED' as const, authorityMode: 'EXPLORATORY' as const, searchRequired: false, saturationPenalty: 0 };
    const generic = scoreContentIdea({ ...base, coreClaim: 'Patient retention' } as Omit<ContentIdeaCandidate, 'score' | 'rejectedReasons'>, []);
    const narrow = scoreContentIdea({ ...base, coreClaim: 'A reminder cannot improve retention when uncertainty after the appointment is the binding constraint.' } as Omit<ContentIdeaCandidate, 'score' | 'rejectedReasons'>, []);
    assert.ok(generic.score.composite < narrow.score.composite);
  });
});
