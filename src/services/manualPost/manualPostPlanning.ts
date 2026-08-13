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
import type { PostDepthPlan } from '../generationTypes';
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

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeDepthPlan(raw: unknown, centralClaim: string): PostDepthPlan {
  const item = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const personal = item.personalPerspective && typeof item.personalPerspective === 'object' && !Array.isArray(item.personalPerspective)
    ? item.personalPerspective as Record<string, unknown> : {};
  const list = (value: unknown, max: number) => Array.isArray(value)
    ? value.map(String).map((entry) => entry.trim()).filter(Boolean).slice(0, max)
    : [];
  return {
    centralClaim: optionalText(item.centralClaim) ?? centralClaim,
    whyThisClaimIsInteresting: optionalText(item.whyThisClaimIsInteresting),
    strongestObservations: list(item.strongestObservations, 8),
    underlyingCauseOrMechanism: optionalText(item.underlyingCauseOrMechanism),
    deeperInterpretation: optionalText(item.deeperInterpretation),
    meaningfulConsequence: optionalText(item.meaningfulConsequence),
    usefulTensionOrQualification: optionalText(item.usefulTensionOrQualification),
    personalPerspective: {
      supported: personal.supported === true && Boolean(optionalText(personal.insight)),
      insight: personal.supported === true ? optionalText(personal.insight) : null,
    },
    endingInsight: optionalText(item.endingInsight),
    avoidIdeas: list(item.avoidIdeas, 5),
  };
}

const PLAN_STOP_WORDS = new Set(
  'a an and are as at be because been but by can could do does for from had has have if in into is it its may might more most not of on or our should so than that the their them then there these they this to under was we when where which while will with without'.split(' '),
);

const GENERIC_PLAN_TOKENS = new Set(
  'adoption benefit better easy easier efficiency good help helps important improve improves improvement key matter matters outcome outcomes positive risk risks success successful suffer suffers value valuable'.split(' '),
);

function normalizedPlanTokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((token) => token.length > 2 && !PLAN_STOP_WORDS.has(token));
}

function planConceptTokens(text: string, topicTokens: Set<string>): Set<string> {
  return new Set(normalizedPlanTokens(text).filter((token) => !topicTokens.has(token)));
}

function setOverlap(a: Set<string>, b: Set<string>): { ratio: number; shared: number } {
  if (!a.size || !b.size) return { ratio: 0, shared: 0 };
  const shared = [...a].filter((token) => b.has(token)).length;
  return { ratio: shared / Math.max(a.size, b.size), shared };
}

function isGenericPlanIdea(text: string, topicTokens: Set<string>): boolean {
  const trimmed = text.trim();
  if (/^(?:it|this|that)\s+(?:is|helps?|matters?|improves?|makes?)\b/i.test(trimmed)) return true;
  if (/^(?:trust|quality|security|communication|consistency|efficiency|adoption|success)\s+(?:is|are|matters?|improves?|helps?|drives?|reduces?|increases?|makes?)\b/i.test(trimmed)) return true;
  const concepts = [...planConceptTokens(trimmed, topicTokens)]
    .filter((token) => !GENERIC_PLAN_TOKENS.has(token));
  return concepts.length < 2;
}

function propositionsDuplicate(a: string, b: string, topicTokens: Set<string>): boolean {
  const aConcepts = planConceptTokens(a, topicTokens);
  const bConcepts = planConceptTokens(b, topicTokens);
  const conceptOverlap = setOverlap(aConcepts, bConcepts);
  if (conceptOverlap.shared >= 2 && conceptOverlap.ratio >= 0.65) return true;

  // Raw overlap is supporting evidence only. Shared domain words such as
  // "trust" and "automation" cannot reject otherwise distinct roles.
  const rawOverlap = setOverlap(new Set(normalizedPlanTokens(a)), new Set(normalizedPlanTokens(b)));
  return rawOverlap.ratio >= 0.82 && conceptOverlap.shared >= 1 && conceptOverlap.ratio >= 0.45;
}

