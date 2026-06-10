export const NICHE_EXPANSION_PLAN_VERSION = 2;

export const TOPIC_DIVERSITY_CONFIG = {
  maxExpansionQueries: 8,
  candidateMultiplier: 4,
  maxFetchedCandidates: 100,
  maxFingerprintCandidates: 24,
  titleDuplicateThreshold: 0.72,
  currentBatchSemanticThreshold: 0.72,
  historicalSemanticThreshold: 0.82,
  exactTopicCooldownDays: 60,
  semanticCooldownDays: 30,
  clusterCooldownDays: 14,
  generatedDraftCooldownDays: 7,
  historyLookbackDays: 90,
  maxPerClusterInBatch: 1,
  fingerprintConcurrency: 4,
  trendFetchConcurrency: 4,
} as const;

export const HISTORY_WINDOWS = {
  exactTopicDays: TOPIC_DIVERSITY_CONFIG.exactTopicCooldownDays,
  semanticDuplicateDays: TOPIC_DIVERSITY_CONFIG.semanticCooldownDays,
  clusterCooldownDays: TOPIC_DIVERSITY_CONFIG.clusterCooldownDays,
  generatedDraftDays: TOPIC_DIVERSITY_CONFIG.generatedDraftCooldownDays,
} as const;
