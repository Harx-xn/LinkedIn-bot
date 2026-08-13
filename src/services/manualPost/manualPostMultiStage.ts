import type { ContentService } from '../contentService';
import type { ContentProvider } from '../manualPostAiService';
import type { AuthorContext, ExpressionMode, PostDepthPlan } from '../generationTypes';
import { ManualPostError } from '../manualPostService';
import { evaluateDeterministicDraftQuality, preservedFactsSurviveRevision } from './manualPostCritic';
import { assembleManualPostBody, normalizeManualHashtags } from './manualPostFormatting';
import { invokeManualDraftPrompt, invokeManualPlanningPrompt, invokeManualTargetedRepairPrompt } from './manualAiProvider';
import { buildManualDraftPrompt, buildManualPlanningPrompt, buildManualTargetedRepairPrompt, EDITORIAL_AUTHORITY } from './manualPostPrompts';
import { createFallbackManualPlan, ManualPlanValidationError, selectManualPlan, selectedPlanToContentPlan } from './manualPostPlanning';
import type { ManualVoiceContext } from './manualVoiceProfileService';
import type { ManualPostFingerprintRecord } from './manualPostFingerprintService';
import type { ManualGeneratedPost, ManualProviderCallBudget, SelectedManualPlan } from './manualPostTypes';
import { evaluateGeneratedPostLength } from '../generatedPostLength';
import { estimatePromptTokens, logGenerationTelemetry } from '../generationTelemetry';

export type ManualGenerationStageInput = {
  topic: string;
  additionalInstructions?: string;
  supportingContext?: string;
  author: AuthorContext;
  voiceContext?: ManualVoiceContext;
  recentFingerprints?: ManualPostFingerprintRecord[];
  recentPosts?: string[];
  expressionMode?: ExpressionMode;
};

export type ManualRepairOutcome = {
  attempted: boolean;
  accepted: boolean;
  rejected: boolean;
  reason: string | null;
  inputLength: number | null;
  outputLength: number | null;
  recoveryAttempted: boolean;
  recoveryAccepted: boolean;
  recoveryInputLength: number | null;
  recoveryOutputLength: number | null;
};

export type ManualGenerationStageResult = {
  post: ManualGeneratedPost;
  providerCalls: number;
  usedQualityRepair: boolean;
  selectedPlan: SelectedManualPlan;
  repairOutcome: ManualRepairOutcome;
  plannerFallbackUsed: boolean;
  plannerValidationFailureReason: string | null;
};

type DepthDimension = { label: string; value: string };

function postLength(post: ManualGeneratedPost): number {
  const body = assembleManualPostBody(post);
  const hashtags = normalizeManualHashtags(post.hashtags, body, post.sourceTopic);
  return `${body}${hashtags ? `\n\n${hashtags}` : ''}`.length;
}

const USAGE_STOP_WORDS = new Set(
  'a an and are as at be because been but by can do does for from has have if in into is it its not of on or that the their them then these they this to was when which while will with without'.split(' '),
);

function compactWords(value: string, ignored: Set<string> = new Set()): string[] {
  return value.toLowerCase().match(/[a-z0-9]+/g)?.filter((word) =>
    word.length > 3 && !USAGE_STOP_WORDS.has(word) && !ignored.has(word)) ?? [];
}

function depthDimensions(plan: PostDepthPlan): DepthDimension[] {
  return [
    ...plan.strongestObservations.map((value, index) => ({ label: `observation ${index + 1}`, value })),
    { label: 'underlying cause or mechanism', value: plan.underlyingCauseOrMechanism ?? '' },
    { label: 'deeper interpretation', value: plan.deeperInterpretation ?? '' },
    { label: 'consequence', value: plan.meaningfulConsequence ?? '' },
    { label: 'useful qualification', value: plan.usefulTensionOrQualification ?? '' },
    { label: 'supported personal perspective', value: plan.personalPerspective.supported ? plan.personalPerspective.insight ?? '' : '' },
    { label: 'ending insight', value: plan.endingInsight ?? '' },
  ].filter((item) => item.value.trim());
}

function isPlanDimensionUsed(draft: ManualGeneratedPost, value: string, topic: string): boolean {
  const ignored = new Set(compactWords(topic));
  const draftWords = new Set(compactWords(assembleManualPostBody(draft), ignored));
  const dimensionWords = compactWords(value, ignored);
  if (dimensionWords.length === 0) return false;
  const shared = dimensionWords.filter((word) => draftWords.has(word)).length;
  return shared >= 2 || shared / dimensionWords.length >= 0.5;
}

