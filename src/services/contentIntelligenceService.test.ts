import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildEffectiveBotStrategy } from './botStrategyService';
import { buildFallbackContentIntelligence, contentIntelligenceInputFingerprint } from './contentIntelligenceService';
import { buildStrategyIdeaCandidates, ideaToRankedCandidate, scoreContentIdea, selectDiverseIdeas } from './contentIdeaService';
import type { ContentIdeaCandidate } from './contentIdeaService';
import type { TopicHistoryRow } from './topicHistoryService';

function strategy(niches = ['AI Automation', 'Web Development', 'Unity Game Development']) {
  return buildEffectiveBotStrategy({
    description: 'I build practical software systems for small product teams.', tone: 'Direct', niches: JSON.stringify(niches),
    targetAudience: { primaryAudience: 'product founders', painPoints: ['repeated operational work'], desiredOutcomes: ['ship reliable products'] },
  });
}

function baseIdea(overrides: Partial<Omit<ContentIdeaCandidate, 'score' | 'rejectedReasons'>> = {}) {
  return { id: 'x', pillar: 'AI Automation', territory: 'workflow automation', coreClaim: 'The first workflow to automate should remove repeated coordination, not visible client work.', mechanism: 'coordination bottleneck', perspective: 'operator decision', ideaFamily: 'decision heuristic', origin: 'STRATEGY_DERIVED' as const, authorityMode: 'EXPLORATORY' as const, searchRequired: false, saturationPenalty: 0, ...overrides };
}

function historyRow(overrides: Partial<TopicHistoryRow>): TopicHistoryRow {
  return { id: 'h', userId: 'u', postId: null, batchId: null, sourceTitle: null, normalizedTopic: 'topic', topicCluster: 'cluster', coreClaim: null, angle: null, status: 'GENERATED', generatedAt: new Date(), publishedAt: null, ...overrides };
}

describe('content intelligence derivation', () => {
  it('creates stable fingerprints and changes them for material strategy changes', () => {
    const a = strategy();
    assert.equal(contentIntelligenceInputFingerprint(a), contentIntelligenceInputFingerprint(a));
    assert.notEqual(contentIntelligenceInputFingerprint(a), contentIntelligenceInputFingerprint(strategy(['AI Automation'])));
  });

  it('treats a niche as exploratory rather than explicit expertise', () => {
    const profile = buildFallbackContentIntelligence(strategy(['Unity Game Development']));
    assert.equal(profile.authorityMap[0].mode, 'EXPLORATORY');
    assert.match(profile.identity.credibilityBoundaries[0], /Do not imply personal experience/);
  });

  it('builds territory records without changing the effective strategy', () => {
    const input = strategy();
    const before = JSON.stringify(input);
    const profile = buildFallbackContentIntelligence(input);
    assert.equal(profile.territoryMap.length, 3);
    assert.equal(JSON.stringify(input), before);
  });
});

describe('idea quality and selection', () => {
  it('rejects an obvious but technically correct idea', () => {
    const result = scoreContentIdea(baseIdea({ coreClaim: 'Server-side validation is important.' }), []);
    assert.ok(result.rejectedReasons.includes('obvious_or_generic'));
  });

  it('detects different topics that repeat the same mechanism', () => {
    const history = [historyRow({ normalizedTopic: 'client restrictions', topicCluster: 'access', coreClaim: 'Client restrictions do not replace server-side entitlement checks' })];
    const result = scoreContentIdea(baseIdea({ coreClaim: 'Netflix games do not replace server-side entitlement checks', mechanism: 'server-side entitlement checks' }), history);
    assert.ok(result.score.recentSimilarityRisk > 40);
  });

  it('softly penalizes saturated pillars and still leaves candidates available', () => {
    const history = Array.from({ length: 5 }, (_, i) => historyRow({ id: String(i), normalizedTopic: `Unity Game Development ${i}`, topicCluster: 'unity', coreClaim: `claim ${i}` }));
    const candidates = buildStrategyIdeaCandidates(buildFallbackContentIntelligence(strategy()), strategy(), history, 5);
    const unity = candidates.find((c) => c.pillar === 'Unity Game Development');
    const ai = candidates.find((c) => c.pillar === 'AI Automation');
    assert.ok(unity && ai && unity.saturationPenalty > ai.saturationPenalty);
  });

  it('does not let one of three pillars fill five slots when alternatives exist', () => {
    const s = strategy();
    const selected = selectDiverseIdeas(buildStrategyIdeaCandidates(buildFallbackContentIntelligence(s), s, [], 5), 5);
    const counts = selected.reduce<Record<string, number>>((out, item) => ({ ...out, [item.pillar]: (out[item.pillar] ?? 0) + 1 }), {});
    assert.ok(Math.max(...Object.values(counts)) <= 2);
  });

  it('skips search for evergreen strategy-derived ideas', () => {
    const ranked = ideaToRankedCandidate({ ...baseIdea(), ...scoreContentIdea(baseIdea(), []) });
    assert.equal(ranked.trend.searchRequired, false);
    assert.equal(ranked.trend.sourceType, 'strategy_derived');
  });
});
