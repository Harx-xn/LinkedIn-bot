import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { buildEffectiveBotStrategy } from './botStrategyService';
import { evaluateCandidateCoherence, type CandidateCoherenceDecision } from './candidateCoherenceService';
import { buildFallbackContentIntelligence } from './contentIntelligenceService';
import {
  buildStrategyIdeaCandidates,
  ideaToRankedCandidate,
  scoreContentIdea,
  selectDiverseIdeas,
  type ContentIdeaCandidate,
} from './contentIdeaService';
import { buildUnifiedCandidateSelection } from './unifiedBatchCandidateService';

type UnscoredIdea = Omit<ContentIdeaCandidate, 'score' | 'rejectedReasons'>;

function idea(overrides: Partial<UnscoredIdea> = {}): UnscoredIdea {
  return {
    id: 'fallback', pillar: 'Operations', territory: 'approval workflow',
    coreClaim: 'A single decision owner removes repeated approval loops before they delay a release.',
    mechanism: 'single decision owner removes approval handoffs', perspective: 'operator decision',
    ideaFamily: 'decision heuristic', origin: 'STRATEGY_DERIVED', authorityMode: 'SUPPORTED_PRACTITIONER',
    searchRequired: false, saturationPenalty: 0, generationMode: 'DETERMINISTIC_FALLBACK',
    personalEvidencePotential: 'NONE',
    ...overrides,
  };
}

function coherence(overrides: Partial<CandidateCoherenceDecision> = {}): CandidateCoherenceDecision {
  const audienceIdeaNaturalness = overrides.audienceIdeaNaturalness ?? 60;
  const creatorContentFit = overrides.creatorContentFit ?? 65;
  return {
    audienceIdeaNaturalness,
    creatorContentFit,
    candidateCoherence: {
      audienceIdeaNaturalness, creatorContentFit, pillarClaimFit: 70,
      sourceClaimFit: 70, authorityFramingFit: 88, overall: 69,
      ...overrides.candidateCoherence,
    },
    coherencePenalty: 0, coherenceRejectionReason: null, resolvedAudience: [], ...overrides,
  };
}

function strategy(niche: string, positioning: string, audience: string, pain: string, outcome: string) {
  return buildEffectiveBotStrategy({
    niches: JSON.stringify([niche]), description: positioning,
    targetAudience: { primaryAudience: audience, painPoints: [pain], desiredOutcomes: [outcome] },
    contentPillars: {
      primaryPillars: [{ name: niche, description: positioning, audienceRelevance: pain, exampleAngles: [pain], trendKeywords: [niche] }],
      secondaryPillars: [], excludedTopics: [],
    },
  });
}

function scored(candidate: UnscoredIdea, decision = coherence()): ContentIdeaCandidate {
  return { ...candidate, ...decision, ...scoreContentIdea(candidate, [], decision) };
}

