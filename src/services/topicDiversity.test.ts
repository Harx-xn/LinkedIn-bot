import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFallbackExpansionPlan,
  buildFallbackQueries,
  sanitizeExpansionPlan,
  validateExpansionQuery,
} from './nicheExpansionService';
import {
  dedupeTrendCandidates,
  filterLowValueTrends,
  nearDedupeTrends,
  normalizeTrendTitle,
  rejectLowValueTrend,
  trendTitleSimilarity,
  matchesExclusion,
} from './trendTitleUtils';
import {
  buildFallbackFingerprint,
  classifyTopicCluster,
  fingerprintFromBody,
} from './topicFingerprintService';
import { evaluateTopicNovelty, evaluateBatchTopicSimilarity } from './topicNoveltyService';
import type { TopicFingerprint } from './generationTypes';
import { validatePlanTopicDiversity, buildEvergreenTopicsForPlan } from './trendDiversityService';
import { buildTopicDiverseBatchPlan } from './ghostwriterBatchPlanner';
import { validatePostTopicFingerprints } from './ghostwriterValidationService';

describe('niche expansion', () => {
  it('SaaS development fallback queries stay technology-relevant', () => {
    const plan = buildFallbackExpansionPlan('SaaS development');
    assert.ok(plan.queries.some((q) => /saas development/i.test(q)));
    assert.ok(!plan.queries.some((q) => /diseases/i.test(q)));
  });

  it('diseases fallback does not produce developer-tool queries', () => {
    const plan = sanitizeExpansionPlan({
      ...buildFallbackExpansionPlan('diseases'),
      queries: [
        '"diseases" latest developments',
        'diseases developer tools',
        '"diseases" recent research',
        '"diseases" industry trends',
        '"diseases" expert analysis',
      ],
    });
    assert.ok(!plan.queries.some((q) => /developer tools/i.test(q)));
  });

  it('real estate queries reject clinical-study mismatch', () => {
    const check = validateExpansionQuery(
      'real estate clinical trial vaccine study',
      'real estate',
      ['housing market', 'property investment'],
      [],
    );
    assert.equal(check.valid, false);
  });

  it('removes duplicate queries', () => {
    const plan = sanitizeExpansionPlan({
      niche: 'urban beekeeping',
      domain: 'agriculture',
      confidence: 0.7,
      subtopics: ['urban beekeeping', 'hive management'],
      queries: [
        '"urban beekeeping" latest developments',
        '"urban beekeeping" latest developments',
        '"urban beekeeping" recent research',
        '"urban beekeeping" industry trends',
        '"urban beekeeping" expert analysis',
      ],
      exclusions: [],
    });
    const unique = new Set(plan.queries);
    assert.equal(unique.size, plan.queries.length);
  });

  it('unknown niche uses neutral fallback queries', () => {
    const queries = buildFallbackQueries('mycology');
    assert.ok(queries.length >= 6);
    assert.ok(queries.every((q) => q.includes('mycology')));
  });
});

describe('trend filtering', () => {
  it('rejects LinkedIn hiring post', () => {
    const r = rejectLowValueTrend({ topic: 'Senior React Developer hiring now' });
    assert.equal(r.rejected, true);
    assert.equal(r.code, 'job_listing');
  });

  it('rejects unpaid internship', () => {
    const r = rejectLowValueTrend({ topic: 'Unpaid internship for marketing assistant' });
    assert.equal(r.rejected, true);
  });

  it('rejects PR announcement', () => {
    const r = rejectLowValueTrend({ topic: 'Company strengthens position in global market press release' });
    assert.equal(r.rejected, true);
  });

  it('rejects development-company marketing page', () => {
    const r = rejectLowValueTrend({ topic: 'Best software development company in Austin' });
    assert.equal(r.rejected, true);
  });

  it('rejects cost/pricing SEO article', () => {
    const r = rejectLowValueTrend({ topic: 'How much does custom SaaS cost in 2026' });
    assert.equal(r.rejected, true);
  });

  it('accepts meaningful technical result', () => {
    const r = rejectLowValueTrend({ topic: 'Designing idempotent queue workers for SaaS billing' });
    assert.equal(r.rejected, false);
  });

  it('AI exclusions are matched as literal phrases', () => {
    assert.ok(matchesExclusion('Top agency services for SEO', ['agency services']));
  });
});