export function evaluateDepthPlanQuality(
  depthPlan: PostDepthPlan,
  options: { topic?: string } = {},
): { passed: boolean; issues: string[] } {
  const issues: string[] = [];
  const topicTokens = new Set(options.topic ? normalizedPlanTokens(options.topic) : []);
  const dimensions = [
    ...depthPlan.strongestObservations,
    depthPlan.underlyingCauseOrMechanism,
    depthPlan.deeperInterpretation,
    depthPlan.meaningfulConsequence,
    depthPlan.usefulTensionOrQualification,
    depthPlan.personalPerspective.insight,
    depthPlan.endingInsight,
  ].filter((value): value is string => Boolean(value));
  if (depthPlan.strongestObservations.length > 3) issues.push('too many observations');
  const substantiveDimensionCount = depthPlan.strongestObservations.length + [
    depthPlan.underlyingCauseOrMechanism,
    depthPlan.deeperInterpretation,
    depthPlan.meaningfulConsequence,
    depthPlan.usefulTensionOrQualification,
    depthPlan.personalPerspective.insight,
  ].filter(Boolean).length;
  if (substantiveDimensionCount > 7) issues.push('depth plan is an exhaustive essay outline');
  if (!depthPlan.deeperInterpretation && !depthPlan.underlyingCauseOrMechanism) issues.push('missing cause or interpretation');
  if (dimensions.length < 2) issues.push('insufficient distinct depth dimensions');
  if ([depthPlan.centralClaim, ...dimensions].filter((idea) => isGenericPlanIdea(idea, topicTokens)).length >= 2) {
    issues.push('plan relies on generic empty ideas');
  }
  const propositions = [depthPlan.centralClaim, ...dimensions];
  for (let i = 0; i < propositions.length; i += 1) {
    for (let j = i + 1; j < propositions.length; j += 1) {
      if (propositionsDuplicate(propositions[i], propositions[j], topicTokens)) {
        issues.push(i === 0
          ? `dimension ${j} restates the central claim`
          : `dimensions ${i} and ${j} repeat the same proposition`);
      }
    }
  }
  return { passed: issues.length === 0, issues: [...new Set(issues)] };
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
    depthPlan: item.depthPlan && typeof item.depthPlan === 'object'
      ? normalizeDepthPlan(item.depthPlan, coreClaim)
      : undefined,
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
  const base = (
    hook.specificity * HOOK_SCORE_WEIGHTS.specificity +
    hook.curiosity * HOOK_SCORE_WEIGHTS.curiosity +
    hook.topicRelevance * HOOK_SCORE_WEIGHTS.topicRelevance +
    hook.clarity * HOOK_SCORE_WEIGHTS.clarity +
    hook.voiceFit * HOOK_SCORE_WEIGHTS.voiceFit
  );
  const genericQuestionPenalty = /^(?:what if|did you know|imagine (?:a|the) world|have you ever)\b/i.test(hook.text)
    ? 2.5
    : 0;
  return base - genericQuestionPenalty;
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
  if (angle.depthPlan) {
    const depthQuality = evaluateDepthPlanQuality(angle.depthPlan, { topic });
    if (!depthQuality.passed) return `depth plan validation failed: ${depthQuality.issues.join(', ')}`;
  }

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
  const evaluatedAngles = planning.angles
    .map((angle) => ({
      angle,
      rejection:
        rejectAngle(angle, topic, supportingContext) ??
        evaluateAngleAgainstFingerprints(angle, recentFingerprints),
      score: scoreAngle(angle) - fingerprintPenaltyForAngle(angle, recentFingerprints),
    }));
  const eligibleAngles = evaluatedAngles
    .filter((entry) => !entry.rejection)
    .sort((a, b) => b.score - a.score);

  const retryablePlanIssues = evaluatedAngles
    .map((entry) => entry.rejection)
    .filter((issue): issue is string => typeof issue === 'string' && !/recent/.test(issue));
  if (eligibleAngles.length === 0 && retryablePlanIssues.length > 0) {
    throw new ManualPlanValidationError(
      retryablePlanIssues,
    );
  }

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
  const selectedCoreClaim = deriveNarrowCentralClaim({ topic, candidateClaim: selectedAngle.coreClaim });
  const selectedDepthPlan = selectedAngle.depthPlan ?? normalizeDepthPlan(undefined, selectedCoreClaim);

  return {
    title: selectedAngle.title,
    coreClaim: selectedCoreClaim,
    audience: selectedAngle.audience,
    structure: selectedAngle.structure,
    evidenceMode: selectedAngle.evidenceMode,
    hook: selectedHook?.text ?? '',
    selectedHookType: selectedHook?.type ?? 'specific_observation',
    depthPlan: { ...selectedDepthPlan, centralClaim: selectedCoreClaim },
  };
}

