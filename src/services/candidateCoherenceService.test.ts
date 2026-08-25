import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EffectiveBotStrategy } from './botStrategyService';
import type { ContentIntelligenceProfile } from './contentIntelligenceService';
import type { RankedTrendCandidate } from './generationTypes';
import { evaluateCandidateCoherence, type CandidateCoherenceContext } from './candidateCoherenceService';
import { normalizeBatchCandidate, selectUnifiedBatchCandidates } from './unifiedBatchCandidateService';
import { buildDeterministicBatchPlan } from './ghostwriterBatchPlanner';
import { buildPlanBlock } from './ghostwriterPrompts';

function strategy(overrides: Partial<EffectiveBotStrategy> = {}): EffectiveBotStrategy {
  return {
    profilePositioning: {
      positioningStatement: 'Practical perspectives on real-time production workflows and reliable release systems',
      credibilityPoints: [],
      uniquePointOfView: 'Production constraints should shape technical decisions',
      topicsToBeKnownFor: ['real-time production workflows', 'reliable release systems'],
    },
    targetAudience: {
      primaryAudience: 'Independent studio teams',
      secondaryAudiences: ['Platform reliability leads'],
      roles: [], industries: [], companyStage: [],
      painPoints: ['slow asset iteration blocks playable builds'],
      desiredOutcomes: ['ship smaller reliable releases'],
      objectionsOrMisbeliefs: [], knowledgeLevel: 'intermediate',
    },
    contentGoals: { primaryGoal: 'authority', secondaryGoals: [], preferredCTAStyle: 'no_cta' },
    contentPillars: {
      primaryPillars: [{
        name: 'Real-time Production',
        description: 'Build pipelines, asset delivery, runtime debugging, and release reliability',
        audienceRelevance: 'Helps production teams shorten playable-build feedback loops',
        exampleAngles: ['asset pipeline bottlenecks', 'build iteration failures'],
        trendKeywords: ['runtime build pipeline', 'asset delivery'],
      }],
      secondaryPillars: [{
        name: 'Application Delivery',
        description: 'Deployment boundaries and maintainable web release workflows',
        audienceRelevance: 'Reliable delivery decisions for software teams',
        exampleAngles: ['release workflow'], trendKeywords: ['web delivery'],
      }],
      experimentalPillars: [], excludedTopics: [],
    },
    topicRules: { minimumRelevanceScore: 50, requireAudiencePainMatch: false, requirePillarMatch: true, avoidDuplicateAngles: true, avoidRecentTopicsDays: 30, rejectedPatterns: [] },
    writingStyle: { tone: ['analytical'], formality: 'balanced', postLength: 'medium', preferredFormats: [], avoidStyles: [] },
    legacy: { niches: ['Real-time Production', 'Application Delivery'], sources: [] },
    ...overrides,
  };
}

function profile(): ContentIntelligenceProfile {
  return {
    identity: {
      positioningSummary: 'Real-time production workflows and reliable release systems',
      contentPromise: 'Constraint-aware production engineering ideas',
      identityThemes: ['real-time production workflows', 'reliable release systems'],
      expertiseSignals: [], explorationSignals: ['delivery experiments'], credibilityBoundaries: [],
    },
    audienceModel: { segments: [
      { name: 'Independent studio teams', likelyProblems: ['slow asset iteration blocks playable builds', 'large patch downloads delay players'], desiredOutcomes: ['shorter playable-build feedback loops'], likelyKnowledgeLevel: 'intermediate' },
      { name: 'Platform reliability leads', likelyProblems: ['deployment incidents and rollback delays'], desiredOutcomes: ['safer service releases'], likelyKnowledgeLevel: 'expert' },
    ] },
    authorityMap: [
      { territory: 'Asset Delivery', mode: 'INFERRED_FAMILIARITY', confidence: .7, evidence: [] },
      { territory: 'Web Release Workflow', mode: 'EXPLORATORY', confidence: .4, evidence: [] },
    ],
    territoryMap: [
      { pillar: 'Real-time Production', territory: 'Asset Delivery', subterritories: ['content hashing', 'patch delivery', 'playable build pipeline'], audienceRelevance: ['shorter playable-build feedback loops'], ideaFamilies: ['production constraint'], weight: .6 },
      { pillar: 'Application Delivery', territory: 'Web Release Workflow', subterritories: ['deployment boundaries', 'release workflow'], audienceRelevance: ['reliable software delivery'], ideaFamilies: ['implementation lesson'], weight: .4 },
    ],
    ideaStrategy: { preferredIdeaFamilies: [], avoidedIdeaPatterns: [], underusedPerspectives: [] },
    distributionStrategy: { pillarWeights: {}, territoryWeights: {} },
    version: 1, confidence: .8,
  };
}

