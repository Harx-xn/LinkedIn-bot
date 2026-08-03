import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildEffectiveBotStrategy } from './botStrategyService';
import { scoreTrendForStrategy } from './botStrategyTrendService';
import { applyBatchEvidenceComposition, decideCandidateEligibility, deriveGroundedSourceAngles, processTrendCandidates, toTrendCandidate } from './trendSelectionService';
import type { NicheExpansionPlan } from './generationTypes';
import { preselectPlausibleTrends } from './trendsService';
import { selectNicheBalancedCandidates } from './trendRankingService';

function strategyFor(pillar: string, keywords: string[] = [], requirePillarMatch = false) {
  return buildEffectiveBotStrategy({
    description: `Writes about ${pillar}`,
    tone: 'Practical', niches: JSON.stringify([pillar]),
    contentPillars: { primaryPillars: [{ name: pillar, description: pillar, audienceRelevance: '', exampleAngles: [], trendKeywords: keywords }], secondaryPillars: [], experimentalPillars: [], excludedTopics: [] },
    topicRules: { minimumRelevanceScore: 65, requirePillarMatch, requireAudiencePainMatch: false, avoidDuplicateAngles: true, avoidRecentTopicsDays: 30 },
  });
}

function profile(niche: string, terms: string[], extras: Partial<NicheExpansionPlan> = {}): NicheExpansionPlan {
  return {
    niche, normalizedNiche: niche, domain: niche, confidence: 0.9,
    subtopics: terms, queries: [`${terms[0]} benchmark study ${niche}`], exclusions: [], version: 3,
    requiredContextTerms: niche.split(' '),
    contentCategories: [{ id: 'primary_category', label: terms[0], terms }],
    ...extras,
  };
}

