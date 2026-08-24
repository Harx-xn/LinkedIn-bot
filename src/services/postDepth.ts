import type {
  BatchPostPlan,
  PostDepth,
  PostTargetLengthRange,
  TrendCandidate,
} from './generationTypes';

export const POST_DEPTH_TARGETS: Record<PostDepth, PostTargetLengthRange> = {
  COMPACT: { min: 600, max: 1100 },
  STANDARD: { min: 900, max: 1700 },
  DEEP: { min: 1400, max: 2500 },
};

/**
 * Guardrails for drafts that are implausibly short for the assigned plan.
 * These sit below the soft drafting ranges; specificity and progression remain
 * the real completeness gates inside the range.
 */
export const POST_DEPTH_COMPLETENESS_MINIMUMS: Record<PostDepth, number> = {
  COMPACT: 400,
  STANDARD: 700,
  DEEP: 1000,
};

function normalizedTokens(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

function substantiallyRepeats(value: string, reference: string): boolean {
  const candidate = normalizedTokens(value);
  const base = normalizedTokens(reference);
  if (!candidate.size || !base.size) return false;
  const intersection = [...candidate].filter((token) => base.has(token)).length;
  return intersection / Math.min(candidate.size, base.size) >= 0.82;
}

function meaningful(value: string | null | undefined, centralClaim: string): boolean {
  const text = value?.trim() ?? '';
  return text.length >= 12 && !substantiallyRepeats(text, centralClaim);
}

/**
 * Classifies the amount of reasoning assigned to a post. The score deliberately
 * ignores niche/topic names and uses only the plan's substantive obligations.
 */
export function classifyPostDepth(plan: BatchPostPlan, trend?: TrendCandidate | null): PostDepth {
  const depth = plan.depthPlan;
  const centralClaim = plan.centralClaim ?? depth?.centralClaim ?? plan.coreClaim ?? plan.sourceTopic ?? '';
  const observations = (depth?.strongestObservations ?? [])
    .filter((observation) => meaningful(observation, centralClaim))
    .slice(0, 3);

  let score = observations.length;
  if (meaningful(depth?.whyThisClaimIsInteresting, centralClaim)) score += 1;
  if (meaningful(depth?.underlyingCauseOrMechanism, centralClaim)) score += 2;
  if (meaningful(depth?.deeperInterpretation, centralClaim)) score += 1;
  if (meaningful(depth?.meaningfulConsequence, centralClaim)) score += 1;
  if (meaningful(depth?.usefulTensionOrQualification, centralClaim)) score += 1;
  if (depth?.personalPerspective.supported && meaningful(depth.personalPerspective.insight, centralClaim)) score += 1;

  const sourceDetailIsMaterial = !!trend && (
    (trend.keyPoints?.length ?? 0) >= 2
    || (trend.supportingSources?.length ?? 0) > 0
    || (!!trend.link && !!trend.summary?.trim() && trend.contentType !== 'evergreen')
  );
  if (sourceDetailIsMaterial) score += 1;

  if (
    plan.angle === 'architecture_tradeoff'
    && meaningful(depth?.usefulTensionOrQualification, centralClaim)
  ) score += 1;

  if (
    (plan.angle === 'practical_tutorial' || plan.layout === 'technical_walkthrough')
    && observations.length >= 2
  ) score += 1;

  const claimWords = centralClaim.trim().split(/\s+/).filter(Boolean).length;
  const claimHasMultipleNecessaryClauses = claimWords > 28
    || /\b(?:because|unless|until|while|whereas|only when)\b/i.test(centralClaim);
  if (claimHasMultipleNecessaryClauses) score += 1;

  if (score >= 6) return 'DEEP';
  if (score >= 3) return 'STANDARD';
  return 'COMPACT';
}

export function withDerivedPostDepth(
  plan: BatchPostPlan,
  trend?: TrendCandidate | null,
): BatchPostPlan {
  const depthClass = classifyPostDepth(plan, trend);
  return {
    ...plan,
    depthClass,
    targetLengthRange: { ...POST_DEPTH_TARGETS[depthClass] },
  };
}

export function resolvePostDepthMetadata(plan: BatchPostPlan): {
  depthClass: PostDepth;
  targetLengthRange: PostTargetLengthRange;
  minimumCompleteLength: number;
} {
  const depthClass = plan.depthClass ?? classifyPostDepth(plan);
  return {
    depthClass,
    targetLengthRange: plan.targetLengthRange ?? POST_DEPTH_TARGETS[depthClass],
    minimumCompleteLength: POST_DEPTH_COMPLETENESS_MINIMUMS[depthClass],
  };
}
