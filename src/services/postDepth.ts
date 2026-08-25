import type { BatchPostPlan, PostDepth, PostTargetLengthRange, TrendCandidate } from './generationTypes';

export const POST_DEPTH_TARGETS: Record<PostDepth, PostTargetLengthRange> = {
  COMPACT: { min: 600, max: 1100 }, STANDARD: { min: 900, max: 1700 }, DEEP: { min: 1400, max: 2500 },
};

/** Soft-plan completeness floors, not universal drafting minimums. */
export const POST_DEPTH_COMPLETENESS_MINIMUMS: Record<PostDepth, number> = {
  COMPACT: 400, STANDARD: 700, DEEP: 1000,
};

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'by', 'can', 'could', 'for', 'from',
  'has', 'have', 'in', 'into', 'is', 'it', 'its', 'may', 'of', 'on', 'or', 'that', 'the', 'their',
  'this', 'to', 'was', 'were', 'will', 'with', 'would',
]);

const CANONICAL_TOKENS: Record<string, string> = {
  moved: 'transfer', move: 'transfer', moves: 'transfer', moving: 'transfer', shift: 'transfer',
  shifts: 'transfer', shifted: 'transfer', transfer: 'transfer', transfers: 'transfer',
  bottleneck: 'constraint', bottlenecks: 'constraint', constraint: 'constraint', constraints: 'constraint',
  stage: 'step', stages: 'step', phase: 'step', phases: 'step',
  caused: 'cause', causes: 'cause', causing: 'cause', because: 'cause', consequence: 'outcome',
  consequences: 'outcome', impact: 'outcome', impacts: 'outcome', result: 'outcome', results: 'outcome',
  tradeoff: 'tradeoff', compromise: 'tradeoff', sacrifice: 'tradeoff', cost: 'tradeoff',
  record: 'record', records: 'record', recorded: 'record', recording: 'record', save: 'record', saved: 'record',
  store: 'record', stores: 'record', stored: 'record', begin: 'start', begins: 'start', beginning: 'start',
  started: 'start', starting: 'start', prior: 'before',
};

function stem(token: string): string {
  if (CANONICAL_TOKENS[token]) return CANONICAL_TOKENS[token];
  if (token.length > 6 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 5 && token.endsWith('ed')) return token.slice(0, -2);
  if (token.length > 5 && token.endsWith('es')) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith('s')) return token.slice(0, -1);
  return token;
}

