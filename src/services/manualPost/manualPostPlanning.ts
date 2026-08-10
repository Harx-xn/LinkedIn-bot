import type {
  ManualAngleCandidate,
  ManualContentPlan,
  ManualHookCandidate,
  ManualPlanningResult,
  SelectedManualPlan,
} from './manualPostTypes';
import { deriveNarrowCentralClaim, isObviouslyGenericClaim } from '../claimNarrowingService';
import { isVagueManualHook } from './manualGenericAiDetector';
import { getExpressionModeFallbackStructure } from '../expressionModeService';
import type { ExpressionMode } from '../generationTypes';
import {
  calculateFingerprintSimilarity,
  CORE_CLAIM_REJECT_THRESHOLD,
  CORE_CLAIM_REPEAT_THRESHOLD,
  isBroadTopicAllowed,
  type ManualPostFingerprintRecord,
} from './manualPostFingerprintService';

const ANGLE_SCORE_WEIGHTS = {
  specificity: 0.25,
  novelty: 0.2,
  audienceFit: 0.15,
  voiceFit: 0.2,
  evidenceAvailability: 0.2,
} as const;

const HOOK_SCORE_WEIGHTS = {
  specificity: 0.3,
  curiosity: 0.2,
  topicRelevance: 0.2,
  clarity: 0.15,
  voiceFit: 0.15,
} as const;

const BROAD_ANGLE_PATTERNS = [
  /\beverything\b/i,
  /\balways\b/i,
  /\bnever\b/i,
  /\bthe key to success\b/i,
  /\btransform your\b/i,
  /\bgame[- ]changer\b/i,
  /\bunlock\b/i,
];

const INVENTED_STORY_PATTERNS = [
  /\bwhen i was\b/i,
  /\blast year i\b/i,
  /\bmy team and i\b/i,
  /\bwe built\b/i,
  /\bi remember when\b/i,
  /\bone client\b/i,
  /\bour customer\b/i,
];

const UNSUPPORTED_FACT_PATTERNS = [
  /\b\d+(?:\.\d+)?%\b/,
  /\b\$[\d,]+(?:\.\d+)?\b/,
  /\b\d{4}\b/,
  /\b(?:million|billion|thousand)\b/i,
];

const VIEWPOINT_MARKERS = [
  /\bbecause\b/i,
  /\bshould\b/i,
  /\bmust\b/i,
  /\bavoid\b/i,
  /\bprefer\b/i,
  /\binsight\b/i,
  /\btradeoff\b/i,
  /\bmistake\b/i,
  /\blesson\b/i,
  /\brisk\b/i,
];

function clampScore(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(10, n));
}

function normalizeAngle(raw: unknown): ManualAngleCandidate | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const title = typeof item.title === 'string' ? item.title.trim() : '';
  const coreClaim = typeof item.coreClaim === 'string' ? item.coreClaim.trim() : '';
  const audience = typeof item.audience === 'string' ? item.audience.trim() : '';
  const structure = typeof item.structure === 'string' ? item.structure.trim() : '';
  const evidenceMode = typeof item.evidenceMode === 'string' ? item.evidenceMode.trim() : '';
  if (!title || !coreClaim || !audience || !structure || !evidenceMode) return null;

  const hookCandidates = Array.isArray(item.hookCandidates)
    ? item.hookCandidates
        .map(normalizeHook)
        .filter((hook): hook is ManualHookCandidate => Boolean(hook))
    : [];

  return {
    title,
    coreClaim,
    audience,
    structure,
    evidenceMode,
    specificity: clampScore(item.specificity),
    novelty: clampScore(item.novelty),
    audienceFit: clampScore(item.audienceFit),
    voiceFit: clampScore(item.voiceFit),
    evidenceAvailability: clampScore(item.evidenceAvailability),
    hookCandidates,
  };
}

function normalizeHook(raw: unknown): ManualHookCandidate | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const text = typeof item.text === 'string' ? item.text.trim() : '';
  const type = typeof item.type === 'string' ? item.type.trim() : 'SPECIFIC_WARNING';
  if (!text) return null;

  return {
    text,
    type,
    specificity: clampScore(item.specificity),
    curiosity: clampScore(item.curiosity),
    topicRelevance: clampScore(item.topicRelevance),
    clarity: clampScore(item.clarity),
    voiceFit: clampScore(item.voiceFit),
  };
}