describe('candidate qualification acceptance paths', () => {
  it('lets scoped entities, platforms, and contextual aliases satisfy a required pillar', () => {
    const strategy = strategyFor('AI Automation', ['workflow automation'], true);
    const plan = profile('AI Automation', ['workflow automation'], { importantEntities: ['Automation Guild'], productsAndPlatforms: ['UiPath'], entityAliases: ['AgentFlow'], requiredContextTerms: ['workflow', 'automation'] });
    for (const topic of ['Automation Guild publishes its annual controls report', 'UiPath expands orchestration controls', 'AgentFlow workflow automation release roadmap']) {
      const score = scoreTrendForStrategy({ topic, originNiche: 'AI Automation' }, strategy, { profile: plan });
      assert.equal(score.nicheMatch?.activeNicheEvidence?.pillarSatisfied, true, topic);
      assert.ok(!score.nicheMatch?.rejectionCodes.includes('missing_pillar_match'), topic);
      assert.ok(score.nicheMatch?.directEvidence?.length, topic);
      assert.ok(score.breakdown.directNicheEvidence! > 0, topic);
    }
  });

  it('keeps an unsupported generic alias ambiguous', () => {
    const strategy = strategyFor('Unity Game Development', ['Unity engine'], true);
    const plan = profile('Unity Game Development', ['Unity engine'], { entityAliases: ['Unity'], requiredContextTerms: ['engine', 'game'], excludedInterpretations: ['community unity'] });
    const score = scoreTrendForStrategy({ topic: 'Community unity brings neighbors together', originNiche: 'Unity Game Development' }, strategy, { profile: plan });
    assert.equal(score.nicheMatch?.activeNicheEvidence?.pillarSatisfied, false);
    assert.equal(score.nicheMatch?.activeNicheEvidence?.ambiguityResolved, false);
    assert.equal(score.nicheMatch?.directEvidence?.some((item) => item.startsWith('alias:')), false);
  });

  it('scopes UiPath to AI Automation and not Web Development', () => {
    const topic = { topic: 'UiPath expands automation controls', originNiche: 'AI Automation' };
    const ai = scoreTrendForStrategy(topic, strategyFor('AI Automation', ['workflow automation'], true), { profile: profile('AI Automation', ['workflow automation'], { productsAndPlatforms: ['UiPath'] }) });
    const web = scoreTrendForStrategy(topic, strategyFor('Web Development', ['web standards'], true), { profile: profile('Web Development', ['web standards']) });
    assert.equal(ai.nicheMatch?.activeNicheEvidence?.pillarSatisfiedBy, 'platform');
    assert.equal(web.nicheMatch?.activeNicheEvidence?.pillarSatisfied, false);
  });
  it('allows the relevant web candidate through despite an unclassified cluster', () => {
    const strategy = strategyFor('Web Development', ['web standards', 'full-stack framework', 'React']);
    const plan = profile('Web Development', ['web standards', 'full-stack framework', 'React', 'Remix']);
    const score = scoreTrendForStrategy({ topic: 'Remix 3 Beta Preview Ditches React for a Web-Standards Full-Stack Framework' }, strategy, { profile: plan });
    const decision = decideCandidateEligibility(score.nicheMatch!, true);
    assert.ok(score.breakdown.directNicheEvidence! > 0);
    assert.equal(score.breakdown.ambiguityPenalty, 0);
    assert.equal(decision.eligible, true);
  });

  it('recognizes profile-grounded Unity game context', () => {
    const strategy = strategyFor('Unity Game Development', ['Unity engine', 'Godot', 'game engine']);
    const plan = profile('Unity Game Development', ['Unity engine', 'Godot', 'game engine', 'game jam'], { excludedInterpretations: ['organizational unity'] });
    const score = scoreTrendForStrategy({ topic: 'Unity is no longer the leader — Godot has become the most popular engine at GMTK Game Jam 2026' }, strategy, { profile: plan });
    assert.equal(score.breakdown.ambiguityPenalty, 0);
    assert.equal(decideCandidateEligibility(score.nicheMatch!, true).eligible, true);
  });

  it('does not require audience, goal, positioning, monitor, or cluster bonuses', () => {
    const strategy = strategyFor('Accounting', ['tax reporting']);
    const score = scoreTrendForStrategy({ topic: 'Tax reporting benchmark study changes filing practice' }, strategy, { profile: profile('Accounting', ['tax reporting', 'filing practice']) });
    assert.equal(score.breakdown.audienceMatch, 0);
    assert.equal(score.breakdown.goalMatch, 0);
    assert.equal(score.breakdown.positioningMatch, 0);
    assert.equal(decideCandidateEligibility(score.nicheMatch!, true).eligible, true);
  });

  it('rejects unrelated and genuinely ambiguous isolated results', () => {
    const strategy = strategyFor('Unity Game Development', ['Unity engine', 'game engine']);
    const plan = profile('Unity Game Development', ['Unity engine', 'game engine'], { originalNiche: 'Unity', excludedInterpretations: ['organizational unity'], requiredContextTerms: ['game', 'engine'] });
    for (const title of ['Cyclospora outbreak linked to lettuce', 'Army body composition standards', 'Mammography Quality Standards Act', 'Unity']) {
      const score = scoreTrendForStrategy({ topic: title }, strategy, { profile: plan });
      assert.equal(decideCandidateEligibility(score.nicheMatch!, true).eligible, false, title);
    }
  });

  it('derives direct evidence for non-technology domains', () => {
    for (const [niche, term, title] of [
      ['Pet Care', 'veterinary nutrition', 'Veterinary nutrition benchmark study updates pet diets'],
      ['Real Estate', 'mortgage lending', 'Mortgage lending report changes property financing'],
      ['Accounting', 'tax reporting', 'Tax reporting policy update affects filing practice'],
      ['AI Automation', 'workflow automation', 'Workflow automation adoption report measures outcomes'],
    ]) {
      const score = scoreTrendForStrategy({ topic: title }, strategyFor(niche, [term]), { profile: profile(niche, [term]) });
      assert.ok(score.breakdown.directNicheEvidence! > 0, niche);
      assert.equal(decideCandidateEligibility(score.nicheMatch!, true).eligible, true, niche);
    }
  });

  it('uses a protected zero-result fallback only for direct non-excluded evidence', async () => {
    const strategy = strategyFor('Pet Care', []);
    const plan = profile('Pet Care', ['veterinary nutrition'], { excludedTerms: ['sponsored'] });
    const fakeFingerprints = {
      fingerprintTrends: async () => undefined,
      getCached: () => undefined,
      fingerprintTrend: async () => ({ normalizedTopic: 'fallback', topicCluster: 'unclassified', coreClaim: 'fallback', entities: [], mechanisms: [] }),
    } as any;
    const result = await processTrendCandidates({
      userId: 'candidate-test', niche: 'Pet Care', plan,
      author: { niches: ['Pet Care'], strategy } as any, strategy, history: [], limit: 3,
      fingerprintService: fakeFingerprints, pipelineMode: 'generation',
      rawTrends: [
        { title: 'Veterinary nutrition benchmark study offers practical feeding evidence', link: 'https://example.org/pet', source: 'google_news', publisher: 'Example', pubDate: new Date().toISOString() },
        { title: 'Army body composition standards change', link: 'https://example.org/army', source: 'google_news', publisher: 'Example 2', pubDate: new Date().toISOString() },
        { title: 'Sponsored veterinary nutrition benchmark study', link: 'https://example.org/ad', source: 'google_news', publisher: 'Example 3', pubDate: new Date().toISOString() },
      ],
    });
    assert.equal(result.selected.length, 1);
    assert.equal(result.selected[0].trend.selectionMode, 'zero_result_fallback');
    assert.match(result.selected[0].trend.topic, /Veterinary nutrition/);
  });

  it('does not let community evidence alone verify a solution', () => {
    const strategy = strategyFor('Pet Care', ['veterinary nutrition']);
    const score = scoreTrendForStrategy({
      topic: 'Veterinary nutrition solution for unsafe feeding advice', discoveryIntent: 'verified_solution', evidenceRole: 'problem_discovery',
    }, strategy, { profile: profile('Pet Care', ['veterinary nutrition', 'unsafe feeding advice']) });
    const decision = decideCandidateEligibility(score.nicheMatch!, true);
    assert.equal(decision.eligible, false);
    assert.ok(decision.hardRejectionCodes?.includes('community_source_cannot_verify_solution'));
  });

  it('derives at most one additional grounded angle from a strong source', () => {
    const base: any = {
      trend: { topic: 'Accounting board updates reporting guidance', link: 'https://accounting.example/update', publisher: 'Accounting Board', summary: 'The revised guidance changes how firms document reporting controls', evidenceRole: 'primary', discoveryIntent: 'official_update' },
      fingerprint: { normalizedTopic: 'reporting guidance update', topicCluster: 'reporting', coreClaim: 'guidance changed', entities: [], mechanisms: [] },
      relevanceScore: 80, sourceQualityScore: 95, recencyScore: 80, technicalDepthScore: 50, noveltyScore: 100, totalScore: 85,
      novelty: { allowed: true, score: 100, reasons: [] }, matchedPillar: 'Financial Reporting',
    };
    const angles = deriveGroundedSourceAngles([base], [], 2);
    assert.equal(angles.length, 1);
    assert.equal(angles[0].trend.sourceType, 'source_derived_angle');
    assert.equal(angles[0].trend.parentSourceId, base.trend.link);
    assert.equal(deriveGroundedSourceAngles([base], [], 1).length, 0);
  });

  it('keeps a seven-topic pool mixed across intents and caps community-only topics', () => {
    const intents = ['recent_development', 'recent_development', 'recent_development', 'recurring_problem', 'audience_question', 'verified_solution', 'beginner_guidance', 'practical_implication'];
    const ranked = intents.map((intent, index) => ({
      trend: { topic: `Topic ${index}`, discoveryIntent: intent, evidenceRole: intent === 'recurring_problem' || intent === 'audience_question' ? 'problem_discovery' : 'strong_secondary' },
      fingerprint: { normalizedTopic: `topic ${index}`, topicCluster: `cluster_${index}`, coreClaim: `claim ${index}`, entities: [], mechanisms: [] },
      relevanceScore: 80, sourceQualityScore: 80, recencyScore: 80, technicalDepthScore: 50, noveltyScore: 100, totalScore: 100 - index,
      novelty: { allowed: true, score: 100, reasons: [] },
    })) as any;
    const composed = applyBatchEvidenceComposition(ranked, 7);
    assert.ok(composed.filter((item) => item.trend.discoveryIntent === 'recent_development').length <= 2);
    assert.ok(composed.filter((item) => item.trend.evidenceRole === 'problem_discovery').length <= 2);
    assert.ok(new Set(composed.map((item) => item.trend.discoveryIntent)).size >= 5);
  });
});