function context(customStrategy = strategy(), customProfile = profile()): CandidateCoherenceContext {
  return { strategy: customStrategy, profile: customProfile, recentContent: [] };
}

const genericWebIdea = {
  pillar: 'Application Delivery', territory: 'Web Release Workflow',
  coreClaim: 'Websites should follow proven best practices before launch.',
  mechanism: 'generic launch checklist', perspective: 'general advice',
  authorityMode: 'EXPLORATORY' as const, sourceType: 'strategy_derived',
};

test('generic advice plus an unrelated audience scores poorly', () => {
  const result = evaluateCandidateCoherence(genericWebIdea, context());
  assert.ok(result.audienceIdeaNaturalness < 40);
  assert.deepEqual(result.resolvedAudience, []);
});

test('a real audience-specific consequence improves naturalness', () => {
  const generic = evaluateCandidateCoherence(genericWebIdea, context());
  const specific = evaluateCandidateCoherence({
    ...genericWebIdea,
    audienceConsequence: 'Slow asset iteration blocks playable builds and increases release risk.',
  }, context());
  assert.ok(specific.audienceIdeaNaturalness >= generic.audienceIdeaNaturalness + 20);
});

test('an audience name mention cannot manufacture naturalness', () => {
  const plain = evaluateCandidateCoherence(genericWebIdea, context());
  const labeled = evaluateCandidateCoherence({
    ...genericWebIdea,
    coreClaim: `${genericWebIdea.coreClaim} Independent studio teams.`,
  }, context());
  assert.equal(labeled.audienceIdeaNaturalness, plain.audienceIdeaNaturalness);
});

test('generic delivery advice is weaker than an audience-native workflow', () => {
  const generic = evaluateCandidateCoherence(genericWebIdea, context());
  const native = evaluateCandidateCoherence({
    pillar: 'Real-time Production', territory: 'Asset Delivery',
    coreClaim: 'Content hashing in the playable-build pipeline prevents unchanged assets from inflating every patch.',
    mechanism: 'content hashing and patch delivery',
    perspective: 'production constraint',
    audienceConsequence: 'Smaller patch downloads shorten player wait time and speed playable-build feedback.',
    authorityMode: 'INFERRED_FAMILIARITY', sourceType: 'strategy_derived',
  }, context());
  assert.ok(native.audienceIdeaNaturalness > generic.audienceIdeaNaturalness, JSON.stringify({ generic, native }));
  assert.ok(native.creatorContentFit > generic.creatorContentFit, JSON.stringify({ generic, native }));
  assert.equal(native.coherenceRejectionReason, null);
});

test('industry-adjacent news does not automatically belong to a configured creator pillar', () => {
  const result = evaluateCandidateCoherence({
    pillar: 'Real-time Production', territory: 'Asset Delivery',
    coreClaim: 'A regional entertainment networking mixer announced a new sponsor.',
    mechanism: 'event sponsorship', perspective: 'industry news',
    authorityMode: 'EXPLORATORY', sourceType: 'searched', origin: 'RECENT_DEVELOPMENT',
    sourceText: 'Regional entertainment networking mixer announces sponsor and venue',
  }, context());
  assert.ok(result.creatorContentFit < 30, JSON.stringify(result));
  assert.equal(result.coherenceRejectionReason, 'COHERENCE_SEARCH_CREATOR_FIT_TOO_LOW');
});

test('a creator-native production issue has strong creator content fit', () => {
  const result = evaluateCandidateCoherence({
    pillar: 'Real-time Production', territory: 'Asset Delivery',
    coreClaim: 'Asset dependency hashing can isolate unchanged content from a playable build patch.',
    mechanism: 'asset dependency hashing', perspective: 'release reliability',
    audienceConsequence: 'Smaller patches shorten playable-build feedback loops.',
    authorityMode: 'INFERRED_FAMILIARITY', sourceType: 'strategy_derived',
  }, context());
  assert.ok(result.creatorContentFit >= 55, JSON.stringify(result));
});

