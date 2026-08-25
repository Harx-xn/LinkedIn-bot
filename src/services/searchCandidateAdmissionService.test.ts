import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { buildEffectiveBotStrategy } from './botStrategyService';
import type { NicheExpansionPlan, RankedTrendCandidate, TrendCandidate } from './generationTypes';
import { evaluateSearchCandidateAdmission } from './searchCandidateAdmissionService';
import { buildUnifiedCandidateSelection } from './unifiedBatchCandidateService';

function strategy(domain: 'engine' | 'automation' = 'engine') {
  const engine = domain === 'engine';
  const pillar = engine ? 'Game Engine Engineering' : 'Workflow Automation';
  return buildEffectiveBotStrategy({
    description: engine
      ? 'I build Unity rendering systems and game-engine architecture.'
      : 'I design reliable approval and orchestration workflows.',
    niches: JSON.stringify([pillar]),
    profilePositioning: {
      positioningStatement: engine ? 'Unity rendering and game-engine architecture' : 'reliable workflow automation and orchestration',
      credibilityPoints: [], uniquePointOfView: engine ? 'engine constraints shape production decisions' : 'automation should remove handoff constraints',
      topicsToBeKnownFor: engine ? ['Unity engine', 'rendering pipeline'] : ['workflow automation', 'approval orchestration'],
    },
    targetAudience: {
      primaryAudience: engine ? 'Indie Game Developers' : 'Operations leaders',
      roles: [], industries: [],
      painPoints: engine ? ['rendering compatibility and frame performance'] : ['approval delays and repeated handoffs'],
      desiredOutcomes: engine ? ['ship stable game builds'] : ['operate reliable workflows'],
      objectionsOrMisbeliefs: [], knowledgeLevel: 'intermediate',
    },
    contentGoals: { primaryGoal: 'education', secondaryGoals: [], preferredCTAStyle: 'no_cta' },
    contentPillars: {
      primaryPillars: [{
        name: pillar,
        description: engine ? 'Unity engine rendering, architecture, and production constraints' : 'workflow automation, orchestration, and operational reliability',
        audienceRelevance: engine ? 'rendering compatibility and stable builds' : 'approval delays and workflow reliability',
        exampleAngles: engine ? ['render pipeline migration'] : ['approval orchestration'],
        trendKeywords: engine ? ['Unity engine', 'rendering pipeline'] : ['workflow automation', 'UiPath'],
      }], secondaryPillars: [], experimentalPillars: [], excludedTopics: [],
    },
  });
}

function profile(domain: 'engine' | 'automation' = 'engine'): NicheExpansionPlan {
  const engine = domain === 'engine';
  return {
    niche: engine ? 'Game Engine Engineering' : 'Workflow Automation',
    normalizedNiche: engine ? 'Game Engine Engineering' : 'Workflow Automation',
    domain: engine ? 'game engine engineering' : 'workflow automation', confidence: .9,
    subtopics: engine ? ['Unity engine', 'rendering pipeline', 'build compatibility'] : ['approval workflow', 'orchestration', 'handoff reliability'],
    queries: [], exclusions: [], commonProblems: engine ? ['rendering compatibility'] : ['approval delays and repeated handoffs'],
    desiredOutcomes: engine ? ['stable game builds'] : ['reliable workflows'],
    productsAndPlatforms: engine ? ['Unity'] : ['UiPath'],
  };
}

function admit(candidate: TrendCandidate, domain: 'engine' | 'automation' = 'engine', subjectRelevance = 82, sourceQuality = 80) {
  return evaluateSearchCandidateAdmission({
    candidate, strategy: strategy(domain), profile: profile(domain), subjectRelevance, sourceQuality,
  });
}

function ranked(input: {
  claim: string; mechanism: string; score: number; searched?: boolean; requiresSearch?: boolean;
  evidenceOnly?: boolean; transformability?: number; link?: string;
}): RankedTrendCandidate {
  const fingerprint = { normalizedTopic: input.claim.toLowerCase(), topicCluster: 'workflow', coreClaim: input.claim, entities: [], mechanisms: [input.mechanism] };
  return {
    trend: {
      topic: input.claim, summary: input.claim, matchedPillar: 'Workflow Automation', territory: 'approval orchestration',
      sourceType: input.searched ? 'searched' : 'strategy_derived',
      ideaOrigin: input.searched ? 'SEARCH_DISCOVERED' : 'STRATEGY_DERIVED', authorityMode: 'SUPPORTED_PRACTITIONER',
      searchRequired: input.requiresSearch, evidenceRole: input.link ? 'strong_secondary' : undefined, link: input.link,
      subjectRelevance: input.searched ? 80 : undefined,
      sourceClaimTransformability: input.searched ? input.transformability ?? 20 : undefined,
      searchDisposition: input.evidenceOnly ? 'EVIDENCE_ONLY' : input.searched ? 'NEW_IDEA_CANDIDATE' : undefined,
      searchRejectionReason: input.evidenceOnly ? 'SEARCH_SOURCE_CLAIM_TRANSFORMABILITY_TOO_LOW' : null,
      evidenceOnly: input.evidenceOnly,
      candidateCoherence: { audienceIdeaNaturalness: 60, creatorContentFit: 75, pillarClaimFit: 80, sourceClaimFit: input.transformability ?? 70, authorityFramingFit: 88, overall: 72 },
      audienceIdeaNaturalness: 60, creatorContentFit: 75, ideaQualityScore: input.score,
    },
    fingerprint, relevanceScore: input.score, sourceQualityScore: 85, recencyScore: 80,
    technicalDepthScore: input.score, noveltyScore: 90, totalScore: input.score,
    novelty: { allowed: true, score: 90, reasons: [] }, matchedPillar: 'Workflow Automation',
  };
}