describe('multi-niche isolation', () => {
  const multiStrategy = buildEffectiveBotStrategy({
    description: 'Multi niche author', tone: 'Practical', niches: JSON.stringify(['AI Automation', 'Unity Game Development']),
    contentPillars: {
      primaryPillars: [
        { name: 'AI Automation', description: 'workflow automation', audienceRelevance: '', exampleAngles: [], trendKeywords: ['AI', 'customer transformation'] },
        { name: 'Unity Game Development', description: 'Unity engine development', audienceRelevance: '', exampleAngles: [], trendKeywords: ['Unity engine', 'game engine'] },
      ], secondaryPillars: [], experimentalPillars: [], excludedTopics: [],
    },
    profilePositioning: { positioningStatement: 'AI transformation expert', credibilityPoints: [], uniquePointOfView: '', topicsToBeKnownFor: ['AI Automation'] },
    topicRules: { minimumRelevanceScore: 65, requirePillarMatch: false, requireAudiencePainMatch: false, avoidDuplicateAngles: true, avoidRecentTopicsDays: 30 },
  });

  it('does not award a foreign AI pillar during Unity qualification', () => {
    const unity = profile('Unity Game Development', ['Unity engine', 'game engine'], { entityAliases: ['Unity'], requiredContextTerms: ['engine', 'game'] });
    const ai = profile('AI Automation', ['workflow automation', 'customer transformation']);
    const title = 'AI-powered success with more than 1,000 customer transformation stories';
    const unityScore = scoreTrendForStrategy({ topic: title }, multiStrategy, { profile: unity });
    const aiScore = scoreTrendForStrategy({ topic: title }, multiStrategy, { profile: ai });
    assert.equal(unityScore.breakdown.pillarMatch, 0);
    assert.equal(unityScore.breakdown.positioningMatch, 0);
    assert.ok(unityScore.nicheMatch?.matchedForeignPillars?.includes('AI Automation'));
    assert.equal(decideCandidateEligibility(unityScore.nicheMatch!, true).eligible, false);
    assert.ok(aiScore.breakdown.pillarMatch > 0);
  });

  it('resolves contextual and versioned entity aliases without accepting generic unity', () => {
    const unity = profile('Unity Game Development', ['Unity engine', 'game engine', 'rendering'], { entityAliases: ['Unity'], requiredContextTerms: ['engine', 'game', 'rendering'] });
    for (const title of ['Unity 7 is set to debut in the first quarter of 2027', 'Unity brings dedicated engine support to Netflix Games']) {
      assert.ok(scoreTrendForStrategy({ topic: title }, multiStrategy, { profile: unity }).breakdown.directNicheEvidence! >= 30, title);
    }
    assert.equal(scoreTrendForStrategy({ topic: 'Community unity brings neighbors together' }, multiStrategy, { profile: unity }).nicheMatch?.matchedAlias, null);
  });

  it('matches active AI Automation entities without leaking them into Unity', () => {
    const ai = profile('AI Automation', ['workflow automation'], { importantEntities: ['UiPath', 'Blue Prism'], entityAliases: ['UiPath', 'Blue Prism'] });
    const unity = profile('Unity Game Development', ['Unity engine'], { importantEntities: ['Unity Technologies'], entityAliases: ['Unity'] });
    for (const title of ['UiPath release update expands automation controls', 'Blue Prism case study documents automation outcomes']) {
      assert.ok(scoreTrendForStrategy({ topic: title }, multiStrategy, { profile: ai }).breakdown.directNicheEvidence! >= 30);
      assert.equal(scoreTrendForStrategy({ topic: title }, multiStrategy, { profile: unity }).breakdown.directNicheEvidence, 0);
    }
  });

  it('preserves immutable provenance during normalization', () => {
    const candidate = toTrendCandidate({
      title: 'Unity engine release update', link: 'https://unity.example/release', pubDate: '', source: 'google',
      niche: 'Unity Game Development', originNiche: 'Unity Game Development', profileFingerprint: 'unity-fp',
      originatingQuery: 'Unity Engine release update', queryIntent: 'official_update', originatingSource: 'google',
    }, 'AI Automation', []);
    assert.equal(candidate.originNiche, 'Unity Game Development');
    assert.equal(candidate.niche, 'Unity Game Development');
    assert.equal(candidate.profileFingerprint, 'unity-fp');
  });

  it('prefilters low-value pages and oversamples diverse plausible candidates', () => {
    const plan = profile('Unity Game Development', ['Unity engine', 'rendering'], { entityAliases: ['Unity'] });
    const trends = Array.from({ length: 16 }, (_, index) => ({
      title: `Unity engine rendering release analysis ${index}`, link: `https://example.com/${index}`, pubDate: new Date(2026, 0, index + 1).toISOString(),
      source: index % 2 ? 'google' : 'web', discoveryIntent: index % 2 ? 'official_update' as const : 'case_study' as const,
    }));
    trends.push({ title: 'Unity login page careers jobs', link: 'https://example.com/jobs', pubDate: new Date().toISOString(), source: 'google', discoveryIntent: 'official_update' });
    const result = preselectPlausibleTrends(trends, plan, 24);
    assert.equal(result.eligibleCount, 16);
    assert.equal(result.selected.length, 16);
    assert.ok(new Set(result.selected.map((trend) => trend.discoveryIntent)).size > 1);
  });

  it('selects seven total with initial representation from every qualified niche', () => {
    const subjects = ['release benchmark', 'production incident', 'adoption report', 'practitioner case study'];
    const ranked = ['AI Automation', 'Web Development', 'Unity Game Development'].flatMap((niche, nicheIndex) =>
      Array.from({ length: 4 }, (_, index) => ({
        trend: { topic: `${niche} ${subjects[index]}`, niche, originNiche: niche, publisher: `${niche}-${index}` },
        fingerprint: { normalizedTopic: `${niche}-${subjects[index]}`, topicCluster: `${niche}-${index}`, coreClaim: `${niche} ${subjects[index]}`, entities: [], mechanisms: [] },
        relevanceScore: 80, sourceQualityScore: 80, recencyScore: 80, technicalDepthScore: 50, noveltyScore: 100,
        totalScore: 100 - nicheIndex - index, novelty: { allowed: true, score: 100, reasons: [] },
      })),
    ) as any;
    const selected = selectNicheBalancedCandidates(ranked, 7);
    assert.equal(selected.length, 7);
    assert.deepEqual(new Set(selected.map((item) => item.trend.originNiche)), new Set(['AI Automation', 'Web Development', 'Unity Game Development']));
  });
});