test('source lexical relevance cannot override very low creator fit', () => {
  const result = evaluateCandidateCoherence({
    pillar: 'Real-time Production', territory: 'Asset Delivery',
    coreClaim: 'A regional entertainment networking mixer announced a new sponsor.',
    mechanism: 'event sponsorship', authorityMode: 'EXPLORATORY',
    sourceType: 'searched', origin: 'SEARCH_DISCOVERED',
    sourceText: 'A regional entertainment networking mixer announced a new sponsor.',
  }, context());
  assert.ok(result.candidateCoherence.sourceClaimFit >= 90);
  assert.equal(result.coherenceRejectionReason, 'COHERENCE_SEARCH_CREATOR_FIT_TOO_LOW', JSON.stringify(result));
});

test('a secondary audience is selected when its consequence is more natural', () => {
  const s = strategy({
    targetAudience: {
      primaryAudience: 'Procurement directors', secondaryAudiences: ['Platform reliability leads'],
      roles: [], industries: [], companyStage: [], painPoints: [], desiredOutcomes: [],
      objectionsOrMisbeliefs: [], knowledgeLevel: 'expert',
    },
  });
  const p = profile();
  p.audienceModel.segments = [
    { name: 'Procurement directors', likelyProblems: ['vendor contract renewal'], desiredOutcomes: ['lower purchasing cost'] },
    { name: 'Platform reliability leads', likelyProblems: ['deployment incidents and rollback delays'], desiredOutcomes: ['safer service releases'] },
  ];
  const result = evaluateCandidateCoherence({
    pillar: 'Application Delivery', territory: 'Web Release Workflow',
    coreClaim: 'Progressive delivery limits the blast radius of a failed deployment.',
    mechanism: 'staged rollout and rollback',
    audienceConsequence: 'Faster rollback reduces deployment incidents for reliability teams.',
    authorityMode: 'EXPLORATORY', sourceType: 'strategy_derived',
  }, context(s, p));
  assert.deepEqual(result.resolvedAudience, ['Platform reliability leads']);
});

test('a broad creator-owned idea may proceed without explicit audience injection', () => {
  const result = evaluateCandidateCoherence({
    pillar: 'Real-time Production', territory: 'Asset Delivery',
    coreClaim: 'Content-addressed assets make release artifacts easier to reproduce.',
    mechanism: 'content addressing', authorityMode: 'INFERRED_FAMILIARITY',
    sourceType: 'strategy_derived',
  }, context());
  assert.deepEqual(result.resolvedAudience, []);
  assert.equal(result.coherenceRejectionReason, null);
});

test('explicitly monitored, audience-natural exploratory content remains allowed', () => {
  const result = evaluateCandidateCoherence({
    pillar: 'Real-time Production', territory: 'Asset Delivery',
    coreClaim: 'A content-hashed asset pipeline may reduce repeated playable-build uploads.',
    mechanism: 'content hashing in real-time production workflows',
    audienceConsequence: 'Faster asset iteration shortens playable-build feedback loops.',
    authorityMode: 'EXPLORATORY', sourceType: 'strategy_derived',
  }, context());
  assert.equal(result.coherenceRejectionReason, null);
});

test('authority safety and creator content fit remain separate', () => {
  const base = {
    pillar: 'Real-time Production', territory: 'Asset Delivery',
    coreClaim: 'Asset dependency hashing can isolate unchanged patch content.',
    mechanism: 'asset dependency hashing', sourceType: 'strategy_derived',
  };
  const safe = evaluateCandidateCoherence({ ...base, authorityMode: 'EXPLORATORY' }, context());
  const unsafe = evaluateCandidateCoherence({ ...base, coreClaim: 'I recommend this because my clients always cut patch costs.', authorityMode: 'EXPLORATORY' }, context());
  assert.ok(safe.creatorContentFit > 0);
  assert.ok(unsafe.candidateCoherence.authorityFramingFit < safe.candidateCoherence.authorityFramingFit);
});