describe('deterministic fallback scoring', () => {
  it('does not grant automatic legacy strategy or audience constants', () => {
    const result = scoreContentIdea(idea({ audienceConsequence: undefined }), []);
    assert.notEqual(result.score.strategyFit, 85);
    assert.notEqual(result.score.audienceValue, 75);
    assert.equal(result.score.strategyFit, 0);
    assert.ok(result.score.audienceValue < 30);
  });

  it('raises audience value for a material audience consequence', () => {
    const without = scoreContentIdea(idea(), [], coherence()).score;
    const withConsequence = scoreContentIdea(idea({
      audienceConsequence: 'Release managers avoid approval delays and reduce rework before launch.',
    }), [], coherence()).score;
    assert.ok(withConsequence.audienceValue > without.audienceValue);
  });

  it('scores generic adapt-as-you-grow advice as low non-obviousness', () => {
    const result = scoreContentIdea(idea({
      coreClaim: 'Your operations process should adapt as you grow.', mechanism: 'changing context',
    }), [], coherence()).score;
    assert.ok(result.nonObviousness < 25);
  });

  it('scores a concrete causal mechanism above generic advice', () => {
    const generic = scoreContentIdea(idea({
      coreClaim: 'Approval workflows require careful planning.', mechanism: 'planning',
    }), [], coherence()).score;
    const concrete = scoreContentIdea(idea({
      coreClaim: 'Parallel approvers create duplicate handoffs that delay a release unless one owner resolves conflicts.',
      mechanism: 'duplicate handoffs create unresolved approval conflicts',
    }), [], coherence()).score;
    assert.ok(concrete.nonObviousness > generic.nonObviousness);
    assert.ok(concrete.specificityPotential > generic.specificityPotential);
    assert.ok(concrete.practicalValue > generic.practicalValue);
  });

  it('does not treat an until-template as useful tension without substantive clauses', () => {
    const result = scoreContentIdea(idea({
      coreClaim: 'Planning looks flexible until the context changes.', mechanism: 'context',
    }), [], coherence()).score;
    assert.ok(result.usefulTension < 30);
  });

  it('lets creator-content fit change strategy fit and composite score', () => {
    const weak = scoreContentIdea(idea(), [], coherence({ creatorContentFit: 22 })).score;
    const strong = scoreContentIdea(idea(), [], coherence({ creatorContentFit: 86 })).score;
    assert.ok(strong.strategyFit > weak.strategyFit);
    assert.ok(strong.composite > weak.composite);
  });

  it('scores unrelated niches from their own configured relationships', () => {
    const hiring = strategy('Interview Design', 'I design structured hiring systems.', 'hiring managers', 'inconsistent evaluator decisions', 'make reliable hires');
    const training = strategy('Endurance Training', 'I coach recovery-bounded endurance programs.', 'distance runners', 'training load without recovery', 'finish races healthy');
    const hiringProfile = buildFallbackContentIntelligence(hiring);
    const trainingProfile = buildFallbackContentIntelligence(training);
    const hiringIdea = idea({
      pillar: 'Interview Design', territory: 'Interview Design',
      coreClaim: 'A weighted scorecard reduces evaluator drift before the hiring decision.',
      mechanism: 'weighted scorecard reduces evaluator drift',
      audienceConsequence: 'Hiring managers reduce inconsistent decisions and make reliable hires.',
    });
    const hiringFit = evaluateCandidateCoherence(hiringIdea, { strategy: hiring, profile: hiringProfile });
    const trainingFit = evaluateCandidateCoherence(hiringIdea, { strategy: training, profile: trainingProfile });
    assert.ok(hiringFit.creatorContentFit > trainingFit.creatorContentFit);
    assert.ok(scoreContentIdea(hiringIdea, [], hiringFit).score.strategyFit > scoreContentIdea(hiringIdea, [], trainingFit).score.strategyFit);
  });

  it('penalizes repeated fallback families during batch selection', () => {
    const first = scored(idea({ id: 'first', coreClaim: 'One owner removes approval loops before release.', mechanism: 'single owner removes approval loops' }));
    first.score.composite = 90;
    const repeated = scored(idea({ id: 'repeated', coreClaim: 'One budget owner removes repeated allocation reviews.', mechanism: 'single budget owner removes repeated reviews' }));
    repeated.score.composite = 89;
    const distinct = scored(idea({ id: 'distinct', ideaFamily: 'unexpected interaction', coreClaim: 'A queue timeout moves retry load into the worker pool.', mechanism: 'timeout shifts retries into worker load' }));
    distinct.score.composite = 88;
    const selected = selectDiverseIdeas([first, repeated, distinct], 2);
    assert.deepEqual(selected.map((item) => item.id), ['first', 'distinct']);
    assert.ok((selected[1].memoryPenalty ?? 0) < 15);
  });

  it('lets a weak fallback lose to a stronger search candidate', async () => {
    const weak = ideaToRankedCandidate(scored(idea({ coreClaim: 'Operations require careful planning.', mechanism: 'planning' })));
    const strongSearch = { ...ideaToRankedCandidate(scored(idea({ id: 'search', coreClaim: 'A new filing rule moves approval before submission.', mechanism: 'approval before filing', generationMode: 'SEMANTIC' }))), trend: { ...ideaToRankedCandidate(scored(idea())).trend, sourceType: 'searched' as const, ideaOrigin: 'SEARCH_DISCOVERED' as const, link: 'https://example.com/rule' }, totalScore: 92 };
    const result = await buildUnifiedCandidateSelection({ strategyCandidates: [weak], count: 1, search: async () => [strongSearch] });
    assert.equal(result.selected[0].coreClaim, strongSearch.fingerprint.coreClaim);
  });

  it('lets a strong fallback beat a weak search candidate', async () => {
    const strong = ideaToRankedCandidate(scored(idea()));
    strong.totalScore = 91;
    const weakSearch = ideaToRankedCandidate(scored(idea({ id: 'search', coreClaim: 'An update happened this week.', mechanism: 'update', generationMode: 'SEMANTIC' })));
    weakSearch.trend.sourceType = 'searched'; weakSearch.trend.ideaOrigin = 'SEARCH_DISCOVERED'; weakSearch.trend.link = 'https://example.com/update'; weakSearch.totalScore = 35;
    const result = await buildUnifiedCandidateSelection({ strategyCandidates: [strong], count: 1, search: async () => [weakSearch] });
    assert.equal(result.selected[0].coreClaim, strong.fingerprint.coreClaim);
  });

  it('keeps deterministic fallback available without a model call', () => {
    const configured = strategy('Release Operations', 'I build reliable release workflows.', 'release managers', 'repeated approval delays', 'ship predictable releases');
    const candidates = buildStrategyIdeaCandidates(buildFallbackContentIntelligence(configured), configured, [], 3);
    assert.ok(candidates.length >= 3);
    assert.ok(candidates.every((candidate) => candidate.generationMode === 'DETERMINISTIC_FALLBACK'));
  });

  it('contains no model dependency or niche-specific production branch', () => {
    const source = readFileSync(require.resolve('./contentIdeaService'), 'utf8');
    assert.doesNotMatch(source, /\bOpenAI\b|chat\.completions|responses\.create/);
    assert.doesNotMatch(source, /(?:audience|pillar|territory|niche)\s*===?\s*['"][^'"]+['"]/i);
    assert.doesNotMatch(source, /Indie Game Developers|Web Development|healthcare|fintech/i);
  });
});
