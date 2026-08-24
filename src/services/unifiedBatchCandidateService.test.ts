import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IdeaOrigin, RankedTrendCandidate } from './generationTypes';
import { createRecentContentMemory } from './recentContentMemoryService';
import {
  buildUnifiedCandidateSelection,
  normalizeBatchCandidate,
  selectUnifiedBatchCandidates,
} from './unifiedBatchCandidateService';

function candidate(input: {
  claim: string;
  mechanism: string;
  pillar?: string;
  territory?: string;
  score?: number;
  sourceQuality?: number;
  recency?: number;
  origin?: IdeaOrigin;
  searched?: boolean;
  requiresSearch?: boolean;
  link?: string;
  intent?: RankedTrendCandidate['trend']['discoveryIntent'];
  allowed?: boolean;
  issues?: string[];
}): RankedTrendCandidate {
  const score = input.score ?? 82;
  const pillar = input.pillar ?? 'Operations';
  const territory = input.territory ?? input.claim;
  const fingerprint = {
    normalizedTopic: input.claim.toLowerCase(), topicCluster: territory.toLowerCase().replace(/\W+/g, '_'),
    coreClaim: input.claim, entities: [pillar], mechanisms: [input.mechanism],
  };
  return {
    trend: {
      topic: input.claim, summary: input.claim, niche: pillar, originNiche: pillar, matchedPillar: pillar,
      territory, ideaFamily: 'decision heuristic', audienceRelevance: 'operator decision',
      sourceType: input.searched ? 'searched' : 'strategy_derived',
      ideaOrigin: input.origin ?? (input.searched ? 'SEARCH_DISCOVERED' : 'STRATEGY_DERIVED'),
      authorityMode: input.searched ? 'EXPLORATORY' : 'SUPPORTED_PRACTITIONER',
      searchRequired: input.requiresSearch, ideaQualityScore: score, link: input.link,
      source: input.searched ? 'journal' : 'evergreen', publisher: input.searched ? 'Journal' : undefined,
      evidenceRole: input.link ? 'primary' : undefined, discoveryIntent: input.intent, fingerprint,
    },
    fingerprint, relevanceScore: score, sourceQualityScore: input.sourceQuality ?? (input.searched ? 88 : 70),
    recencyScore: input.recency ?? (input.searched ? 92 : 70), technicalDepthScore: score,
    noveltyScore: score, totalScore: score,
    novelty: { allowed: input.allowed ?? true, score, reasons: input.issues ?? [] },
    matchedPillar: pillar, audienceRelevance: 'operator decision',
  };
}