export function parseManualPlanningResult(raw: string): ManualPlanningResult {
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const parsed = JSON.parse(cleaned) as Record<string, unknown>;
  const angles = Array.isArray(parsed.angles)
    ? parsed.angles.map(normalizeAngle).filter((angle): angle is ManualAngleCandidate => Boolean(angle))
    : [];

  if (angles.length === 0) {
    throw new Error('Planning output did not include any valid angles');
  }

  return { angles };
}

export function scoreAngle(angle: ManualAngleCandidate): number {
  return (
    angle.specificity * ANGLE_SCORE_WEIGHTS.specificity +
    angle.novelty * ANGLE_SCORE_WEIGHTS.novelty +
    angle.audienceFit * ANGLE_SCORE_WEIGHTS.audienceFit +
    angle.voiceFit * ANGLE_SCORE_WEIGHTS.voiceFit +
    angle.evidenceAvailability * ANGLE_SCORE_WEIGHTS.evidenceAvailability
  );
}

export function scoreHook(hook: ManualHookCandidate): number {
  return (
    hook.specificity * HOOK_SCORE_WEIGHTS.specificity +
    hook.curiosity * HOOK_SCORE_WEIGHTS.curiosity +
    hook.topicRelevance * HOOK_SCORE_WEIGHTS.topicRelevance +
    hook.clarity * HOOK_SCORE_WEIGHTS.clarity +
    hook.voiceFit * HOOK_SCORE_WEIGHTS.voiceFit
  );
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 3),
  );
}

function overlapRatio(a: string, b: string): number {
  const aTokens = tokenize(a);
  const bTokens = tokenize(b);
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap += 1;
  }
  return overlap / Math.max(aTokens.size, bTokens.size);
}

export function rejectAngle(
  angle: ManualAngleCandidate,
  topic: string,
  supportingContext?: string,
): string | null {
  const combined = `${angle.title} ${angle.coreClaim}`;
  const topicOverlap = overlapRatio(angle.coreClaim, topic);
  const titleClaimOverlap = overlapRatio(angle.title, angle.coreClaim);

  if (isObviouslyGenericClaim(angle.coreClaim)) return 'central claim is generic';

  if (titleClaimOverlap < 0.08 && overlapRatio(angle.title, topic) > 0.85) {
    return 'mixes unrelated concepts';
  }

  if (BROAD_ANGLE_PATTERNS.some((pattern) => pattern.test(combined))) {
    return 'too broad';
  }

  if (INVENTED_STORY_PATTERNS.some((pattern) => pattern.test(combined))) {
    return 'requires invented stories';
  }

  const allowedEvidence = `${supportingContext ?? ''} ${topic}`;
  if (
    UNSUPPORTED_FACT_PATTERNS.some((pattern) => pattern.test(combined)) &&
    !UNSUPPORTED_FACT_PATTERNS.some((pattern) => pattern.test(allowedEvidence))
  ) {
    return 'depends on unsupported facts';
  }

  if (
    topicOverlap > 0.82 &&
    !VIEWPOINT_MARKERS.some((pattern) => pattern.test(angle.coreClaim))
  ) {
    return 'repeats topic without viewpoint';
  }

  return null;
}

export function rejectHook(hook: ManualHookCandidate): string | null {
  if (isVagueManualHook(hook.text)) {
    return 'vague hook';
  }
  return null;
}

export function evaluateAngleAgainstFingerprints(
  angle: ManualAngleCandidate,
  fingerprints: ManualPostFingerprintRecord[],
): string | null {
  for (const fingerprint of fingerprints) {
    const similarity = calculateFingerprintSimilarity(
      {
        coreClaim: angle.coreClaim,
        structure: angle.structure,
        hookType: angle.hookCandidates[0]?.type ?? null,
        evidenceType: angle.evidenceMode,
        ctaType: 'takeaway',
        primaryTopic: angle.title,
      },
      fingerprint,
    );

    if (similarity.coreClaimSimilarity >= CORE_CLAIM_REJECT_THRESHOLD) {
      return 'repeats recent core claim';
    }

    if (
      isBroadTopicAllowed(angle.title, fingerprint.primaryTopic, similarity.coreClaimSimilarity) &&
      similarity.coreClaimSimilarity < CORE_CLAIM_REPEAT_THRESHOLD
    ) {
      continue;
    }

    if (similarity.score >= 0.85) {
      return 'repeats recent presentation pattern';
    }
  }

  return null;
}

