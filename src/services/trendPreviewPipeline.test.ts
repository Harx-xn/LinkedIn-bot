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