function ranked(origin: 'SEMANTIC' | 'DETERMINISTIC_FALLBACK' | 'SEARCH', native: boolean): RankedTrendCandidate {
  const searched = origin === 'SEARCH';
  const claim = native
    ? 'Content hashing in the playable-build pipeline prevents unchanged assets from inflating patches.'
    : 'A regional entertainment networking mixer announced a new sponsor.';
  return {
    trend: {
      topic: claim, summary: claim, rawTitle: claim,
      sourceType: searched ? 'searched' : 'strategy_derived',
      ideaOrigin: searched ? 'SEARCH_DISCOVERED' : 'STRATEGY_DERIVED',
      ideaGenerationMode: origin === 'SEARCH' ? undefined : origin,
      matchedPillar: 'Real-time Production', territory: 'Asset Delivery',
      authorityMode: 'EXPLORATORY',
      audienceConsequence: native ? 'Smaller patches shorten playable-build feedback loops.' : undefined,
    },
    fingerprint: { normalizedTopic: claim.toLowerCase(), topicCluster: 'asset_delivery', coreClaim: claim, entities: [], mechanisms: [native ? 'content hashing patch delivery' : 'event sponsorship'] },
    relevanceScore: 90, sourceQualityScore: 90, recencyScore: 90, technicalDepthScore: 80,
    noveltyScore: 90, totalScore: 90, novelty: { allowed: true, score: 90, reasons: [] },
    matchedPillar: 'Real-time Production',
  };
}

test('coherence is attached to semantic, deterministic fallback, and search candidates before selection', () => {
  for (const origin of ['SEMANTIC', 'DETERMINISTIC_FALLBACK', 'SEARCH'] as const) {
    const normalized = normalizeBatchCandidate(ranked(origin, true), context());
    assert.ok(normalized.candidateCoherence.overall > 0);
    assert.equal(typeof normalized.audienceIdeaNaturalness, 'number');
    assert.equal(typeof normalized.creatorContentFit, 'number');
  }
});

test('a coherent semantic idea ranks while incoherent search is hard rejected', () => {
  const selected = selectUnifiedBatchCandidates(
    [ranked('SEARCH', false), ranked('SEMANTIC', true)],
    1,
    undefined,
    undefined,
    { coherenceContext: context() },
  );
  assert.equal(selected.length, 1);
  assert.equal(selected[0].ranked.trend.ideaGenerationMode, 'SEMANTIC');
});

test('resolved audience guides the writer silently and broad ideas avoid label injection', () => {
  const secondaryTrend = ranked('SEMANTIC', true).trend;
  secondaryTrend.resolvedAudience = ['Platform reliability leads'];
  const secondaryPlan = buildDeterministicBatchPlan([secondaryTrend], 1)[0];
  assert.deepEqual(secondaryPlan.resolvedAudience, ['Platform reliability leads']);
  assert.match(buildPlanBlock(secondaryPlan), /Audience: Platform reliability leads/);

  const broadTrend = ranked('SEMANTIC', true).trend;
  broadTrend.resolvedAudience = [];
  const broadPlan = buildDeterministicBatchPlan([broadTrend], 1)[0];
  const prompt = buildPlanBlock(broadPlan);
  assert.match(prompt, /do not insert a configured audience label/);
  assert.doesNotMatch(prompt, /Audience: Independent studio teams/);
});

test('production implementation contains no observed niche branches or model client', () => {
  const source = readFileSync(join(__dirname, 'candidateCoherenceService.ts'), 'utf8');
  assert.doesNotMatch(source, /Indie Game|UiPath|Remix Networking|Unity|Web Development/i);
  assert.doesNotMatch(source, /OpenAI|chat\.completions|generateContent/);
});

test('batch coherence does not leak into Personal Experience or manual orchestration', () => {
  const personal = readFileSync(join(__dirname, 'manualPost', 'personalExperienceService.ts'), 'utf8');
  const manual = readFileSync(join(__dirname, 'manualPost', 'manualPostOrchestration.ts'), 'utf8');
  assert.doesNotMatch(`${personal}\n${manual}`, /candidateCoherenceService|audienceIdeaNaturalness|creatorContentFit/);
});