function normalizedTokens(value: string): Set<string> {
  return new Set((value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((token) => !STOPWORDS.has(token)).map(stem).filter((token) => token.length > 2));
}

function tokenSimilarity(a: string, b: string): number {
  const left = normalizedTokens(a); const right = normalizedTokens(b);
  if (!left.size || !right.size) return 0;
  const intersection = [...left].filter((token) => right.has(token)).length;
  return Math.max(intersection / Math.min(left.size, right.size), intersection / (left.size + right.size - intersection));
}

function semanticShape(value: string): Set<string> {
  const text = value.toLowerCase(); const shapes = new Set<string>();
  if (/\b(?:move|shift|transfer|relocat|displac)/.test(text)) shapes.add('TRANSFER');
  if (/\b(?:bottleneck|constraint|limit|capacity|dependency)/.test(text)) shapes.add('CONSTRAINT');
  if (/\b(?:because|cause|due to|driv|lead|result)/.test(text)) shapes.add('CAUSE');
  if (/\b(?:consequence|outcome|impact|therefore|so that|becomes?)/.test(text)) shapes.add('OUTCOME');
  if (/\b(?:but|however|whereas|trade.?off|at the cost|sacrific|slower|faster)/.test(text)) shapes.add('TRADEOFF');
  if (/\b(?:unless|only when|except|depend|condition|provided that)/.test(text)) shapes.add('CONDITION');
  return shapes;
}

function redundantSimilarity(a: string, b: string): number {
  const lexical = tokenSimilarity(a, b); const left = semanticShape(a); const right = semanticShape(b);
  const shared = [...left].filter((shape) => right.has(shape)).length;
  const sameShape = shared >= 2 && shared === Math.min(left.size, right.size);
  return Math.max(lexical, sameShape && lexical >= 0.42 ? 0.78 : 0);
}

function substantive(value: string | null | undefined): value is string {
  return (value?.trim().length ?? 0) >= 12 && normalizedTokens(value ?? '').size >= 3;
}

export type DepthSubstanceUnitType = 'CORE_INSIGHT' | 'OBSERVATION' | 'CAUSAL_MECHANISM' | 'CONSEQUENCE'
  | 'TRADEOFF' | 'DECISION_QUALIFICATION' | 'INTERPRETATION' | 'PERSONAL_PERSPECTIVE'
  | 'EVIDENCE' | 'PROCEDURE_STEP' | 'MULTI_STEP_PROCEDURE';
export type IndependentSubstanceUnit = { signal: string; type: DepthSubstanceUnitType; weight: number };
export type DiscountedDepthSignal = {
  signal: string; redundantWith: string; similarity: number; reason: 'PARAPHRASE' | 'INSUFFICIENT_SUBSTANCE';
};

export type PostDepthClassificationTrace = {
  depthClass: PostDepth; depthScore: number; targetLengthRange: PostTargetLengthRange;
  rawDepthSignals: string[]; independentSubstanceUnits: IndependentSubstanceUnit[];
  discountedRedundantSignals: DiscountedDepthSignal[];
  signalsContributing: {
    observationCount: number; interestPresent: boolean; mechanismPresent: boolean; interpretationPresent: boolean;
    consequencePresent: boolean; qualificationPresent: boolean; personalPerspectivePresent: boolean;
    evidencePresent: boolean; tradeoffPresent: boolean; walkthroughPresent: boolean; compoundClaimPresent: boolean;
  };
};

type Signal = { id: string; text: string; type: DepthSubstanceUnitType; weight: number };

function hasMaterialEvidence(trend: TrendCandidate | null | undefined): boolean {
  if (!trend) return false;
  const strongSource = trend.evidenceRole === 'primary' || trend.evidenceRole === 'strong_secondary'
    || (trend.supportingSources ?? []).some((source) => source.evidenceRole === 'primary' || source.evidenceRole === 'strong_secondary');
  const text = trend.summary?.trim() ?? '';
  return strongSource && substantive(text)
    && /\b(?:\d+(?:\.\d+)?%?|data|study|survey|experiment|measured|observed|found|reported|compared|increase|decrease)\b/i.test(text);
}

const isTradeoff = (value: string) => /\b(?:but|however|whereas|trade.?off|at the cost|sacrific|slower|faster|advantage|disadvantage)\b/i.test(value);
const isDecisionQualification = (value: string) => /\b(?:unless|only when|except|depend|condition|provided that|when|if)\b/i.test(value);
const isProceduralStep = (value: string) => /\b(?:first|second|third|then|next|after|before|finally|step\s*\d+)\b/i.test(value);

/** Classifies distinct reasoning capacity, not populated planner fields. */
export function classifyPostDepthWithTrace(plan: BatchPostPlan, trend?: TrendCandidate | null): PostDepthClassificationTrace {
  const depth = plan.depthPlan;
  const centralClaim = (plan.centralClaim ?? depth?.centralClaim ?? plan.coreClaim ?? plan.sourceTopic ?? '').trim();
  const rawSignals: Signal[] = [];
  const add = (id: string, text: string | null | undefined, type: DepthSubstanceUnitType, weight: number) => {
    if (substantive(text)) rawSignals.push({ id, text: text.trim(), type, weight });
  };

  add('claim', centralClaim, 'CORE_INSIGHT', 1);
  const walkthroughLayout = plan.angle === 'practical_tutorial' || plan.layout === 'technical_walkthrough';
  (depth?.strongestObservations ?? []).slice(0, 5).forEach((observation, index) => add(
    `observation:${index + 1}`, observation,
    walkthroughLayout || isProceduralStep(observation) ? 'PROCEDURE_STEP' : 'OBSERVATION', 1,
  ));
  add('mechanism', depth?.underlyingCauseOrMechanism, 'CAUSAL_MECHANISM', 1.25);
  add('consequence', depth?.meaningfulConsequence, 'CONSEQUENCE', 1);
  const qualification = depth?.usefulTensionOrQualification?.trim() ?? '';
  if (substantive(qualification) && (isTradeoff(qualification) || isDecisionQualification(qualification))) {
    add('qualification', qualification, isTradeoff(qualification) ? 'TRADEOFF' : 'DECISION_QUALIFICATION', 1.25);
  }
  add('interpretation', depth?.deeperInterpretation, 'INTERPRETATION', 1);
  add('interest', depth?.whyThisClaimIsInteresting, 'OBSERVATION', 0.75);
  if (depth?.personalPerspective.supported) add('personalPerspective', depth.personalPerspective.insight, 'PERSONAL_PERSPECTIVE', 1);
  if (hasMaterialEvidence(trend)) add('evidence', trend?.summary, 'EVIDENCE', 1);

  const independent: Signal[] = []; const seenSignals: Signal[] = []; const discounted: DiscountedDepthSignal[] = [];
  for (const signal of rawSignals) {
    const collision = seenSignals.map((unit) => ({ unit, similarity: redundantSimilarity(signal.text, unit.text) }))
      .sort((a, b) => b.similarity - a.similarity)[0];
    if (collision && collision.similarity >= 0.72) {
      discounted.push({ signal: signal.id, redundantWith: collision.unit.id,
        similarity: Number(collision.similarity.toFixed(2)), reason: 'PARAPHRASE' });
    } else independent.push(signal);
    seenSignals.push(signal);
  }

  const independentSteps = independent.filter((unit) => unit.type === 'PROCEDURE_STEP');
  const walkthroughPresent = independentSteps.length >= 3
    && independentSteps.filter((unit) => isProceduralStep(unit.text)).length >= 2;
  const units: IndependentSubstanceUnit[] = independent.map(({ id, type, weight }) => ({ signal: id, type, weight }));
  if (walkthroughPresent) units.push({ signal: 'walkthrough', type: 'MULTI_STEP_PROCEDURE', weight: 1 });

  const score = Number(units.reduce((sum, unit) => sum + unit.weight, 0).toFixed(2));
  const unitTypes = new Set(units.map((unit) => unit.type));
  const depthClass: PostDepth = units.length >= 5 && unitTypes.size >= 3 && score >= 5 ? 'DEEP'
    : units.length >= 3 && score >= 2.75 ? 'STANDARD' : 'COMPACT';
  const hasIndependent = (id: string) => independent.some((unit) => unit.id === id || unit.id.startsWith(`${id}:`));

  return {
    depthClass, depthScore: score, targetLengthRange: { ...POST_DEPTH_TARGETS[depthClass] },
    rawDepthSignals: [...rawSignals.map((signal) => signal.id), ...(walkthroughLayout ? ['walkthrough'] : [])],
    independentSubstanceUnits: units, discountedRedundantSignals: discounted,
    signalsContributing: {
      observationCount: independent.filter((unit) => unit.id.startsWith('observation:')).length,
      interestPresent: hasIndependent('interest'), mechanismPresent: hasIndependent('mechanism'),
      interpretationPresent: hasIndependent('interpretation'), consequencePresent: hasIndependent('consequence'),
      qualificationPresent: hasIndependent('qualification'), personalPerspectivePresent: hasIndependent('personalPerspective'),
      evidencePresent: hasIndependent('evidence'), tradeoffPresent: independent.some((unit) => unit.type === 'TRADEOFF'),
      walkthroughPresent, compoundClaimPresent: false,
    },
  };
}

export function classifyPostDepth(plan: BatchPostPlan, trend?: TrendCandidate | null): PostDepth {
  return classifyPostDepthWithTrace(plan, trend).depthClass;
}

export function withDerivedPostDepth(plan: BatchPostPlan, trend?: TrendCandidate | null): BatchPostPlan {
  const result = classifyPostDepthWithTrace(plan, trend);
  return { ...plan, depthClass: result.depthClass, targetLengthRange: { ...result.targetLengthRange } };
}

export function resolvePostDepthMetadata(plan: BatchPostPlan): {
  depthClass: PostDepth; targetLengthRange: PostTargetLengthRange; minimumCompleteLength: number;
} {
  const depthClass = plan.depthClass ?? classifyPostDepth(plan);
  return { depthClass, targetLengthRange: plan.targetLengthRange ?? POST_DEPTH_TARGETS[depthClass],
    minimumCompleteLength: POST_DEPTH_COMPLETENESS_MINIMUMS[depthClass] };
}