export function fingerprintPenaltyForAngle(
  angle: ManualAngleCandidate,
  fingerprints: ManualPostFingerprintRecord[],
): number {
  let penalty = 0;

  for (const fingerprint of fingerprints) {
    const similarity = calculateFingerprintSimilarity(
      {
        coreClaim: angle.coreClaim,
        structure: angle.structure,
        hookType: angle.hookCandidates[0]?.type ?? null,
        evidenceType: angle.evidenceMode,
        ctaType: 'takeaway',
        primaryTopic: angle.title,
      },
      fingerprint,
    );

    if (similarity.coreClaimSimilarity >= CORE_CLAIM_REPEAT_THRESHOLD) {
      penalty += 2.5;
    } else if (similarity.coreClaimSimilarity >= 0.55) {
      penalty += 1;
    }

    if (similarity.reasons.includes('repeated_hook_type')) penalty += 0.8;
    if (similarity.reasons.includes('repeated_structure')) penalty += 0.7;
    if (similarity.reasons.includes('repeated_closing_style')) penalty += 0.5;
  }

  return penalty;
}

export function fingerprintPenaltyForHook(
  hook: ManualHookCandidate,
  fingerprints: ManualPostFingerprintRecord[],
): number {
  const matches = fingerprints.filter((fingerprint) => fingerprint.hookType === hook.type).length;
  return matches > 0 ? Math.min(2, matches * 0.6) : 0;
}

export function selectManualPlan(
  planning: ManualPlanningResult,
  topic: string,
  supportingContext?: string,
  recentFingerprints: ManualPostFingerprintRecord[] = [],
): SelectedManualPlan {
  const eligibleAngles = planning.angles
    .map((angle) => ({
      angle,
      rejection:
        rejectAngle(angle, topic, supportingContext) ??
        evaluateAngleAgainstFingerprints(angle, recentFingerprints),
      score: scoreAngle(angle) - fingerprintPenaltyForAngle(angle, recentFingerprints),
    }))
    .filter((entry) => !entry.rejection)
    .sort((a, b) => b.score - a.score);

  const selectedAngle = eligibleAngles[0]?.angle ?? planning.angles
    .map((angle) => ({ angle, score: scoreAngle(angle) }))
    .sort((a, b) => b.score - a.score)[0]!.angle;

  const eligibleHooks = selectedAngle.hookCandidates
    .map((hook) => ({
      hook,
      rejection: rejectHook(hook),
      score: scoreHook(hook) - fingerprintPenaltyForHook(hook, recentFingerprints),
    }))
    .filter((entry) => !entry.rejection)
    .sort((a, b) => b.score - a.score);

  const selectedHook = eligibleHooks[0]?.hook ?? null;

  return {
    title: selectedAngle.title,
    coreClaim: deriveNarrowCentralClaim({ topic, candidateClaim: selectedAngle.coreClaim }),
    audience: selectedAngle.audience,
    structure: selectedAngle.structure,
    evidenceMode: selectedAngle.evidenceMode,
    hook: selectedHook?.text ?? '',
    selectedHookType: selectedHook?.type ?? 'specific_observation',
  };
}

export function createFallbackManualPlan(topic: string, expressionMode: ExpressionMode = 'direct', author?: import('../generationTypes').AuthorContext): SelectedManualPlan {
  const trimmedTopic = topic.trim() || 'this topic';
  return {
    title: trimmedTopic,
    coreClaim: deriveNarrowCentralClaim({ topic: trimmedTopic, expressionMode, author }),
    audience: 'Practitioners working on this topic',
    structure: getExpressionModeFallbackStructure(expressionMode),
    evidenceMode: 'reasoned_observation',
    hook: '',
    selectedHookType: 'specific_observation',
  };
}

export function selectedPlanToContentPlan(plan: SelectedManualPlan): ManualContentPlan {
  return {
    angle: plan.title,
    coreClaim: plan.coreClaim,
    audience: plan.audience,
    structure: plan.structure,
    hookType: plan.selectedHookType,
    evidenceType: plan.evidenceMode,
    ctaType: 'none',
  };
}