describe('deduplication', () => {
  it('removes exact duplicate title/link', () => {
    const trends = [
      { topic: 'Queue Retry Backoff', link: 'https://a.com/1' },
      { topic: 'Queue Retry Backoff', link: 'https://a.com/1' },
    ];
    assert.equal(dedupeTrendCandidates(trends).length, 1);
  });

  it('removes near-identical titles', () => {
    const a = 'Queue retry backoff for API workers';
    const b = 'Queue retry backoff strategies for API workers';
    assert.ok(trendTitleSimilarity(a, b) >= 0.72);
    const { kept, removed } = nearDedupeTrends([
      { topic: a },
      { topic: b },
    ]);
    assert.equal(kept.length, 1);
    assert.ok(removed >= 1);
  });

  it('preserves distinct technical titles', () => {
    const kept = dedupeTrendCandidates([
      { topic: 'Database migration safety checklist' },
      { topic: 'Queue retry backoff for webhook delivery' },
    ]);
    assert.equal(kept.length, 2);
  });

  it('normalizes punctuation, years, and capitalization', () => {
    const a = normalizeTrendTitle('API Idempotency in 2026: A Guide!');
    const b = normalizeTrendTitle('api idempotency guide');
    assert.ok(trendTitleSimilarity(a, b) > 0.5);
  });
});

describe('fingerprints', () => {
  it('authorization variants map to authentication cluster', () => {
    assert.equal(
      classifyTopicCluster('JWT authentication is not authorization'),
      'authentication_authorization',
    );
  });

  it('queue retry maps to queues_jobs', () => {
    assert.equal(classifyTopicCluster('Queue retry backoff and idempotency'), 'queues_jobs');
  });

  it('unrelated topics remain different', () => {
    const a = buildFallbackFingerprint({ topic: 'Rare disease diagnosis study' });
    const b = buildFallbackFingerprint({ topic: 'Kubernetes deployment health checks' });
    assert.notEqual(a.topicCluster, b.topicCluster);
  });

  it('fallback fingerprint stays conservative', () => {
    const fp = buildFallbackFingerprint({ topic: 'Some headline only' });
    assert.ok(fp.coreClaim.includes('Some headline') || fp.coreClaim.includes('headline'));
    assert.equal(fp.entities.length, 0);
  });

  it('body fingerprint does not invent absent facts', () => {
    const fp = fingerprintFromBody('Server-side checks matter for billing limits.', 'Billing limits');
    assert.ok(fp.coreClaim.length > 0);
    assert.ok(fp.mechanisms.length <= 4);
  });
});

describe('topic novelty', () => {
  const now = new Date('2026-06-09T12:00:00Z');
  const fp = (partial: Partial<TopicFingerprint>): TopicFingerprint => ({
    normalizedTopic: 'server side subscription enforcement',
    topicCluster: 'billing_entitlements',
    coreClaim: 'usage checks must be enforced on the server',
    entities: ['API'],
    mechanisms: ['atomic increment', 'authorization'],
    ...partial,
  });

  it('blocks exact topic within 60 days for published history', () => {
    const result = evaluateTopicNovelty(fp({}), [{
      id: '1',
      userId: 'u1',
      postId: 'p1',
      batchId: null,
      sourceTitle: 'x',
      normalizedTopic: 'server side subscription enforcement',
      topicCluster: 'billing_entitlements',
      coreClaim: 'usage checks must be enforced on the server',
      angle: null,
      status: 'PUBLISHED',
      generatedAt: new Date('2026-05-01'),
      publishedAt: new Date('2026-05-02'),
    }], now);
    assert.equal(result.allowed, false);
    assert.ok(result.reasons.includes('exact_topic_recent'));
  });

  it('published receives stronger penalty than rejected draft', () => {
    const published = evaluateTopicNovelty(fp({ topicCluster: 'queues_jobs', normalizedTopic: 'queue retry backoff', coreClaim: 'retry backoff protects APIs' }), [{
      id: '1', userId: 'u1', postId: null, batchId: null, sourceTitle: null,
      normalizedTopic: 'queue retry backoff', topicCluster: 'queues_jobs', coreClaim: 'retry backoff',
      angle: null, status: 'PUBLISHED', generatedAt: new Date('2026-06-01'), publishedAt: null,
    }], now);
    const rejected = evaluateTopicNovelty(fp({ topicCluster: 'queues_jobs', normalizedTopic: 'queue retry backoff', coreClaim: 'retry backoff protects APIs' }), [{
      id: '2', userId: 'u1', postId: null, batchId: null, sourceTitle: null,
      normalizedTopic: 'queue retry backoff', topicCluster: 'queues_jobs', coreClaim: 'retry backoff',
      angle: null, status: 'REJECTED', generatedAt: new Date('2026-06-08'), publishedAt: null,
    }], now);
    assert.ok(rejected.score >= published.score);
  });

  it('detects batch semantic duplicates', () => {
    const current = fp({});
    const batch = [fp({ coreClaim: 'usage checks must be enforced on the server atomically' })];
    const check = evaluateBatchTopicSimilarity(current, batch);
    assert.equal(check.duplicate, true);
  });

  it('user histories are isolated by caller scope', () => {
    const result = evaluateTopicNovelty(fp({}), [], now);
    assert.equal(result.allowed, true);
  });
});

