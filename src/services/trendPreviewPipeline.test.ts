import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TREND_PIPELINE_CONFIG, targetCandidateCount } from '../config/trendPipelineConfig';
import {
  buildDeterministicFingerprintKey,
  tokenJaccardSimilarity,
} from './deterministicTrendFingerprint';
import {
  isRedditConfigured,
  isRedditCircuitOpen,
  openRedditCircuit,
  filterRedditFromSources,
  resetRedditSkipLog,
  resetRedditCircuit,
} from './redditCircuit';
import { selectPreviewQueries } from './trendPreviewQuerySelection';
import { buildFallbackExpansionPlan } from './nicheExpansionService';
import {
  buildTrendCacheKey,
  clearTrendFetchCache,
  fetchTrendsWithCache,
} from './trendFetchCache';
import {
  buildTrendConfigHash,
  clearTrendPreviewPoolStore,
  getTrendPreviewPool,
  saveTrendPreviewPool,
} from './trendPreviewPoolStore';
import { processTrendCandidates, countUsableTrends } from './trendSelectionService';
import { TopicFingerprintService } from './topicFingerprintService';
import type { RankedTrendCandidate } from './generationTypes';
import { buildEffectiveBotStrategy } from './botStrategyService';

function mockRanked(title: string, niche = 'SaaS'): RankedTrendCandidate {
  return {
    trend: { topic: title, niche, link: `https://example.com/${title}`, source: 'InfoWorld' },
    fingerprint: {
      normalizedTopic: title.toLowerCase(),
      topicCluster: 'other',
      coreClaim: title,
      entities: [],
      mechanisms: [],
    },
    relevanceScore: 80,
    sourceQualityScore: 82,
    recencyScore: 85,
    technicalDepthScore: 70,
    noveltyScore: 100,
    totalScore: 85,
    novelty: { allowed: true, score: 100, reasons: [] },
  };
}