describe('unified batch candidate selection', () => {
  const distinctStrategy = [
    ['Explicit ownership removes approval loops', 'single decision owner', 'Decision ownership'],
    ['Reconciliation checkpoints expose ledger drift early', 'checkpoint reconciliation', 'Financial controls'],
    ['Structured interviews reduce evaluator noise', 'weighted interview scorecard', 'Interview design'],
    ['Progressive overload depends on recoverable training volume', 'recovery bounded progression', 'Training programming'],
    ['Scenario planning makes cash constraints visible', 'cash runway scenarios', 'Founder planning'],
  ] as const;

  it('uses zero search calls when five strong strategy candidates fill the batch', async () => {
    let calls = 0;
    const strategy = distinctStrategy.map(([claim, mechanism, territory]) => candidate({ claim, mechanism, territory }));
    const result = await buildUnifiedCandidateSelection({ strategyCandidates: strategy, count: 5, search: async () => { calls++; return []; } });
    assert.equal(calls, 0);
    assert.equal(result.searchRequested, 0);
    assert.equal(result.selected.length, 5);
  });

  it('searches only for a buffered one-slot deficit and preserves four strategy ideas', async () => {
    let requested = 0;
    const strategy = distinctStrategy.slice(0, 4).map(([claim, mechanism, territory]) => candidate({ claim, mechanism, territory }));
    const searched = candidate({ claim: 'A recent rule changes the filing sequence', mechanism: 'new filing sequence', pillar: 'Compliance', territory: 'Filing changes', searched: true, link: 'https://example.com/rule' });
    const result = await buildUnifiedCandidateSelection({ strategyCandidates: strategy, count: 5, search: async (count) => { requested = count; return [searched]; } });
    assert.ok(requested >= 1 && requested <= 3);
    assert.equal(result.selected.length, 5);
    assert.equal(result.selected.filter((item) => item.origin === 'STRATEGY_DERIVED').length, 4);
  });

  it('does not discard strategy candidates when search fails', async () => {
    const strategy = distinctStrategy.slice(0, 4).map(([claim, mechanism, territory]) => candidate({ claim, mechanism, territory }));
    const result = await buildUnifiedCandidateSelection({ strategyCandidates: strategy, count: 5, search: async () => { throw new Error('offline'); } });
    assert.equal(result.searchFailed, true);
    assert.equal(result.selected.length, 4);
    assert.ok(result.selected.every((item) => item.origin === 'STRATEGY_DERIVED'));
  });

  it('lets a stronger evergreen idea beat a weaker search candidate', async () => {
    const evergreen = candidate({ claim: 'Clear ownership removes approval loops', mechanism: 'single decision owner', score: 94, requiresSearch: true });
    const weakSearch = candidate({ claim: 'A generic update happened this week', mechanism: 'generic update', score: 45, searched: true, link: 'https://example.com/update' });
    const result = await buildUnifiedCandidateSelection({ strategyCandidates: [evergreen], count: 1, search: async () => [weakSearch] });
    assert.equal(result.selected[0].coreClaim, evergreen.fingerprint.coreClaim);
  });

  it('penalizes a search candidate that repeats a recent mechanism', () => {
    const memory = createRecentContentMemory([{ topic: 'Authorization', coreClaim: 'Clients cannot enforce authorization safely', mechanism: 'server authoritative entitlement validation' }]);
    const repeated = candidate({ claim: 'Streaming apps should verify player access remotely', mechanism: 'server authority validates entitlements', score: 96, searched: true, link: 'https://example.com/access' });
    const novel = candidate({ claim: 'Release queues fail when ownership changes mid-flight', mechanism: 'stable queue ownership', score: 82, territory: 'Release operations' });
    const selected = selectUnifiedBatchCandidates([repeated, novel], 1, memory);
    assert.equal(selected[0].coreClaim, novel.fingerprint.coreClaim);
    assert.ok(normalizeBatchCandidate(repeated).origin === 'SEARCH_DISCOVERED');
  });

  it('enriches a strategy idea with search evidence without replacing its claim', async () => {
    const strategy = candidate({ claim: 'Entitlement decisions belong at the trusted boundary', mechanism: 'server authoritative entitlement validation', requiresSearch: true });
    const evidence = candidate({ claim: 'New guidance recommends trusted entitlement checks', mechanism: 'server validates user entitlements', searched: true, link: 'https://example.com/guidance', intent: 'official_update' });
    const result = await buildUnifiedCandidateSelection({ strategyCandidates: [strategy], count: 1, search: async () => [evidence] });
    assert.equal(result.evidenceEnriched, 1);
    assert.equal(result.selected[0].coreClaim, strategy.fingerprint.coreClaim);
    assert.equal(result.selected[0].mechanism, strategy.fingerprint.mechanisms[0]);
    assert.equal(result.selected[0].evidence.sources[0].url, 'https://example.com/guidance');
  });

  it('preserves source evidence and recent-development origin', () => {
    const recent = normalizeBatchCandidate(candidate({ claim: 'The regulator changed the reporting window', mechanism: 'shortened reporting deadline', searched: true, link: 'https://example.com/regulator', intent: 'recent_development' }));
    assert.equal(recent.origin, 'RECENT_DEVELOPMENT');
    assert.equal(recent.evidence.sources[0].evidenceRole, 'primary');
    assert.equal(recent.evidence.sourceUrl, 'https://example.com/regulator');
  });

  it('selects a mixed batch with pillar and territory diversity', async () => {
    const strategy = [
      candidate({ claim: 'Hiring scorecards need explicit trade-offs', mechanism: 'weighted scorecard', pillar: 'Recruiting', territory: 'Interview design' }),
      candidate({ claim: 'Close checklists expose reconciliation gaps', mechanism: 'reconciliation checklist', pillar: 'Accounting', territory: 'Month-end close' }),
    ];
    const searched = candidate({ claim: 'Updated consent rules alter intake workflows', mechanism: 'consent before intake', pillar: 'Healthcare', territory: 'Patient intake', searched: true, link: 'https://example.com/consent' });
    const result = await buildUnifiedCandidateSelection({ strategyCandidates: strategy, count: 3, search: async () => [searched] });
    assert.equal(new Set(result.selected.map((item) => item.pillar)).size, 3);
    assert.equal(new Set(result.selected.map((item) => item.territory)).size, 3);
  });

  it('uses the legacy fallback when both strategy and search produce nothing', async () => {
    const fallback = candidate({ claim: 'A fallback checklist still creates a useful decision', mechanism: 'ordered decision checklist', origin: 'EVERGREEN' });
    const result = await buildUnifiedCandidateSelection({ strategyCandidates: [], count: 1, search: async () => [], legacyFallbackCandidates: [fallback] });
    assert.equal(result.selected.length, 1);
    assert.equal(result.selected[0].origin, 'EVERGREEN');
  });

  it('returns the best usable candidates when no perfect full batch exists', async () => {
    const strong = candidate({ claim: 'Explicit constraints make handoffs testable', mechanism: 'constraint checklist', score: 90 });
    const usable = candidate({ claim: 'Teams can review handoffs regularly', mechanism: 'regular handoff review', score: 55, allowed: false, issues: ['too_broad'] });
    const unsafe = candidate({ claim: 'Pretend personal results prove the method', mechanism: 'invented experience', score: 99, allowed: false, issues: ['unsupported_authority'] });
    const result = await buildUnifiedCandidateSelection({ strategyCandidates: [strong, usable, unsafe], count: 2 });
    assert.deepEqual(result.selected.map((item) => item.coreClaim), [strong.fingerprint.coreClaim, usable.fingerprint.coreClaim]);
  });
});