describe('search candidate admission', () => {
  it('does not turn a gaming event into game-engine content', () => {
    const decision = admit({ topic: 'Women in Gaming networking event returns this summer' });
    assert.notEqual(decision.searchDisposition, 'NEW_IDEA_CANDIDATE');
  });

  it('admits a game-engine release with a direct production consequence', () => {
    const decision = admit({ topic: 'Unity 7 release changes rendering pipeline compatibility for production game builds' });
    assert.equal(decision.searchDisposition, 'NEW_IDEA_CANDIDATE');
    assert.ok(decision.sourceClaimTransformability >= 40);
  });

  it('does not transform an automation-company valuation into workflow advice', () => {
    const decision = admit({ topic: 'UiPath valuation rises after investor reassessment' }, 'automation');
    assert.notEqual(decision.searchDisposition, 'NEW_IDEA_CANDIDATE');
  });

  it('admits an automation release with direct workflow consequences', () => {
    const decision = admit({ topic: 'UiPath release adds approval workflow controls that reduce repeated handoffs' }, 'automation');
    assert.equal(decision.searchDisposition, 'NEW_IDEA_CANDIDATE');
  });

  it('rejects high lexical relevance when creator fit is very low', () => {
    const decision = admit({ topic: 'Gaming industry awards and networking mixer' }, 'engine', 100, 95);
    assert.notEqual(decision.searchDisposition, 'NEW_IDEA_CANDIDATE');
    assert.ok(decision.creatorContentFit < 30);
  });

  it('allows strong creator fit with moderate subject relevance', () => {
    const decision = admit({ topic: 'Rendering pipeline migration changes build compatibility and frame performance' }, 'engine', 58, 70);
    assert.equal(decision.searchDisposition, 'NEW_IDEA_CANDIDATE');
  });

  it('keeps a weak standalone source available as evidence', async () => {
    const strategyIdea = ranked({ claim: 'Approval orchestration needs one authoritative handoff owner.', mechanism: 'authoritative handoff owner', score: 91, requiresSearch: true });
    const evidence = ranked({ claim: 'A market report measures authoritative handoff ownership.', mechanism: 'authoritative handoff owner', score: 45, searched: true, evidenceOnly: true, transformability: 20, link: 'https://example.com/report' });
    const result = await buildUnifiedCandidateSelection({ strategyCandidates: [strategyIdea], count: 1, search: async () => [evidence] });
    assert.equal(result.selected[0].coreClaim, strategyIdea.fingerprint.coreClaim);
    assert.equal(result.selected[0].evidence.enrichedCandidateId, result.observed.find((item) => item.evidenceOnly)?.id);
    assert.equal(result.selected.some((item) => item.evidenceOnly), false);
  });

  it('does not award audience naturalness for the audience name alone', () => {
    const without = admit({ topic: 'Annual industry outlook' });
    const withLabel = admit({ topic: 'Annual industry outlook for Indie Game Developers' });
    assert.equal(withLabel.audienceIdeaNaturalness, without.audienceIdeaNaturalness);
  });

  it('does not let source quality override creator mismatch', () => {
    const low = admit({ topic: 'Gaming awards celebration' }, 'engine', 90, 45);
    const high = admit({ topic: 'Gaming awards celebration' }, 'engine', 90, 100);
    assert.notEqual(high.searchDisposition, 'NEW_IDEA_CANDIDATE');
    assert.equal(high.creatorContentFit, low.creatorContentFit);
  });

  it('keeps genuinely relevant recent news eligible', () => {
    const decision = admit({ topic: 'New Unity security update changes build deployment validation', publishedAt: new Date() });
    assert.equal(decision.searchDisposition, 'NEW_IDEA_CANDIDATE');
  });

  it('allows a useful evergreen searched source', () => {
    const decision = admit({
      topic: 'Rendering architecture patterns reduce build compatibility failures',
      summary: 'A bounded render pipeline separates compatibility checks before deployment and prevents invalid configurations.',
    });
    assert.equal(decision.searchDisposition, 'NEW_IDEA_CANDIDATE');
  });

  it('introduces no model client or per-result call', () => {
    const source = readFileSync(require.resolve('./searchCandidateAdmissionService'), 'utf8');
    assert.doesNotMatch(source, /OpenAI|chat\.completions|responses\.create|generateContent/);
  });

  it('preserves mixed strategy and eligible search selection', async () => {
    const strategyIdea = ranked({ claim: 'One approval owner removes handoff ambiguity.', mechanism: 'single approval owner', score: 90 });
    const search = ranked({ claim: 'A policy update changes approval record retention.', mechanism: 'new record retention deadline', score: 82, searched: true, transformability: 80, link: 'https://example.com/policy' });
    const result = await buildUnifiedCandidateSelection({ strategyCandidates: [strategyIdea], count: 2, search: async () => [search] });
    assert.equal(result.selected.length, 2);
    assert.ok(result.selected.some((item) => item.origin === 'SEARCH_DISCOVERED'));
  });

  it('contains no niche-specific admission branch', () => {
    const source = readFileSync(require.resolve('./searchCandidateAdmissionService'), 'utf8');
    assert.doesNotMatch(source, /\b(?:Unity|UiPath|Indie Game|Women in Gaming|automation-company)\b/i);
  });
});
