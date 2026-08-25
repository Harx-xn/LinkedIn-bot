import type {
  AuthorContext,
  BatchPostPlan,
  PostAngle,
  RankedTrendCandidate,
  TrendCandidate,
} from './generationTypes';
import { resolvePlanAngle } from './ghostwriterValidationService';
import type { WritingStyle } from './botStrategyService';
import { withDerivedPostDepth } from './postDepth';
import { resolveClaimSource } from './claimNarrowingService';
import type { RecentContentMemory } from './recentContentMemoryService';
import type { AccountPerformanceProfile } from './accountPerformanceLearningService';
import {
  expressionModeForDecision,
  inferEditorialAngle,
  legacyHookStyle,
  legacyLayout,
  selectEditorialDecision,
} from './editorialDecisionService';

const DEFAULT_ANGLE_SEQUENCE: PostAngle[] = [
  'technical_mistake',
  'practical_tutorial',
  'architecture_tradeoff',
  'defensible_opinion',
  'debugging_story',
  'product_lesson',
  'reflection',
];

export type BatchEditorialContext = {
  recentMemory?: RecentContentMemory;
  audience?: string[];
  primaryGoal?: string | null;
  /** Batch callers must leave this false until an explicit anecdote-approval flow exists. */
  personalEvidenceAvailable?: boolean;
  performanceProfile?: AccountPerformanceProfile;
  currentBatch?: NonNullable<BatchPostPlan['editorialDecision']>[];
};

export function buildTopicDiverseBatchPlan(
  ranked: RankedTrendCandidate[],
  count: number,
  writingStyle?: WritingStyle,
  editorialContext: BatchEditorialContext = {},
): BatchPostPlan[] {
  const trends = ranked.map((r) => r.trend);
  const plans = buildDeterministicBatchPlan(trends, count, writingStyle, editorialContext);
  return plans.map((plan, i) => {
    const fp = ranked[i]?.fingerprint;
    if (!fp) return plan;
    return {
      ...plan,
      topicCluster: fp.topicCluster,
      normalizedTopic: fp.normalizedTopic,
      coreClaim: fp.coreClaim,
      mechanismFocus: fp.mechanisms,
    };
  });
}

export function buildDeterministicBatchPlan(
  trends: TrendCandidate[],
  count: number,
  writingStyle?: WritingStyle,
  editorialContext: BatchEditorialContext = {},
): BatchPostPlan[] {
  const plans: BatchPostPlan[] = [];

  for (let i = 0; i < count; i++) {
    const trend = trends[i] ?? null;
    const claimSource = resolveClaimSource(trend);
    const selectedCentralClaim = trend?.topic?.trim() || undefined;
    const fallbackAngle = DEFAULT_ANGLE_SEQUENCE[i % DEFAULT_ANGLE_SEQUENCE.length];
    const topic = trend?.topic ?? '';
    const requestedAngle = inferEditorialAngle(trend, fallbackAngle);
    const angle = topic ? resolvePlanAngle(topic, requestedAngle) : requestedAngle;
    const editorialDecision = selectEditorialDecision(trend, {
      recentMemory: editorialContext.recentMemory,
      currentBatch: [
        ...(editorialContext.currentBatch ?? []),
        ...plans.flatMap((plan) => plan.editorialDecision ? [plan.editorialDecision] : []),
      ],
      audience: trend?.resolvedAudience ?? editorialContext.audience,
      primaryGoal: editorialContext.primaryGoal,
      personalEvidenceAvailable: editorialContext.personalEvidenceAvailable === true,
      performanceProfile: editorialContext.performanceProfile,
    });
    const hookStyle = legacyHookStyle(editorialDecision.hookFamily);
    const endingStyle: BatchPostPlan['endingStyle'] = editorialDecision.endingIntent === 'QUESTION'
      ? 'specific_question'
      : editorialDecision.endingIntent === 'CONCLUSION'
        ? 'takeaway'
        : editorialDecision.endingIntent === 'SOFT_CTA'
          ? 'action'
          : 'natural';

    const basePlan: BatchPostPlan = {
      trendIndex: trend ? i : null,
      sourceTopic: trend?.topic ?? null,
      angle,
      hookStyle,
      endingStyle,
      layout: legacyLayout(editorialDecision.rhetoricalStructure),
      rationale: trend
        ? `Use trend as inspiration for a ${angle.replace(/_/g, ' ')} post`
        : `Evergreen ${angle.replace(/_/g, ' ')} post from author expertise`,
      evergreen: !trend,
      claimSource,
      resolvedAudience: trend?.resolvedAudience ?? [],
      editorialDecision,
      selectedCentralClaim,
      centralClaim: claimSource === 'STRATEGY_SELECTED' ? selectedCentralClaim : undefined,
      depthPlan: {
        centralClaim: trend?.topic ?? 'Develop one narrow claim from author expertise.',
        whyThisClaimIsInteresting: trend?.suggestedAngle ?? null,
        strongestObservations: (trend?.keyPoints ?? []).slice(0, 3),
        underlyingCauseOrMechanism: null,
        deeperInterpretation: trend?.summary?.trim() || null,
        meaningfulConsequence: trend?.audienceRelevance ?? null,
        usefulTensionOrQualification: null,
        personalPerspective: { supported: false, insight: null },
        endingInsight: null,
        avoidIdeas: ['generic recommendation', 'summary that restates the central claim'],
      },
    };
    plans.push(withDerivedPostDepth(
      { ...basePlan, expressionMode: expressionModeForDecision(editorialDecision) },
      trend,
    ));
  }

  return plans;
}

