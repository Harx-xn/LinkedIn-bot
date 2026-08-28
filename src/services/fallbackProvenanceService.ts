export const FALLBACK_PROVENANCE = {
  CONTENT_INTELLIGENCE_CACHE: 'CONTENT_INTELLIGENCE_CACHE',
  CONTENT_INTELLIGENCE_REBUILT: 'CONTENT_INTELLIGENCE_REBUILT',
  CONTENT_INTELLIGENCE_DETERMINISTIC_FALLBACK: 'CONTENT_INTELLIGENCE_DETERMINISTIC_FALLBACK',
  STALE_PROFILE_RECOVERY: 'STALE_PROFILE_RECOVERY',
  STRATEGY_IDEA: 'STRATEGY_IDEA',
  SEARCH_FILL: 'SEARCH_FILL',
  LEGACY_DISCOVERY: 'LEGACY_DISCOVERY',
  PLANNER_FALLBACK: 'PLANNER_FALLBACK',
  WRITER_FALLBACK: 'WRITER_FALLBACK',
  BEST_USABLE_FALLBACK: 'BEST_USABLE_FALLBACK',
  EMERGENCY_ACCEPTANCE: 'EMERGENCY_ACCEPTANCE',
  NORMAL_ACCEPTANCE: 'NORMAL_ACCEPTANCE',
  REPAIRED_ACCEPTANCE: 'REPAIRED_ACCEPTANCE',
  EDITORIAL_TOLERANCE_ACCEPTANCE: 'EDITORIAL_TOLERANCE_ACCEPTANCE',
  REGENERATED_ACCEPTANCE: 'REGENERATED_ACCEPTANCE',
  SAFE_FALLBACK_ACCEPTANCE: 'SAFE_FALLBACK_ACCEPTANCE',
  ALTERNATE_CANDIDATE_ACCEPTANCE: 'ALTERNATE_CANDIDATE_ACCEPTANCE',
} as const;

export type FallbackProvenance = typeof FALLBACK_PROVENANCE[keyof typeof FALLBACK_PROVENANCE];

export type OperationalFallbackEvent = {
  provenance: FallbackProvenance;
  userId?: string;
  stage?: string;
  reason?: string;
  count?: number;
  metadata?: Record<string, string | number | boolean | null>;
};

/**
 * One structured event family makes production fallback rates countable without
 * logging prompts, drafts, profiles, or other private content.
 */
export function logFallbackProvenance(event: OperationalFallbackEvent): void {
  console.info('[generation-provenance]', event);
}

