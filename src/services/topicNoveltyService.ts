import { HISTORY_WINDOWS, TOPIC_DIVERSITY_CONFIG } from '../config/topicDiversityConfig';
import type { NoveltyEvaluation, TopicFingerprint } from './generationTypes';
import { jaccardSimilarity } from './ghostwriterTextUtils';
import type { TopicHistoryRow } from './topicHistoryService';
import { normalizeTrendTitle } from './trendTitleUtils';

const STATUS_WEIGHT: Record<string, number> = {
  PUBLISHED: 1.0,
  SCHEDULED: 0.95,
  APPROVED: 0.85,
  GENERATED: 0.55,
  REJECTED: 0.2,
};

function daysBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24);
}

function mechanismOverlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a.map((x) => x.toLowerCase()));
  const sb = new Set(b.map((x) => x.toLowerCase()));
  const inter = [...sa].filter((x) => sb.has(x)).length;
  const union = new Set([...sa, ...sb]).size;
  return union === 0 ? 0 : inter / union;
}

function claimSimilarity(a: string, b: string): number {
  return jaccardSimilarity(normalizeTrendTitle(a), normalizeTrendTitle(b));
}

export function evaluateTopicNovelty(
  fingerprint: TopicFingerprint,
  history: TopicHistoryRow[],
  now: Date = new Date(),
): NoveltyEvaluation {
  const reasons: string[] = [];
  let score = 100;
  let closestMatch: NoveltyEvaluation['closestMatch'];

  for (const row of history) {
    const ageDays = daysBetween(now, row.generatedAt);
    const weight = STATUS_WEIGHT[row.status] ?? 0.5;

    const topicSim = claimSimilarity(fingerprint.normalizedTopic, row.normalizedTopic);
    const claimSim = row.coreClaim
      ? claimSimilarity(fingerprint.coreClaim, row.coreClaim)
      : topicSim;
    const mechSim = row.coreClaim
      ? mechanismOverlap(fingerprint.mechanisms, row.coreClaim.split(/\s+/).filter((w) => w.length > 3))
      : 0;

    if (
      topicSim >= 0.98
      && ageDays <= HISTORY_WINDOWS.exactTopicDays
      && ['PUBLISHED', 'SCHEDULED', 'APPROVED'].includes(row.status)
    ) {
      return {
        allowed: false,
        score: 0,
        reasons: ['exact_topic_recent'],
        closestMatch: {
          historyId: row.id,
          similarity: topicSim,
          generatedAt: row.generatedAt,
          topicCluster: row.topicCluster,
          status: row.status,
        },
      };
    }

    if (
      claimSim >= TOPIC_DIVERSITY_CONFIG.historicalSemanticThreshold
      && ageDays <= HISTORY_WINDOWS.semanticDuplicateDays
      && weight >= 0.5
    ) {
      return {
        allowed: false,
        score: 0,
        reasons: ['semantic_duplicate_recent'],
        closestMatch: {
          historyId: row.id,
          similarity: claimSim,
          generatedAt: row.generatedAt,
          topicCluster: row.topicCluster,
          status: row.status,
        },
      };
    }

    if (
      fingerprint.topicCluster === row.topicCluster
      && ageDays <= HISTORY_WINDOWS.clusterCooldownDays
    ) {
      const penalty = Math.round(22 * weight);
      score -= penalty;
      reasons.push(`cluster_cooldown:${row.topicCluster}`);
    }

    if (row.status === 'GENERATED' && ageDays <= HISTORY_WINDOWS.generatedDraftDays) {
      score -= Math.round(12 * weight);
      reasons.push('recent_generated_draft');
    }

    const combinedSim = Math.max(topicSim, claimSim, mechSim);
    if (!closestMatch || combinedSim > closestMatch.similarity) {
      closestMatch = {
        historyId: row.id,
        similarity: combinedSim,
        generatedAt: row.generatedAt,
        topicCluster: row.topicCluster,
        status: row.status,
      };
    }
  }

  score = Math.max(0, Math.min(100, score));
  return {
    allowed: score >= 35,
    score,
    reasons: [...new Set(reasons)],
    closestMatch,
  };
}

export function evaluateBatchTopicSimilarity(
  fingerprint: TopicFingerprint,
  batchFingerprints: TopicFingerprint[],
  threshold = TOPIC_DIVERSITY_CONFIG.currentBatchSemanticThreshold,
): { duplicate: boolean; code?: string; similarity: number } {
  let maxSim = 0;
  for (const other of batchFingerprints) {
    if (other.normalizedTopic === fingerprint.normalizedTopic) {
      return { duplicate: true, code: 'repeated_normalized_topic', similarity: 1 };
    }
    if (other.topicCluster === fingerprint.topicCluster) {
      const claimSim = claimSimilarity(fingerprint.coreClaim, other.coreClaim);
      const mechSim = mechanismOverlap(fingerprint.mechanisms, other.mechanisms);
      const sim = Math.max(claimSim, mechSim, jaccardSimilarity(fingerprint.normalizedTopic, other.normalizedTopic));
      maxSim = Math.max(maxSim, sim);
      if (sim >= threshold) {
        return { duplicate: true, code: 'semantic_batch_duplicate', similarity: sim };
      }
      if (fingerprint.topicCluster === other.topicCluster && claimSim >= 0.55) {
        return { duplicate: true, code: 'repeated_topic_cluster', similarity: claimSim };
      }
      if (mechSim >= 0.7 && fingerprint.mechanisms.length > 0) {
        return { duplicate: true, code: 'repeated_mechanism_focus', similarity: mechSim };
      }
      if (claimSim >= 0.65) {
        return { duplicate: true, code: 'repeated_core_claim', similarity: claimSim };
      }
    }
  }
  return { duplicate: false, similarity: maxSim };
}

export function evaluateHistoricalPostSimilarity(
  fingerprint: TopicFingerprint,
  history: TopicHistoryRow[],
  now: Date = new Date(),
): { blocked: boolean; code?: string } {
  const novelty = evaluateTopicNovelty(fingerprint, history, now);
  if (!novelty.allowed) {
    return { blocked: true, code: novelty.reasons[0] ?? 'historical_topic_duplicate' };
  }
  return { blocked: false };
}