export function inspectDepthPlanUsage(
  draft: ManualGeneratedPost,
  plan: PostDepthPlan,
  topic = '',
): { used: DepthDimension[]; unused: DepthDimension[] } {
  const dimensions = depthDimensions(plan);
  return {
    used: dimensions.filter((item) => isPlanDimensionUsed(draft, item.value, topic)),
    unused: dimensions.filter((item) => !isPlanDimensionUsed(draft, item.value, topic)),
  };
}

export function selectMissingDepthDimension(draft: ManualGeneratedPost, plan: PostDepthPlan, topic = ''): string | null {
  const usage = inspectDepthPlanUsage(draft, plan, topic);
  const priorities = ['consequence', 'deeper interpretation', 'underlying cause or mechanism', 'useful qualification', 'ending insight'];
  return priorities.find((label) => usage.unused.some((item) => item.label === label))
    ?? usage.unused[0]?.label
    ?? null;
}

function allowsEnumeration(input: ManualGenerationStageInput): boolean {
  return input.expressionMode === 'walkthrough'
    || /\b(?:listicle|checklist|how-to|how to|ordered steps|bullet list)\b/i.test(input.additionalInstructions ?? '');
}

function normalizeCandidate(candidate: ManualGeneratedPost, draft: ManualGeneratedPost, input: ManualGenerationStageInput, selectedPlan: SelectedManualPlan): ManualGeneratedPost {
  return {
    ...candidate,
    hook: candidate.hook.trim() || draft.hook.trim() || selectedPlan.hook.trim(),
    sourceTopic: draft.sourceTopic || input.topic,
    contentPlan: selectedPlanToContentPlan(selectedPlan),
  };
}

function validateRepairCandidate(input: {
  before: ManualGeneratedPost;
  candidate: ManualGeneratedPost;
  requestedIssues: string[];
  allowEnumeration: boolean;
}): { accepted: boolean; reason: string | null; length: number } {
  const length = postLength(input.candidate);
  if (!preservedFactsSurviveRevision(input.before, input.candidate)) {
    return { accepted: false, reason: 'REPAIR_DROPPED_PRESERVED_FACTS', length };
  }
  if (length < 1600) {
    return { accepted: false, reason: 'REPAIR_DID_NOT_SATISFY_MINIMUM_LENGTH', length };
  }
  if (length > 3000) {
    return { accepted: false, reason: 'REPAIR_EXCEEDED_MAXIMUM_LENGTH', length };
  }

  const repairedQuality = evaluateDeterministicDraftQuality(assembleManualPostBody(input.candidate), {
    allowEnumeration: input.allowEnumeration,
  });
  const requestedQualityIssues = input.requestedIssues.filter((issue) =>
    issue !== 'POST_BELOW_MINIMUM_LENGTH'
    && issue !== 'POST_ABOVE_MAXIMUM_LENGTH'
    && issue !== 'FINAL_MINIMUM_LENGTH_RECOVERY');
  const unresolved = requestedQualityIssues.filter((issue) =>
    issue === 'GENERIC_AI_RISK'
      ? repairedQuality.needsQualityRepair
      : repairedQuality.detectedIssues.includes(issue));
  if (unresolved.length > 0) {
    return { accepted: false, reason: `REPAIR_DID_NOT_RESOLVE_${unresolved.join('_')}`, length };
  }
  if (repairedQuality.needsQualityRepair) {
    return { accepted: false, reason: 'REPAIR_FAILED_REQUIRED_QUALITY_CHECKS', length };
  }
  return { accepted: true, reason: null, length };
}

function estimatePromptContributions(input: ManualGenerationStageInput, selectedPlan: SelectedManualPlan) {
  const voiceSamples = input.voiceContext?.selectedWritingSamples.map((sample) => sample.content).join('\n') ?? '';
  const compactRecentEstimate = (input.recentPosts ?? []).slice(0, 5).map((post) => {
    const lines = post.split('\n').map((line) => line.trim()).filter(Boolean);
    return `${lines[0]?.slice(0, 96) ?? ''}|${lines.at(-1)?.slice(0, 96) ?? ''}`;
  }).join('\n');
  return {
    profile: estimatePromptTokens(JSON.stringify({
      description: input.author.description,
      tone: input.author.tone,
      niches: input.author.niches,
      targetAudience: input.author.targetAudience,
    })),
    voiceSamples: estimatePromptTokens(voiceSamples),
    recentFingerprints: estimatePromptTokens(JSON.stringify(input.recentFingerprints ?? []), compactRecentEstimate),
    topicContext: estimatePromptTokens(input.topic, input.additionalInstructions ?? '', input.supportingContext ?? ''),
    depthPlan: estimatePromptTokens(JSON.stringify(selectedPlan.depthPlan)),
    editorialRules: estimatePromptTokens(EDITORIAL_AUTHORITY),
  };
}

