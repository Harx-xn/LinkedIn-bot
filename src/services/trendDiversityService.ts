import type {
  BatchPostPlan,
  RankedTrendCandidate,
  TrendCandidate,
} from './generationTypes';
import { TOPIC_DIVERSITY_CONFIG } from '../config/topicDiversityConfig';
import { normalizeTrendTitle } from './trendTitleUtils';
import { jaccardSimilarity } from './ghostwriterTextUtils';

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