export function assignTrendsToPlan(
  plan: BatchPostPlan[],
  trends: TrendCandidate[],
): BatchPostPlan[] {
  return plan.map((p, i) => {
    const trend = trends[i] ?? null;
    const claimSource = resolveClaimSource(trend);
    return {
      ...p,
      trendIndex: trend ? i : null,
      sourceTopic: trend?.topic ?? p.sourceTopic,
      evergreen: !trend,
      claimSource,
      resolvedAudience: trend?.resolvedAudience ?? p.resolvedAudience ?? [],
      selectedCentralClaim: trend?.topic?.trim() || p.selectedCentralClaim,
      centralClaim: claimSource === 'STRATEGY_SELECTED'
        ? trend?.topic?.trim() || p.centralClaim
        : p.centralClaim,
    };
  });
}

export function summarizeBatchPlan(plan: BatchPostPlan[], author: AuthorContext, trends: TrendCandidate[] = []) {
  return {
    count: plan.length,
    niches: author.niches ?? [],
    angles: plan.map((p) => p.angle),
    hooks: plan.map((p) => p.hookStyle),
    endings: plan.map((p) => p.endingStyle),
    contentObjectives: plan.map((p) => p.editorialDecision?.contentObjective ?? null),
    conversionObjectives: plan.map((p) => p.editorialDecision?.conversionObjective ?? null),
    hookFamilies: plan.map((p) => p.editorialDecision?.hookFamily ?? null),
    rhetoricalStructures: plan.map((p) => p.editorialDecision?.rhetoricalStructure ?? null),
    endingIntents: plan.map((p) => p.editorialDecision?.endingIntent ?? null),
    referenceValueForms: plan.map((p) => p.editorialDecision?.referenceValueForm ?? null),
    shareability: plan.map((p) => p.editorialDecision?.shareabilityProfile ? ({
      overallPotential: p.editorialDecision.shareabilityProfile.overallPotential,
      valueType: p.editorialDecision.shareabilityProfile.valueType,
      recommendedPresentation: p.editorialDecision.shareabilityProfile.recommendedPresentation,
    }) : null),
    depthClasses: plan.map((p) => p.depthClass ?? null),
    targetLengthRanges: plan.map((p) => p.targetLengthRange ?? null),
    semanticStrategySelected: trends.filter((trend) => trend.ideaGenerationMode === 'SEMANTIC').length,
    deterministicStrategySelected: trends.filter((trend) => trend.ideaGenerationMode === 'DETERMINISTIC_FALLBACK').length,
    searchSelected: trends.filter((trend) => trend.sourceType === 'searched'
      || trend.ideaOrigin === 'SEARCH_DISCOVERED' || trend.ideaOrigin === 'RECENT_DEVELOPMENT').length,
    inventorySelected: trends.filter((trend) => Boolean(trend.inventoryId)).length,
    legacySelected: plan.filter((item, index) => item.claimSource === 'LEGACY_TOPIC' && !trends[index]?.inventoryId).length,
    emptyPlanCount: plan.filter((item) => !(item.selectedCentralClaim ?? item.centralClaim ?? item.coreClaim)?.trim()).length,
    topicClusters: plan.map((p) => p.topicCluster ?? null),
    normalizedTopics: plan.map((p) => p.normalizedTopic ?? null),
  };
}