export async function runManualGenerationMultiStage(
  contentService: ContentService,
  input: ManualGenerationStageInput,
  provider: ContentProvider,
  budget: ManualProviderCallBudget = {
    recordProviderCall: () => {},
    totalCalls: () => 0,
    callsByKind: () => ({ plannerCalls: 0, writerCalls: 0, repairCalls: 0 }),
    promptTokensByKind: () => ({ plannerPromptTokens: [], writerPromptTokens: 0, repairPromptTokens: [], totalPromptTokens: 0 }),
  },
): Promise<ManualGenerationStageResult> {
  let selectedPlan: SelectedManualPlan;
  let plannerFallbackUsed = false;
  let plannerValidationFailureReason: string | null = null;
  let firstPlannerValidationFailure: string | null = null;
  const planningPrompt = buildManualPlanningPrompt(input);
  try {
    const planningRaw = await invokeManualPlanningPrompt(contentService, planningPrompt, provider, budget);
    try {
      selectedPlan = selectManualPlan(planningRaw, input.topic, input.supportingContext, input.recentFingerprints ?? []);
    } catch (error) {
      if (!(error instanceof ManualPlanValidationError)) throw error;
      firstPlannerValidationFailure = error.message;
      plannerValidationFailureReason = `attempt 1: ${error.message}`;
      const retryPrompt = buildManualPlanningPrompt({ ...input, planningRetryIssues: error.issues });
      const retried = await invokeManualPlanningPrompt(contentService, retryPrompt, provider, budget);
      selectedPlan = selectManualPlan(retried, input.topic, input.supportingContext, input.recentFingerprints ?? []);
    }
  } catch (error) {
    const finalFailure = error instanceof Error ? error.message : String(error);
    plannerValidationFailureReason = firstPlannerValidationFailure
      ? `attempt 1: ${firstPlannerValidationFailure}; attempt 2: ${finalFailure}`
      : finalFailure;
    plannerFallbackUsed = true;
    console.warn('[manual-post-v2] planning failed after at most one retry; using fallback plan', {
      message: plannerValidationFailureReason,
    });
    selectedPlan = createFallbackManualPlan(input.topic, input.expressionMode, input.author);
  }

  const draftPrompt = buildManualDraftPrompt({ ...input, selectedPlan });
  let draft: ManualGeneratedPost;
  try {
    draft = await invokeManualDraftPrompt(contentService, draftPrompt, provider, budget);
  } catch (error) {
    console.error('[manual-post-v2] draft generation failed', { message: error instanceof Error ? error.message : String(error) });
    throw new ManualPostError(502, 'Failed to generate post content');
  }

  draft = normalizeCandidate(draft, draft, input, selectedPlan);
  const initialLength = postLength(draft);
  const lengthStatus = evaluateGeneratedPostLength('x'.repeat(initialLength));
  const allowEnumeration = allowsEnumeration(input);
  const quality = evaluateDeterministicDraftQuality(assembleManualPostBody(draft), { allowEnumeration });
  const detectedIssues = [...quality.detectedIssues];
  const repairIssues = quality.needsQualityRepair ? [...quality.detectedIssues] : [];
  if (lengthStatus === 'TOO_SHORT') repairIssues.push('POST_BELOW_MINIMUM_LENGTH');
  if (lengthStatus === 'TOO_LONG') repairIssues.push('POST_ABOVE_MAXIMUM_LENGTH');
  if (quality.genericAiRisk > 4 && repairIssues.length === 0) repairIssues.push('GENERIC_AI_RISK');
  if (lengthStatus === 'TOO_SHORT' || lengthStatus === 'TOO_LONG') {
    repairIssues.push(...quality.detectedIssues);
  }
  const uniqueRepairIssues = [...new Set(repairIssues)];
  detectedIssues.push(...uniqueRepairIssues.filter((issue) => !detectedIssues.includes(issue)));

  let finalPost = draft;
  const repairOutcome: ManualRepairOutcome = {
    attempted: false,
    accepted: false,
    rejected: false,
    reason: null,
    inputLength: null,
    outputLength: null,
    recoveryAttempted: false,
    recoveryAccepted: false,
    recoveryInputLength: null,
    recoveryOutputLength: null,
  };
  const usage = inspectDepthPlanUsage(draft, selectedPlan.depthPlan, input.topic);
  const missingPlanDimension = lengthStatus === 'TOO_SHORT'
    ? selectMissingDepthDimension(draft, selectedPlan.depthPlan, input.topic)
    : null;

  if (uniqueRepairIssues.length > 0) {
    repairOutcome.attempted = true;
    repairOutcome.inputLength = initialLength;
    const repairPrompt = buildManualTargetedRepairPrompt({
      topic: input.topic,
      author: input.author,
      voiceContext: input.voiceContext,
      expressionMode: input.expressionMode,
      selectedPlan,
      draft,
      detectedIssues: uniqueRepairIssues,
      missingPlanDimension,
      currentLength: initialLength,
      usedDepthDimensions: usage.used.map((item) => item.label),
      unusedDepthDimensions: usage.unused,
    });
    try {
      const repaired = normalizeCandidate(
        await invokeManualTargetedRepairPrompt(contentService, repairPrompt, provider, budget),
        draft,
        input,
        selectedPlan,
      );
      const validation = validateRepairCandidate({ before: draft, candidate: repaired, requestedIssues: uniqueRepairIssues, allowEnumeration });
      repairOutcome.outputLength = validation.length;
      repairOutcome.accepted = validation.accepted;
      repairOutcome.rejected = !validation.accepted;
      repairOutcome.reason = validation.reason;
      if (validation.accepted) finalPost = repaired;
    } catch (error) {
      repairOutcome.rejected = true;
      repairOutcome.reason = `REPAIR_PROVIDER_FAILURE: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  // One final bounded recovery is allowed only when the original generated
  // candidate was below minimum and the combined repair did not qualify.
  if (lengthStatus === 'TOO_SHORT' && !repairOutcome.accepted) {
    repairOutcome.recoveryAttempted = true;
    repairOutcome.recoveryInputLength = initialLength;
    const recoveryIssues = [...new Set([...uniqueRepairIssues, 'POST_BELOW_MINIMUM_LENGTH', 'FINAL_MINIMUM_LENGTH_RECOVERY'])];
    const recoveryPrompt = buildManualTargetedRepairPrompt({
      topic: input.topic,
      author: input.author,
      voiceContext: input.voiceContext,
      expressionMode: input.expressionMode,
      selectedPlan,
      draft,
      detectedIssues: recoveryIssues,
      missingPlanDimension,
      currentLength: initialLength,
      usedDepthDimensions: usage.used.map((item) => item.label),
      unusedDepthDimensions: usage.unused,
      finalRecovery: true,
    });
    try {
      const recovered = normalizeCandidate(
        await invokeManualTargetedRepairPrompt(contentService, recoveryPrompt, provider, budget),
        draft,
        input,
        selectedPlan,
      );
      const validation = validateRepairCandidate({ before: draft, candidate: recovered, requestedIssues: recoveryIssues, allowEnumeration });
      repairOutcome.recoveryOutputLength = validation.length;
      repairOutcome.recoveryAccepted = validation.accepted;
      if (validation.accepted) {
        finalPost = recovered;
      } else {
        repairOutcome.reason = validation.reason;
      }
    } catch (error) {
      repairOutcome.reason = `RECOVERY_PROVIDER_FAILURE: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const finalLength = postLength(finalPost);
  const finalLengthStatus = evaluateGeneratedPostLength('x'.repeat(finalLength));
  const callCounts = budget.callsByKind();
  const promptTokens = budget.promptTokensByKind();
  logGenerationTelemetry({
    generationType: 'manual_generate',
    expressionMode: input.expressionMode ?? null,
    ...callCounts,
    ...promptTokens,
    promptTokenEstimate: promptTokens.totalPromptTokens,
    promptContributions: estimatePromptContributions(input, selectedPlan),
    initialLength,
    repairInputLength: repairOutcome.inputLength,
    repairOutputLength: repairOutcome.outputLength,
    recoveryInputLength: repairOutcome.recoveryInputLength,
    recoveryOutputLength: repairOutcome.recoveryOutputLength,
    finalLength,
    qualityRiskScore: quality.genericAiRisk,
    detectedIssues: [...new Set(detectedIssues)],
    repairTriggered: repairOutcome.attempted,
    repairAccepted: repairOutcome.accepted,
    repairRejected: repairOutcome.rejected,
    repairRejectionReason: repairOutcome.reason,
    recoveryTriggered: repairOutcome.recoveryAttempted,
    recoveryAccepted: repairOutcome.recoveryAccepted,
    minimumLengthSatisfied: finalLength >= 1600 && finalLength <= 3000,
    plannerFallbackUsed,
    plannerValidationFailureReason,
  });

  if (finalLengthStatus === 'TOO_SHORT' || finalLengthStatus === 'TOO_LONG') {
    throw new ManualPostError(502, 'AI provider could not satisfy the generated post length contract after bounded recovery');
  }

  return {
    post: finalPost,
    providerCalls: budget.totalCalls(),
    usedQualityRepair: repairOutcome.accepted || repairOutcome.recoveryAccepted,
    selectedPlan,
    repairOutcome,
    plannerFallbackUsed,
    plannerValidationFailureReason,
  };
}