describe('trend preview pipeline', () => {
  beforeEach(() => {
    clearTrendFetchCache();
    clearTrendPreviewPoolStore();
    resetRedditSkipLog();
    resetRedditCircuit();
  });

  it('preview config disables AI fingerprints', () => {
    assert.equal(TREND_PIPELINE_CONFIG.preview.useAiFingerprints, false);
    assert.equal(TREND_PIPELINE_CONFIG.preview.maxFingerprintCandidates, 0);
    assert.equal(TREND_PIPELINE_CONFIG.generation.useAiFingerprints, true);
  });

  it('preview selects at most four balanced queries', () => {
    const plan = buildFallbackExpansionPlan('SaaS Development');
    const selected = selectPreviewQueries(plan, TREND_PIPELINE_CONFIG.preview.maxQueriesPerNiche);
    assert.ok(selected.length <= 4);
    assert.ok(selected.length >= 3);
  });

  it('filters Reddit when credentials are missing', () => {
    const originalId = process.env.REDDIT_CLIENT_ID;
    const originalSecret = process.env.REDDIT_CLIENT_SECRET;
    delete process.env.REDDIT_CLIENT_ID;
    delete process.env.REDDIT_CLIENT_SECRET;
    assert.equal(isRedditConfigured(), false);
    const filtered = filterRedditFromSources(['google', 'reddit', 'medium']);
    assert.deepEqual(filtered, ['google', 'medium']);
    if (originalId) process.env.REDDIT_CLIENT_ID = originalId;
    if (originalSecret) process.env.REDDIT_CLIENT_SECRET = originalSecret;
  });

  it('opens Reddit circuit on auth failures', () => {
    openRedditCircuit('reddit_http_403', 60_000);
    assert.equal(isRedditCircuitOpen(), true);
    assert.deepEqual(filterRedditFromSources(['reddit']), []);
  });

  it('clusters deterministic near-duplicate SaaS AI headlines', () => {
    const a = 'How AI Is Changing SaaS Products';
    const b = 'Why AI Is Transforming SaaS Software';
    assert.ok(tokenJaccardSimilarity(a, b) >= 0.62);
  });

  it('cache avoids repeated network calls', async () => {
    let calls = 0;
    const key = buildTrendCacheKey({ source: 'google', query: 'saas launch', freshness: '7d' });
    const fetcher = async () => {
      calls += 1;
      return [{ title: 'Cached trend', link: 'https://example.com', pubDate: '', source: 'Test' }];
    };
    await fetchTrendsWithCache(key, 'google', fetcher);
    await fetchTrendsWithCache(key, 'google', fetcher);
    assert.equal(calls, 1);
  });

  it('refresh ignores cached provider results and replaces them', async () => {
    let calls = 0;
    const key = buildTrendCacheKey({ source: 'google', query: 'fresh generation', freshness: '7d' });
    const fetcher = async () => [{ title: `Trend ${++calls}`, link: 'https://example.com', pubDate: '', source: 'Test' }];
    const cached = await fetchTrendsWithCache(key, 'google', fetcher, 'use_cache');
    const refreshed = await fetchTrendsWithCache(key, 'google', fetcher, 'refresh');
    const preview = await fetchTrendsWithCache(key, 'google', fetcher, 'use_cache');
    assert.equal(cached[0].title, 'Trend 1');
    assert.equal(refreshed[0].title, 'Trend 2');
    assert.equal(preview[0].title, 'Trend 2');
    assert.equal(calls, 2);
  });

  it('each refresh performs a new request and never falls back to stale cache on failure', async () => {
    const key = buildTrendCacheKey({ source: 'google', query: 'generation failure', freshness: '7d' });
    await fetchTrendsWithCache(key, 'google', async () => [
      { title: 'Stale trend', link: 'https://example.com/stale', pubDate: '', source: 'Test' },
    ]);
    let refreshCalls = 0;
    await assert.rejects(() => fetchTrendsWithCache(key, 'google', async () => {
      refreshCalls += 1;
      throw new Error('provider unavailable');
    }, 'refresh'), /provider unavailable/);
    const fresh = await fetchTrendsWithCache(key, 'google', async () => {
      refreshCalls += 1;
      return [{ title: 'Fresh trend', link: 'https://example.com/fresh', pubDate: '', source: 'Test' }];
    }, 'refresh');
    assert.equal(refreshCalls, 2);
    assert.equal(fresh[0].title, 'Fresh trend');
  });

  it('bypass neither reads nor replaces provider cache', async () => {
    const key = buildTrendCacheKey({ source: 'google', query: 'cache bypass', freshness: '7d' });
    await fetchTrendsWithCache(key, 'google', async () => [
      { title: 'Cached trend', link: 'https://example.com/cached', pubDate: '', source: 'Test' },
    ]);
    const bypassed = await fetchTrendsWithCache(key, 'google', async () => [
      { title: 'Bypassed trend', link: 'https://example.com/bypass', pubDate: '', source: 'Test' },
    ], 'bypass');
    const cached = await fetchTrendsWithCache(key, 'google', async () => [], 'use_cache');
    assert.equal(bypassed[0].title, 'Bypassed trend');
    assert.equal(cached[0].title, 'Cached trend');
  });

  it('preview processing reports zero OpenAI calls', async () => {
    const fpService = new TopicFingerprintService(null);
    const plan = buildFallbackExpansionPlan('AI Automation');
    const raw = [
      { title: 'Reuters: AI automation funding round', link: 'https://reuters.com/a', pubDate: new Date().toISOString(), source: 'Reuters' },
      { title: 'Forbes: Will AI kill RPA?', link: 'https://forbes.com/b', pubDate: new Date().toISOString(), source: 'Forbes' },
    ];
    const result = await processTrendCandidates({
      userId: 'user-test',
      rawTrends: raw,
      niche: 'AI Automation',
      plan,
      author: { description: 'AI builder', tone: 'Professional', niches: ['AI Automation'] },
      limit: 5,
      fingerprintService: fpService,
      pipelineMode: 'preview',
      history: [],
    });
    assert.equal(result.stats.openAiCalls ?? 0, 0);
    assert.ok(result.selected.length >= 1);
  });

  it('stores and reuses preview pool for generation upgrade path', () => {
    const configHash = buildTrendConfigHash({
      niches: ['SaaS'],
      sources: ['google'],
   });
    const stored = saveTrendPreviewPool({
      userId: 'user-1',
      configHash,
      candidates: [mockRanked('Trend A'), mockRanked('Trend B')],
    });
    const loaded = getTrendPreviewPool(stored.id, 'user-1', configHash);
    assert.equal(loaded.ok, true);
    if (loaded.ok) assert.equal(loaded.pool.candidates.length, 2);
  });

  it('rejects expired or mismatched preview pools', () => {
    const hash = buildTrendConfigHash({
      niches: ['SaaS'],
      sources: ['google'],
     });
    const stored = saveTrendPreviewPool({
      userId: 'user-1',
      configHash: hash,
      candidates: [mockRanked('Trend A')],
    });
    const mismatch = getTrendPreviewPool(stored.id, 'user-1', 'other-hash');
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.equal(mismatch.reason, 'preview_config_mismatch');
  });

  it('target candidate count scales with requested preview size', () => {
    const count = targetCandidateCount('preview', 12);
    assert.ok(count >= 25 && count <= 40);
  });

  it('retains safe fetched trends when strict preview strategy matching rejects the pool', async () => {
    const plan = buildFallbackExpansionPlan('Industry Alpha');
    const strategy = buildEffectiveBotStrategy({
      description: 'I write exclusively for Audience Beta.',
      niches: JSON.stringify(['Industry Beta']),
      tone: 'Professional',
    });
    const result = await processTrendCandidates({
      userId: 'user-generic-preview',
      rawTrends: [
        {
          title: 'Quantum computing research reaches a new error-correction milestone',
          link: 'https://example.com/quantum-milestone',
          pubDate: new Date().toISOString(),
          source: 'Research Journal',
        },
      ],
      niche: 'Industry Alpha',
      plan,
      author: { description: strategy.profilePositioning.positioningStatement, tone: 'Professional', niches: ['Industry Alpha'] },
      limit: 3,
      fingerprintService: new TopicFingerprintService(null),
      pipelineMode: 'preview',
      strategy,
      history: [],
    });

    assert.equal(result.selected.length, 1);
    assert.equal(result.selected[0].trend.source, 'Research Journal');
  });

  it('countUsableTrends applies cheap filtering', () => {
    const raw = [
      { title: 'Best SEO agency services for SaaS', link: 'https://x.com', pubDate: '', source: 'X' },
      { title: 'Acme launches AI platform', link: 'https://y.com', pubDate: new Date().toISOString(), source: 'Reuters' },
    ];
    assert.equal(countUsableTrends(raw, 'SaaS', ['agency services']), 1);
  });

  it('deterministic fingerprint keys are stable', () => {
    const key = buildDeterministicFingerprintKey('How AI Is Changing SaaS Products');
    assert.ok(key.includes('ai'));
    assert.ok(key.includes('chang'));
  });
});
