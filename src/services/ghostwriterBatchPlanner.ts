import type {
  AuthorContext,
  BatchPostPlan,
  HookStyle,
  PostAngle,
  PostLayout,
  RankedTrendCandidate,
  TrendCandidate,
} from './generationTypes';
import { resolvePlanAngle } from './ghostwriterValidationService';
import { selectBatchExpressionMode } from './expressionModeService';
import type { WritingStyle } from './botStrategyService';

const DEFAULT_ANGLE_SEQUENCE: PostAngle[] = [
  'technical_mistake',
  'practical_tutorial',
  'architecture_tradeoff',
  'defensible_opinion',
  'debugging_story',
  'product_lesson',
  'reflection',
];

const HOOK_ROTATION: HookStyle[] = [
  'observation',
  'contrarian',
  'mistake',
  'lesson',
  'comparison',
  'story',
  'question',
];

const LAYOUT_BY_ANGLE: Record<PostAngle, PostLayout> = {
  technical_mistake: 'problem_mechanism_fix',
  practical_tutorial: 'technical_walkthrough',
  architecture_tradeoff: 'comparison',
  defensible_opinion: 'opinion_with_reasoning',
  debugging_story: 'story_then_lesson',
  product_lesson: 'short_observation',
  reflection: 'short_observation',
};

const ENDING_BY_ANGLE: Record<PostAngle, BatchPostPlan['endingStyle']> = {
  technical_mistake: 'natural',
  practical_tutorial: 'natural',
  architecture_tradeoff: 'natural',
  defensible_opinion: 'natural',
  debugging_story: 'natural',
  product_lesson: 'natural',
  reflection: 'natural',
};

export function buildTopicDiverseBatchPlan(
  ranked: RankedTrendCandidate[],
  count: number,
  writingStyle?: WritingStyle,
): BatchPostPlan[] {
  const trends = ranked.map((r) => r.trend);
  const plans = buildDeterministicBatchPlan(trends, count, writingStyle);
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
): BatchPostPlan[] {
  const plans: BatchPostPlan[] = [];
  let questionEndings = 0;

  for (let i = 0; i < count; i++) {
    const trend = trends[i] ?? null;
    const requestedAngle = DEFAULT_ANGLE_SEQUENCE[i % DEFAULT_ANGLE_SEQUENCE.length];
    const topic = trend?.topic ?? '';
    const angle = topic ? resolvePlanAngle(topic, requestedAngle) : requestedAngle;
    const hookStyle = HOOK_ROTATION[i % HOOK_ROTATION.length];
    let endingStyle = ENDING_BY_ANGLE[angle];

    if (endingStyle === 'specific_question') {
      if (questionEndings >= 2) endingStyle = 'takeaway';
      else questionEndings++;
    }

    const basePlan: BatchPostPlan = {
      trendIndex: trend ? i : null,
      sourceTopic: trend?.topic ?? null,
      angle,
      hookStyle,
      endingStyle,
      layout: LAYOUT_BY_ANGLE[angle],
      rationale: trend
        ? `Use trend as inspiration for a ${angle.replace(/_/g, ' ')} post`
        : `Evergreen ${angle.replace(/_/g, ' ')} post from author expertise`,
      evergreen: !trend,
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
    plans.push({ ...basePlan, expressionMode: selectBatchExpressionMode(i, angle) });
  }

  return plans;
}

export function assignTrendsToPlan(
  plan: BatchPostPlan[],
  trends: TrendCandidate[],
): BatchPostPlan[] {
  return plan.map((p, i) => {
    const trend = trends[i] ?? null;
    return {
      ...p,
      trendIndex: trend ? i : null,
      sourceTopic: trend?.topic ?? p.sourceTopic,
      evergreen: !trend,
    };
  });
}

export function summarizeBatchPlan(plan: BatchPostPlan[], author: AuthorContext) {
  return {
    count: plan.length,
    niches: author.niches ?? [],
    angles: plan.map((p) => p.angle),
    hooks: plan.map((p) => p.hookStyle),
    endings: plan.map((p) => p.endingStyle),
    evergreenCount: plan.filter((p) => p.evergreen).length,
    topicClusters: plan.map((p) => p.topicCluster ?? null),
    normalizedTopics: plan.map((p) => p.normalizedTopic ?? null),
  };
}