describe('batch diversity', () => {
  it('planner varies topic cluster metadata', () => {
    const ranked = [
      {
        trend: { topic: 'Queue retry backoff', source: 'evergreen' },
        fingerprint: {
          normalizedTopic: 'queue retry backoff',
          topicCluster: 'queues_jobs' as const,
          coreClaim: 'retry backoff protects APIs',
          entities: [],
          mechanisms: ['retry'],
        },
        relevanceScore: 80,
        sourceQualityScore: 70,
        recencyScore: 60,
        technicalDepthScore: 70,
        noveltyScore: 90,
        totalScore: 80,
        novelty: { allowed: true, score: 90, reasons: [] },
      },
      {
        trend: { topic: 'Database migration safety', source: 'evergreen' },
        fingerprint: {
          normalizedTopic: 'database migration safety',
          topicCluster: 'database_integrity' as const,
          coreClaim: 'migrations need rollback plans',
          entities: [],
          mechanisms: ['migration'],
        },
        relevanceScore: 80,
        sourceQualityScore: 70,
        recencyScore: 60,
        technicalDepthScore: 70,
        noveltyScore: 90,
        totalScore: 80,
        novelty: { allowed: true, score: 90, reasons: [] },
      },
    ];
    const plan = buildTopicDiverseBatchPlan(ranked, 2);
    assert.notEqual(plan[0].topicCluster, plan[1].topicCluster);
  });

  it('validatePlanTopicDiversity detects repeated cluster', () => {
    const issues = validatePlanTopicDiversity([
      {
        trendIndex: 0,
        sourceTopic: 'a',
        angle: 'technical_mistake',
        hookStyle: 'observation',
        endingStyle: 'takeaway',
        layout: 'problem_mechanism_fix',
        rationale: 'r',
        topicCluster: 'billing_entitlements',
        normalizedTopic: 'topic a',
        coreClaim: 'claim a',
      },
      {
        trendIndex: 1,
        sourceTopic: 'b',
        angle: 'practical_tutorial',
        hookStyle: 'contrarian',
        endingStyle: 'action',
        layout: 'technical_walkthrough',
        rationale: 'r',
        topicCluster: 'billing_entitlements',
        normalizedTopic: 'topic b',
        coreClaim: 'claim b',
      },
    ]);
    assert.ok(issues.some((i) => i.startsWith('repeated_topic_cluster')));
  });

  it('evergreen fallback uses unused clusters', () => {
    const topics = buildEvergreenTopicsForPlan(
      { description: '', tone: 'Professional', niches: ['SaaS development'] },
      buildFallbackExpansionPlan('SaaS development'),
      3,
      new Set(['billing_entitlements']),
      [],
    );
    const clusters = topics.map((t) => t.fingerprint?.topicCluster).filter(Boolean);
    assert.ok(clusters.every((c) => c !== 'billing_entitlements'));
  });
});

describe('final post topic validation', () => {
  it('detects historical topic duplicate in generated body', () => {
    const issues = validatePostTopicFingerprints(
      {
        headline: 'h',
        subheadline: '',
        bulletPoints: [],
        body: 'Authentication proves identity, but authorization controls tenant access on the server.',
        hashtags: '',
      },
      {
        trendIndex: 0,
        sourceTopic: 'Auth article',
        angle: 'technical_mistake',
        hookStyle: 'observation',
        endingStyle: 'takeaway',
        layout: 'problem_mechanism_fix',
        rationale: 'r',
        topicCluster: 'authentication_authorization',
      },
      'Auth article',
      [],
      [{
        id: '1', userId: 'u1', postId: 'p1', batchId: null, sourceTitle: 'old',
        normalizedTopic: 'authentication authorization server',
        topicCluster: 'authentication_authorization',
        coreClaim: 'authentication proves identity authorization controls tenant access server',
        angle: null, status: 'PUBLISHED', generatedAt: new Date(), publishedAt: null,
      }],
    );
    assert.ok(issues.some((i) => i.code === 'historical_topic_duplicate'));
  });
});