function buildFallbackDepthPlan(topic: string, centralClaim: string): PostDepthPlan {
  const compactTopic = topic.trim().replace(/\s+/g, ' ');
  const contrast = compactTopic.match(/^(.*?)\b(?:is|are)\s+not\s+(.+?)[.!?]\s*(?:it|they|this)\s+(?:is|are)\s+(.+?)[.!?]?$/i);
  if (contrast) {
    const rejectedExplanation = contrast[2].trim();
    const assertedExplanation = contrast[3].trim();
    return {
      centralClaim,
      whyThisClaimIsInteresting: `The claim changes the diagnosis from ${rejectedExplanation} to ${assertedExplanation}.`,
      strongestObservations: [`The obstacle remains after ${rejectedExplanation} are ruled out as the primary constraint.`],
      underlyingCauseOrMechanism: `The causal constraint named by the topic is ${assertedExplanation}.`,
      deeperInterpretation: `The diagnosis shifts away from ${rejectedExplanation} and toward ${assertedExplanation}.`,
      meaningfulConsequence: `Improving ${rejectedExplanation} alone will not remove the stated obstacle.`,
      usefulTensionOrQualification: null,
      personalPerspective: { supported: false, insight: null },
      endingInsight: null,
      avoidIdeas: [`Simply restating that ${assertedExplanation} matters`],
    };
  }

  return {
    centralClaim,
    whyThisClaimIsInteresting: null,
    strongestObservations: [
      `Develop one observable manifestation logically implied by the central claim about ${compactTopic}; do not invent a case or metric.`,
    ],
    underlyingCauseOrMechanism: 'Explain only the mechanism already contained in the central claim; do not invent an external cause.',
    deeperInterpretation: null,
    meaningfulConsequence: 'Develop the narrow implication of the central claim for the audience without adding generic advice.',
    usefulTensionOrQualification: null,
    personalPerspective: { supported: false, insight: null },
    endingInsight: null,
    avoidIdeas: ['Repeating the central claim in different words', 'Adding unsupported examples or personal experience'],
  };
}

export function createFallbackManualPlan(topic: string, expressionMode: ExpressionMode = 'direct', author?: import('../generationTypes').AuthorContext): SelectedManualPlan {
  const trimmedTopic = topic.trim() || 'this topic';
  const centralClaim = deriveNarrowCentralClaim({ topic: trimmedTopic, expressionMode, author });
  return {
    title: trimmedTopic,
    coreClaim: centralClaim,
    audience: 'Practitioners working on this topic',
    structure: getExpressionModeFallbackStructure(expressionMode),
    evidenceMode: 'reasoned_observation',
    hook: '',
    selectedHookType: 'specific_observation',
    depthPlan: buildFallbackDepthPlan(trimmedTopic, centralClaim),
  };
}

export class ManualPlanValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Planning output failed deterministic depth validation: ${[...new Set(issues)].join('; ')}`);
    this.name = 'ManualPlanValidationError';
  }
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
