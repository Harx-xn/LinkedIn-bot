import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFallbackExpansionPlan,
  buildQueryBucketsFromQueries,
  flattenExpansionQueries,
} from './nicheExpansionService';
import { NICHE_EXPANSION_PLAN_VERSION } from '../config/topicDiversityConfig';
import {
  detectSocialPostAsHeadline,
  rejectLowValueTrend,
  trendTitleSimilarity,
} from './trendTitleUtils';
import { extractPublisherFromGoogleNewsTitle, scorePublisherQuality } from './trendPublisherUtils';
import { scoreDiscoverySourceQuality } from './trendPublisherUtils';
import { selectDiverseRankedCandidates } from './trendRankingService';
import type { RankedTrendCandidate } from './generationTypes';
import { classifyTrendContentType } from './trendContentType';
import { parseTrendSources } from './trendsService';

function mockRanked(partial: Partial<RankedTrendCandidate> & { title: string }): RankedTrendCandidate {
  const cluster = partial.fingerprint?.topicCluster ?? 'ai_automation';
  return {
    trend: {
      topic: partial.title,
      source: partial.trend?.source ?? 'InfoWorld',
      publisher: partial.trend?.publisher ?? 'InfoWorld',
      discoverySource: partial.trend?.discoverySource ?? 'Google News',
      ...partial.trend,
    },
    fingerprint: partial.fingerprint ?? {
      normalizedTopic: partial.title.toLowerCase(),
      topicCluster: cluster,
      coreClaim: partial.title,
      entities: [],
      mechanisms: [],
    },
    relevanceScore: partial.relevanceScore ?? 80,
    sourceQualityScore: partial.sourceQualityScore ?? 82,
    recencyScore: partial.recencyScore ?? 85,
    technicalDepthScore: partial.technicalDepthScore ?? 70,
    noveltyScore: partial.noveltyScore ?? 90,
    totalScore: partial.totalScore ?? 85,
    novelty: partial.novelty ?? { allowed: true, score: 90, reasons: [] },
    contentType: partial.contentType,
  };
}

describe('trend preview quality', () => {
  it('cached v1 plan normalizes into query buckets', () => {
    const legacy = buildQueryBucketsFromQueries(
      ['"SaaS" product launch', '"SaaS" market report'],
      'SaaS development',
    );
    assert.ok(legacy.newsQueries.length + legacy.marketQueries.length >= 2);
  });

  it('empty sources JSON falls back to automatic source planning', () => {
    assert.deepEqual(parseTrendSources('[]'), ['automatic']);
    assert.deepEqual(parseTrendSources(null), ['automatic']);
  });

  it('flattenExpansionQueries supports bucketed plans', () => {
    const plan = buildFallbackExpansionPlan('diseases');
    assert.ok(flattenExpansionQueries(plan).length >= 4);
    assert.equal(plan.version, NICHE_EXPANSION_PLAN_VERSION);
  });

  it('applies niche exclusions on candidates', () => {
    const r = rejectLowValueTrend(
      { topic: 'Best SEO agency services for SaaS', exclusions: ['agency services'] },
      [],
    );
    assert.equal(r.rejected, true);
    assert.ok(r.code?.startsWith('exclusion:'));
  });

  it('clusters near-duplicate SaaS AI headlines', () => {
    const a = 'How AI Is Changing SaaS Products';
    const b = 'Why AI Is Transforming SaaS Software';
    assert.ok(trendTitleSimilarity(a, b) >= 0.45);
  });

  it('Google News publisher is extracted from title suffix', () => {
    const parsed = extractPublisherFromGoogleNewsTitle(
      'Cloud costs are rising - InfoWorld',
      'Google News',
    );
    assert.equal(parsed.publisher, 'InfoWorld');
    assert.equal(parsed.title, 'Cloud costs are rising');
    assert.equal(parsed.discoverySource, 'Google News');
  });

  it('unknown Google publisher gets neutral score', () => {
    const score = scorePublisherQuality('Unknown Publisher', 'Google News');
    assert.ok(score >= 55 && score <= 65);
  });

  it('Medium receives lower score than authoritative publisher', () => {
    const medium = scoreDiscoverySourceQuality('Medium', 'Medium');
    const auth = scoreDiscoverySourceQuality('Google News', 'Reuters');
    assert.ok(medium < auth);
  });

  it('rejects social post body disguised as headline', () => {
    const title = 'I stopped a founder before he walked deeper into an expensive trap. He DM\'d me Wednesday. Here is what happened next. Follow for more.';
    assert.equal(detectSocialPostAsHeadline(title), true);
    const r = rejectLowValueTrend({ topic: title });
    assert.equal(r.code, 'social_post_body_instead_of_headline');
  });

  it('source caps prevent Medium domination', () => {
    const clusters = ['ai_automation', 'queues_jobs', 'observability', 'api_design', 'database_integrity', 'performance'] as const;
    const pool = Array.from({ length: 6 }).map((_, i) => mockRanked({
      title: `Medium SaaS article ${i}`,
      trend: { topic: `Medium SaaS article ${i}`, source: 'Medium', publisher: 'Medium', discoverySource: 'Medium' },
      fingerprint: {
        normalizedTopic: `topic-${i}`,
        topicCluster: clusters[i % clusters.length],
        coreClaim: `distinct claim number ${i}`,
        entities: [],
        mechanisms: [],
      },
    }));
    const selected = selectDiverseRankedCandidates(pool, 5, {
      caps: { maxMediumResults: 2, maxPerPublisher: 2, maxPerSemanticCluster: 2 },
    });
    const mediumCount = selected.filter((s) => s.trend.discoverySource === 'Medium').length;
    assert.ok(mediumCount <= 2);
  });

  it('deduplicates the same fingerprinted trend returned through multiple niches', () => {
    const title = 'AI startup raises funding for workflow automation platform';
    const fingerprint = {
      normalizedTopic: 'ai startup workflow automation funding',
      topicCluster: 'ai_automation' as const,
      coreClaim: 'AI startup raises funding for workflow automation',
      entities: ['AI startup'],
      mechanisms: ['workflow automation'],
    };
    const selected = selectDiverseRankedCandidates([
      mockRanked({ title, trend: { topic: title, niche: 'SaaS' }, fingerprint }),
      mockRanked({ title, trend: { topic: title, niche: 'AI Automation' }, fingerprint }),
    ], 2);

    assert.equal(selected.length, 1);
  });

  it('timely news outranks evergreen by score composition', () => {
    const news = mockRanked({
      title: 'Acme announces major platform launch',
      recencyScore: 95,
      totalScore: 92,
      contentType: 'breaking_news',
      trend: { topic: 'Acme announces major platform launch', publishedAt: new Date().toISOString() },
    });
    const evergreen = mockRanked({
      title: 'Evergreen guide to SaaS architecture',
      recencyScore: 30,
      totalScore: 60,
      contentType: 'evergreen',
    });
    assert.ok(news.totalScore > evergreen.totalScore);
    assert.equal(classifyTrendContentType(news.trend), 'breaking_news');
  });
});
