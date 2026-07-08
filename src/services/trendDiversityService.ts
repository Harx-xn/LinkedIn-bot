import type {
  AuthorContext,
  BatchPostPlan,
  NicheExpansionPlan,
  RankedTrendCandidate,
  TopicCluster,
  TrendCandidate,
} from './generationTypes';
import { TOPIC_DIVERSITY_CONFIG } from '../config/topicDiversityConfig';
import { buildFallbackExpansionPlan } from './nicheExpansionService';
import { loadRecentTopicHistory } from './topicHistoryService';
import { evaluateTopicNovelty } from './topicNoveltyService';
import { normalizeTrendTitle } from './trendTitleUtils';
import { jaccardSimilarity } from './ghostwriterTextUtils';

const EVERGREEN_TOPIC_FAMILIES: Array<{ cluster: TopicCluster; topics: string[] }> = [
  {
    cluster: 'queues_jobs',
    topics: [
      'Why scheduled publishing jobs need idempotency',
      'How retry backoff protects external APIs',
      'When failed jobs should move to a dead-letter queue',
    ],
  },
  {
    cluster: 'database_integrity',
    topics: [
      'Why usage checks and increments belong in one transaction',
      'How database constraints protect business rules',
      'When optimistic concurrency is preferable to locking',
    ],
  },
  {
    cluster: 'deployment_infrastructure',
    topics: [
      'Why configuration drift causes production-only bugs',
      'What containers solve and what they do not',
      'How deployment health checks prevent bad releases',
    ],
  },
  {
    cluster: 'observability',
    topics: [
      'Why background jobs need correlation IDs',
      'What structured logs reveal that plain strings do not',
      'How to distinguish retries from duplicate requests',
    ],
  },
  {
    cluster: 'api_design',
    topics: [
      'Why idempotent API endpoints simplify retries',
      'How rate limits protect shared infrastructure',
      'When webhooks beat polling for integrations',
    ],
  },
  {
    cluster: 'performance',
    topics: [
      'Why caching without invalidation creates stale decisions',
      'How latency budgets shape product architecture',
      'When batching beats real-time processing',
    ],
  },
];

function isTechDomain(domain: string): boolean {
  return /\b(software|saas|technology|developer|engineering|tech|api|cloud)\b/i.test(domain);
}

export function buildEvergreenTopicsForPlan(
  _author: AuthorContext,
  expansionPlan: NicheExpansionPlan,
  count: number,
  usedClusters: Set<string>,
  usedTopics: string[],
): TrendCandidate[] {
  const niche = expansionPlan.niche;
  const domain = expansionPlan.domain;
  const topics: TrendCandidate[] = [];
  const historyClusters = new Set(usedClusters);

  const families = isTechDomain(domain)
    ? EVERGREEN_TOPIC_FAMILIES
    : EVERGREEN_TOPIC_FAMILIES.filter((f) =>
        ['research', 'health', 'operations', 'education', 'marketing', 'other'].includes(f.cluster),
      );

  const subtopicSeeds = expansionPlan.subtopics.length
    ? expansionPlan.subtopics
    : [niche];

  let familyIdx = 0;
  let attempt = 0;
  while (topics.length < count && attempt < count * 4) {
    attempt++;
    const family = families[familyIdx % families.length];
    familyIdx++;

    if (historyClusters.has(family.cluster) && historyClusters.size < families.length) {
      continue;
    }

    const seed = family.topics[attempt % family.topics.length];
    const sub = subtopicSeeds[topics.length % subtopicSeeds.length];
    const topic = isTechDomain(domain)
      ? seed
      : `${sub}: ${seed.replace(/SaaS|API|queue|database/gi, (m) => m.toLowerCase())}`;

    const normalized = normalizeTrendTitle(topic);
    const duplicate = usedTopics.some((t) => jaccardSimilarity(normalizeTrendTitle(t), normalized) > 0.6)
      || topics.some((t) => jaccardSimilarity(normalizeTrendTitle(t.topic), normalized) > 0.6);
    if (duplicate) continue;

    topics.push({
      topic,
      source: 'evergreen',
      link: '',
      niche,
      publishedAt: null,
      fingerprint: {
        normalizedTopic: normalized,
        topicCluster: family.cluster,
        coreClaim: topic,
        entities: [sub],
        mechanisms: [],
      },
    });
    historyClusters.add(family.cluster);
    usedTopics.push(topic);
  }

  if (topics.length < count) {
    const fallback = buildFallbackExpansionPlan(niche);
    for (let i = topics.length; i < count; i++) {
      const q = fallback.queries[i % fallback.queries.length];
      topics.push({
        topic: q.replace(/"/g, ''),
        source: 'evergreen',
        link: '',
        niche,
        publishedAt: null,
      });
    }
  }

  return topics.slice(0, count);
}

export async function fillEvergreenIfNeeded(
  userId: string,
  author: AuthorContext,
  expansionPlans: NicheExpansionPlan[],
  selected: RankedTrendCandidate[],
  needed: number,
): Promise<{ extra: TrendCandidate[]; filled: number }> {
  if (needed <= 0) return { extra: [], filled: 0 };

  const history = await loadRecentTopicHistory(userId);
  const usedClusters = new Set(selected.map((s) => s.fingerprint.topicCluster));
  const usedTopics = [
    ...selected.map((s) => s.trend.topic),
    ...history.map((h) => h.normalizedTopic),
  ];

  const plan = expansionPlans[0] ?? buildFallbackExpansionPlan(author.niches?.[0] ?? 'general');
  const evergreen = buildEvergreenTopicsForPlan(author, plan, needed, usedClusters, usedTopics);

  const filtered = evergreen.filter((t) => {
    const fp = t.fingerprint;
    if (!fp) return true;
    return evaluateTopicNovelty(fp, history).allowed;
  });

  return { extra: filtered, filled: filtered.length };
}

export function validatePlanTopicDiversity(plans: BatchPostPlan[]): string[] {
  const issues: string[] = [];
  const clusters = new Map<string, number>();
  const normalized = new Map<string, number>();
  const claims = new Map<string, number>();
  const hookEnding = new Map<string, number>();

  for (const plan of plans) {
    if (plan.topicCluster) {
      clusters.set(plan.topicCluster, (clusters.get(plan.topicCluster) ?? 0) + 1);
    }
    if (plan.normalizedTopic) {
      normalized.set(plan.normalizedTopic, (normalized.get(plan.normalizedTopic) ?? 0) + 1);
    }
    if (plan.coreClaim) {
      const key = normalizeTrendTitle(plan.coreClaim);
      claims.set(key, (claims.get(key) ?? 0) + 1);
    }
    const heKey = `${plan.hookStyle}:${plan.endingStyle}`;
    hookEnding.set(heKey, (hookEnding.get(heKey) ?? 0) + 1);
  }

  for (const [cluster, count] of clusters) {
    if (count > TOPIC_DIVERSITY_CONFIG.maxPerClusterInBatch) {
      issues.push(`repeated_topic_cluster:${cluster}`);
    }
  }
  for (const [topic, count] of normalized) {
    if (count > 1) issues.push(`repeated_normalized_topic:${topic}`);
  }
  for (const [claim, count] of claims) {
    if (count > 1) issues.push(`repeated_core_claim:${claim}`);
  }
  for (const [combo, count] of hookEnding) {
    if (count > 2) issues.push(`repeated_hook_ending:${combo}`);
  }

  return issues;
}

export function rankedToTrendCandidates(ranked: RankedTrendCandidate[]): TrendCandidate[] {
  return ranked.map((r) => r.trend);
}
