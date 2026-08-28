import { ContentService } from './contentService';
import { GeneratedOutputParseError } from './ghostwriterJsonParser';
import type {
  AuthorContext,
  BatchPostPlan,
  GeneratedPostContent,
  ImageContent,
  QualityIssue,
  SlotAcceptanceDecision,
  TechnicalReviewResult,
  TopicFingerprint,
  TrendCandidate,
} from './generationTypes';
import type { TopicHistoryRow } from './topicHistoryService';
import { finalizeGeneratedPostContent } from './postContentFormatting';
import { normalizeLinkedInLineBody, validateLinkedInFormatting } from './linkedinLineFormatting';
import {
  buildSafeFallbackImageContent,
  detectUnsupportedFirstPersonClaims,
  filterBlockingIssues,
  isHardBlockIssueCode,
  isRepairableEditorialIssueCode,
  isCriticalCandidateIssueCode,
  issuesToRepairInput,
  runDeterministicValidation,
  sanitizeImageContent,
  validateFormattedBody,
  validateImageContent,
} from './ghostwriterValidationService';
import { normalizeHashtags } from './postContentFormatting';
import type { GhostwriterBotConfig } from './ghostwriterPipeline';
import { estimatePromptTokens, logGenerationTelemetry } from './generationTelemetry';
import { evaluateGeneratedPostLength } from './generatedPostLength';
import { resolvePostDepthMetadata } from './postDepth';
import {
  SlotCandidatePool,
  type CandidateObservation,
  type RankedSlotCandidate,
  type SlotCandidateOrigin,
} from './ghostwriterCandidateSelection';
import {
  FALLBACK_PROVENANCE,
  logFallbackProvenance,
  type FallbackProvenance,
} from './fallbackProvenanceService';
import {
  IDEA_EXHAUSTION_FRESH_GENERATIONS,
  IdeaFailureTracker,
  type IdeaFailureState,
} from './ideaRecoveryService';
import { diagnosticTraceId, type BatchGenerationTraceRecorder } from './batchGenerationTraceService';

export const MAX_FRESH_GENERATIONS = 3;
export const MAX_TARGETED_REPAIRS_PER_GENERATION = 2;
export const MAX_QUOTA_FILL_ROUNDS = 2;
export const MAX_SLOT_WRITER_OPERATIONS = 9;
export const MAX_SLOT_IDEA_ATTEMPTS = 2;

export type GeneratedSlotResult =
  | {
      ok: true;
      finalized: ReturnType<typeof finalizeGeneratedPostContent>;
      imageContent: ImageContent | null;
      sourceTitle: string;
      plan: BatchPostPlan;
      qualityScore: number;
      attempts: number;
      acceptance: SlotAcceptanceDecision;
      fallbackProvenance?: FallbackProvenance[];
      ideaFailureState?: IdeaFailureState;
      freshGenerationsUsed?: number;
      writerOperationsUsed?: number;
      finalIdeaUsed?: string;
      ideaAttemptIndex?: number;
    }
  | {
      ok: false;
      reason: string;
      sourceTitle?: string;
      acceptance?: SlotAcceptanceDecision;
      ideaFailureState?: IdeaFailureState;
      freshGenerationsUsed?: number;
      writerOperationsUsed?: number;
      finalIdeaUsed?: string;
      ideaAttemptIndex?: number;
    };

export type SlotIdeaAttempt = {
  candidateId: string;
  plan: BatchPostPlan;
  trend: TrendCandidate | null;
  origin?: string;
};

export type SlotIdeaRecoveryResult = {
  result: Extract<GeneratedSlotResult, { ok: true }>;
  finalIdea: SlotIdeaAttempt;
  attemptedCandidateIds: string[];
};

type AttemptCounters = {
  freshGenerationAttempt: number;
  contentRepairAttempt: number;
  jsonRepairAttempt: number;
  provider: 'OPENAI' | 'GEMINI';
};

export type SlotGenerationOptions = {
  batchFingerprints?: TopicFingerprint[];
  recentTopicHistory?: TopicHistoryRow[];
  recentPosts?: string[];
  candidatePool?: SlotCandidatePool;
  retainedCollisionCandidate?: Extract<GeneratedSlotResult, { ok: true }>;
  originOverride?: SlotCandidateOrigin;
  ideaCandidateId?: string;
  ideaAttemptIndex?: number;
  ideaFailureTracker?: IdeaFailureTracker;
  freshGenerationLimit?: number;
  freshGenerationOffset?: number;
  stopWhenIdeaExhausted?: boolean;
  deferBestUsableReturn?: boolean;
  writerOperationLimit?: number;
  traceRecorder?: BatchGenerationTraceRecorder;
  slotTraceId?: string;
};

function diagnosticDraftOrigin(origin: SlotCandidateOrigin): string {
  if (origin === 'initial_draft') return 'INITIAL';
  if (origin === 'targeted_repair' || origin === 'specificity_expansion') return 'REPAIR';
  if (origin === 'fresh_regeneration' || origin === 'collision_regeneration') return 'FRESH_REGENERATION';
  if (origin === 'late_retry') return 'LATE_RETRY';
  if (origin === 'emergency_fallback') return 'DETERMINISTIC_FALLBACK';
  return origin.toUpperCase();
}

function recordDraftTrace(
  options: SlotGenerationOptions | undefined,
  candidate: RankedSlotCandidate,
  flags: { becameBestCandidate?: boolean; acceptedNormally?: boolean; returnedAsFallback?: boolean } = {},
): void {
  if (!options?.traceRecorder || !options.slotTraceId) return;
  const candidateTraceId = candidate.ideaCandidateId ?? options.ideaCandidateId ?? 'unknown-candidate';
  const ideaAttemptIndex = candidate.ideaAttemptIndex ?? options.ideaAttemptIndex ?? 0;
  const fresh = candidate.freshGenerationAttempt ?? 0;
  const repair = candidate.contentRepairAttempt ?? 0;
  const draftAttemptKey = candidate.freshGenerationAttempt == null ? candidate.origin : fresh;
  options.traceRecorder.recordDraft({
    draftAttemptId: diagnosticTraceId('draft', options.slotTraceId, candidateTraceId, ideaAttemptIndex, draftAttemptKey, repair),
    slotTraceId: options.slotTraceId,
    candidateTraceId,
    ideaAttemptId: diagnosticTraceId('idea', options.slotTraceId, candidateTraceId, ideaAttemptIndex),
    ideaAttemptIndex,
    origin: diagnosticDraftOrigin(candidate.origin),
    charLength: candidate.finalized.content.length,
    deterministicScore: candidate.acceptance.deterministicScore,
    specificityScore: candidate.acceptance.specificityScore,
    reviewerPassed: candidate.technicalReview.available !== false && candidate.technicalReview.passed,
    claimFidelity: candidate.technicalReview.claimFidelity ?? null,
    informationDensity: candidate.technicalReview.informationDensity ?? null,
    progressionQuality: candidate.technicalReview.progressionQuality ?? null,
    redundancyRisk: candidate.technicalReview.redundancyRisk ?? null,
    genericDiscourseRisk: candidate.technicalReview.genericDiscourseRisk ?? null,
    issueCodes: candidate.issues.map((issue) => issue.code),
    effectiveBlockingCodes: candidate.acceptance.blockingIssueCodes,
    reviewerStatus: candidate.acceptance.reviewerStatus ?? (candidate.technicalReview.available === false ? 'REVIEWER_UNAVAILABLE' : candidate.technicalReview.passed ? 'REVIEWER_PASSED' : 'REVIEWER_FAILED'),
    candidateTier: candidate.tier,
    becameBestCandidate: flags.becameBestCandidate ?? false,
    acceptedNormally: flags.acceptedNormally ?? false,
    returnedAsFallback: flags.returnedAsFallback ?? false,
  });
}

export function mergeQualityIssues(...groups: QualityIssue[][]): QualityIssue[] {
  const merged = new Map<string, QualityIssue>();
  for (const group of groups) {
    for (const issue of group) {
      const existing = merged.get(issue.code);
      if (!existing) {
        merged.set(issue.code, { ...issue, evidence: issue.evidence ? [...issue.evidence] : undefined });
        continue;
      }
      const evidence = [...new Set([...(existing.evidence ?? []), ...(issue.evidence ?? [])])];
      merged.set(issue.code, {
        code: issue.code,
        severity: existing.severity === 'error' || issue.severity === 'error' ? 'error' : 'warning',
        evidence: evidence.length ? evidence : undefined,
        instruction: (issue.instruction?.trim().length ?? 0) > (existing.instruction?.trim().length ?? 0)
          ? issue.instruction
          : existing.instruction,
      });
    }
  }
  return [...merged.values()];
}

function technicalToQuality(issues: TechnicalReviewResult['issues']): QualityIssue[] {
  return issues.map((i) => ({
    code: i.code,
    severity: i.severity,
    evidence: [i.excerpt],
    instruction: i.repairInstruction,
  }));
}

function isSpecificityOnlyBlocking(blocking: QualityIssue[]): boolean {
  return blocking.length > 0 && blocking.every((i) => i.code === 'insufficient_specificity');
}

export function buildAcceptanceDecision(params: {
  deterministic: ReturnType<typeof runDeterministicValidation>;
  technicalReview: TechnicalReviewResult;
  blocking: QualityIssue[];
  warnings: QualityIssue[];
  repairAttempts?: number;
}): SlotAcceptanceDecision {
  const reviewAvailable = params.technicalReview.available !== false;
  const deterministicErrors = params.deterministic.issues.filter((issue) => issue.severity === 'error');
  const reviewerCritical = params.technicalReview.issues.some((issue) => issue.severity === 'error' && isHardBlockIssueCode(issue.code));
  const reviewerStatus: SlotAcceptanceDecision['reviewerStatus'] = reviewAvailable
    ? params.technicalReview.passed ? 'REVIEWER_PASSED' : reviewerCritical ? 'REVIEWER_CRITICAL_FAIL' : 'REVIEWER_QUALITY_FAIL'
    : deterministicErrors.length === 0 ? 'REVIEWER_NOT_REQUIRED_SAFE_PATH' : 'REVIEWER_UNAVAILABLE';
  const semanticQuality = reviewAvailable
    ? Math.round((
      (params.technicalReview.informationDensity ?? 100)
      + (params.technicalReview.progressionQuality ?? 100)
      + (100 - (params.technicalReview.redundancyRisk ?? 0))
      + (100 - (params.technicalReview.genericDiscourseRisk ?? 0))
      + (params.technicalReview.claimFidelity ?? 100)
    ) / 5)
    : params.deterministic.deterministicScore;
  const onlyEditorialBlocking = params.blocking.length > 0
    && params.blocking.every((issue) => isRepairableEditorialIssueCode(issue.code));
  const strongEditorialTolerance = (params.repairAttempts ?? 0) >= 1
    && params.deterministic.deterministicScore >= 80
    && (params.deterministic.specificity?.score ?? 0) >= 65
    && onlyEditorialBlocking
    && reviewerStatus !== 'REVIEWER_CRITICAL_FAIL';
  const reviewerAllowsAcceptance = reviewerStatus === 'REVIEWER_PASSED'
    || reviewerStatus === 'REVIEWER_NOT_REQUIRED_SAFE_PATH'
    || (reviewerStatus === 'REVIEWER_QUALITY_FAIL' && (params.repairAttempts ?? 0) >= 1);
  return {
    accepted: (params.blocking.length === 0 && reviewerAllowsAcceptance) || strongEditorialTolerance,
    deterministicScore: params.deterministic.deterministicScore,
    specificityScore: params.deterministic.specificity?.score ?? 0,
    qualityScore: Math.min(params.deterministic.deterministicScore, semanticQuality),
    technicalPassed: reviewAvailable && params.technicalReview.passed,
    reviewerStatus,
    acceptanceMode: strongEditorialTolerance ? 'EDITORIAL_TOLERANCE' : 'NORMAL',
    blockingIssueCodes: params.blocking.map((i) => i.code),
    warningIssueCodes: params.warnings.map((i) => i.code),
  };
}

const REVIEWABLE_DETERMINISTIC_CODES = new Set([
  'generated_post_too_short',
  'generated_post_too_long',
  'insufficient_specificity',
  'SEMANTIC_REPETITION',
  'ARGUMENT_STAGNATION',
  'ENUMERATION_WITHOUT_INTERPRETATION',
  'CONCLUSION_RESTATES_THESIS',
  'FORCED_NICHE_PARAGRAPH',
  'GENERIC_RECOMMENDATION_ENDING',
  'GENERIC_SCENARIO_STRUCTURE',
  'GENERIC_CHECKLIST_EXPANSION',
  'GENERIC_ENGAGEMENT_ENDING',
  'generic_ending',
]);

/** Semantic review remains reachable for repairable quality issues, but not unsafe or unusable drafts. */
export function shouldRunTechnicalReview(
  deterministic: ReturnType<typeof runDeterministicValidation>,
): boolean {
  const errors = deterministic.issues.filter((issue) => issue.severity === 'error');
  return errors.length === 0 || errors.every((issue) => REVIEWABLE_DETERMINISTIC_CODES.has(issue.code));
}

async function runTechnicalReview(
  contentService: ContentService,
  generated: GeneratedPostContent,
  author: AuthorContext,
  plan: BatchPostPlan,
  provider: 'OPENAI' | 'GEMINI',
): Promise<TechnicalReviewResult> {
  return contentService.reviewTechnicalClaims(generated, author, plan, provider);
}

async function resolveImageContent(
  contentService: ContentService,
  finalized: ReturnType<typeof finalizeGeneratedPostContent>,
  plan: BatchPostPlan,
  provider: 'OPENAI' | 'GEMINI',
): Promise<{ imageContent: ImageContent | null; issues: QualityIssue[] }> {
  const approved: GeneratedPostContent = {
    headline: finalized.headline,
    subheadline: finalized.subheadline,
    bulletPoints: finalized.bulletPoints,
    body: finalized.body,
    hashtags: finalized.hashtags,
  };

  let imageContent = await contentService.generateImageCopy(finalized.body, plan, provider);
  if (!imageContent) {
    return { imageContent: buildSafeFallbackImageContent(finalized), issues: [{ code: 'image_generation_failed', severity: 'warning' }] };
  }

  imageContent = sanitizeImageContent(imageContent);
  let validation = validateImageContent(imageContent, approved);
  if (!validation.passed) {
    const repaired = await contentService.repairImageCopy(finalized.body, imageContent, validation.issues, provider);
    if (repaired) {
      imageContent = sanitizeImageContent(repaired);
      validation = validateImageContent(imageContent, approved);
    }
  }

  if (!validation.passed || imageContent.mode === 'none') {
    const fallback = buildSafeFallbackImageContent(finalized);
    return { imageContent: fallback.mode === 'none' ? null : fallback, issues: validation.issues };
  }

  return { imageContent, issues: [] };
}

function slotAttemptIndex(counters: AttemptCounters): number {
  return (counters.freshGenerationAttempt - 1) * (MAX_TARGETED_REPAIRS_PER_GENERATION + 1)
    + counters.contentRepairAttempt
    + 1;
}

function applyLinkedInFormatting(
  generated: GeneratedPostContent,
  sourceTitle?: string,
): GeneratedPostContent {
  const body = normalizeLinkedInLineBody(generated.body);
  return {
    ...generated,
    body,
    hashtags: normalizeHashtags(generated.hashtags, body, sourceTitle),
  };
}

/**
 * Last bounded recovery when every writer/provider attempt failed before a safe
 * candidate existed. It uses only the selected claim and existing plan reasoning,
 * then runs the same hard deterministic, authority, formatting and platform gates.
 */
export async function buildBoundedSafeWriterFallback(params: {
  contentService: ContentService;
  provider?: 'OPENAI' | 'GEMINI';
  plan: BatchPostPlan;
  trend: TrendCandidate | null;
  author: AuthorContext;
  config: GhostwriterBotConfig;
  acceptedBodies: string[];
  batchFingerprints?: TopicFingerprint[];
  recentTopicHistory?: TopicHistoryRow[];
  candidatePool?: SlotCandidatePool;
  traceOptions?: SlotGenerationOptions;
}): Promise<Extract<GeneratedSlotResult, { ok: true }> | null> {
  const sourceTitle = params.trend?.topic ?? params.plan.sourceTopic ?? 'Author expertise';
  const claim = (
    params.plan.centralClaim
    ?? params.plan.selectedCentralClaim
    ?? params.plan.depthPlan?.centralClaim
    ?? params.trend?.fingerprint?.coreClaim
    ?? params.trend?.topic
    ?? params.plan.sourceTopic
    ?? ''
  ).replace(/\s+/g, ' ').trim();
  if (!claim) return null;
  const fallbackPlan: BatchPostPlan = {
    ...params.plan,
    centralClaim: claim,
    selectedCentralClaim: claim,
    editorialDecision: undefined,
    depthClass: 'STANDARD',
    targetLengthRange: { min: 1600, max: 1800 },
  };
  let generated: GeneratedPostContent;
  try {
    generated = applyLinkedInFormatting(await params.contentService.generatePlannedPost(
      fallbackPlan,
      params.author,
      params.trend?.link ?? '',
      params.provider ?? 'OPENAI',
      params.trend,
      [],
    ), sourceTitle);
  } catch (error) {
    console.error('[ghostwriter] bounded safe writer failed', { message: error instanceof Error ? error.message : String(error) });
    return null;
  }
  const deterministic = runDeterministicValidation(generated, params.author, fallbackPlan, params.acceptedBodies, {
    sourceTitle,
    batchFingerprints: params.batchFingerprints,
    history: params.recentTopicHistory,
    enforceLength: true,
  });
  const finalized = finalizeGeneratedPostContent(generated, sourceTitle, {
    topic: sourceTitle,
    includeContactInfo: !!params.config.includeContactInfo,
    includeWebsiteLink: !!params.config.includeWebsiteLink,
    contactInfo: params.config.contactInfo,
    websiteUrl: params.config.websiteUrl,
    description: params.config.description,
  });
  const formatIssues = validateFormattedBody(finalized.body, finalized.hashtags, params.author.description, {
    includeContactInfo: !!params.config.includeContactInfo,
    includeWebsiteLink: !!params.config.includeWebsiteLink,
  }).filter((issue) => issue.severity === 'error');
  const authorityIssues: QualityIssue[] = detectUnsupportedFirstPersonClaims(finalized.body, params.author.description).length
    ? [{ code: 'unsupported_first_person_after_format', severity: 'error' }]
    : [];
  const linkedInIssues: QualityIssue[] = validateLinkedInFormatting(finalized.body)
    .filter((issue) => issue.severity === 'error')
    .map((issue) => ({ code: issue.code, severity: 'error' as const }));
  const issues = mergeQualityIssues(deterministic.issues, formatIssues, authorityIssues, linkedInIssues);
  if (finalized.content.length < 1400 || finalized.content.length > 3000) return null;
  if (issues.some((issue) => isHardBlockIssueCode(issue.code))) return null;
  const blocking = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity === 'warning');
  const technicalReview: TechnicalReviewResult = { available: false, passed: false, confidence: 0, issues: [] };
  const acceptance = buildAcceptanceDecision({ deterministic, technicalReview, blocking, warnings });
  const pool = params.candidatePool ?? new SlotCandidatePool();
  const ranked = pool.add({
    origin: 'emergency_fallback', generated, finalized, acceptance, technicalReview, issues, plan: fallbackPlan,
    ideaCandidateId: params.traceOptions?.ideaCandidateId,
    ideaAttemptIndex: params.traceOptions?.ideaAttemptIndex,
  });
  if (!ranked.eligible) return null;
  recordDraftTrace(params.traceOptions, ranked, { becameBestCandidate: pool.best() === ranked, returnedAsFallback: true });
  logFallbackProvenance({ provenance: FALLBACK_PROVENANCE.WRITER_FALLBACK, stage: 'bounded_safe_writer', reason: 'writer_attempts_exhausted' });
  logFallbackProvenance({ provenance: FALLBACK_PROVENANCE.SAFE_FALLBACK_ACCEPTANCE, stage: 'bounded_safe_writer', metadata: { tier: ranked.tier } });
  return {
    ok: true,
    finalized,
    imageContent: buildSafeFallbackImageContent(finalized),
    sourceTitle,
    plan: fallbackPlan,
    qualityScore: acceptance.qualityScore,
    attempts: MAX_FRESH_GENERATIONS * MAX_QUOTA_FILL_ROUNDS + 1,
    acceptance,
    fallbackProvenance: [FALLBACK_PROVENANCE.WRITER_FALLBACK, FALLBACK_PROVENANCE.SAFE_FALLBACK_ACCEPTANCE],
  };
}

function logSlotDecision(
  sourceTitle: string,
  plan: BatchPostPlan,
  counters: AttemptCounters,
  acceptance: SlotAcceptanceDecision,
  extra?: { imageValidationIssues?: string[] },
  slotOptions?: SlotGenerationOptions,
) {
  console.log('[ghostwriter] slot validation', {
    batchTraceId: slotOptions?.traceRecorder?.batchTraceId,
    slotTraceId: slotOptions?.slotTraceId,
    candidateTraceId: slotOptions?.ideaCandidateId,
    ideaAttemptId: slotOptions?.slotTraceId
      ? diagnosticTraceId('idea', slotOptions.slotTraceId, slotOptions.ideaCandidateId ?? 'unknown', slotOptions.ideaAttemptIndex ?? 0)
      : undefined,
    draftAttemptId: slotOptions?.slotTraceId
      ? diagnosticTraceId('draft', slotOptions.slotTraceId, slotOptions.ideaCandidateId ?? 'unknown', slotOptions.ideaAttemptIndex ?? 0, counters.freshGenerationAttempt, counters.contentRepairAttempt)
      : undefined,
    sourceTitle: sourceTitle.slice(0, 60),
    planAngle: plan.angle,
    freshGenerationAttempt: counters.freshGenerationAttempt,
    contentRepairAttempt: counters.contentRepairAttempt,
    jsonRepairAttempt: counters.jsonRepairAttempt,
    provider: counters.provider,
    deterministicScore: acceptance.deterministicScore,
    specificityScore: acceptance.specificityScore,
    qualityScore: acceptance.qualityScore,
    technicalPassed: acceptance.technicalPassed,
    blockingIssueCodes: acceptance.blockingIssueCodes,
    warningIssueCodes: acceptance.warningIssueCodes,
    imageValidationIssues: extra?.imageValidationIssues ?? [],
  });
}

type TryAcceptOutcome =
  | { accepted: true; result: Extract<GeneratedSlotResult, { ok: true }>; observation: Omit<CandidateObservation, 'origin'> }
  | {
      accepted: false;
      acceptance: SlotAcceptanceDecision;
      deterministic: ReturnType<typeof runDeterministicValidation>;
      technicalReview: TechnicalReviewResult;
      issues: QualityIssue[];
      observation: Omit<CandidateObservation, 'origin'>;
    };

async function tryAcceptPost(
  contentService: ContentService,
  generated: GeneratedPostContent,
  sourceTitle: string,
  plan: BatchPostPlan,
  author: AuthorContext,
  config: GhostwriterBotConfig,
  acceptedBodies: string[],
  provider: 'OPENAI' | 'GEMINI',
  counters: AttemptCounters,
  slotOptions?: SlotGenerationOptions,
): Promise<TryAcceptOutcome> {
  const deterministic = runDeterministicValidation(generated, author, plan, acceptedBodies, {
    sourceTitle,
    batchFingerprints: slotOptions?.batchFingerprints,
    history: slotOptions?.recentTopicHistory,
    enforceLength: true,
  });
  let technicalReview: TechnicalReviewResult = { available: false, passed: false, confidence: 0, issues: [] };
  if (shouldRunTechnicalReview(deterministic)) {
    technicalReview = await runTechnicalReview(contentService, generated, author, plan, provider);
  }

  const finalized = finalizeGeneratedPostContent(generated, sourceTitle, {
    topic: sourceTitle,
    includeContactInfo: !!config.includeContactInfo,
    includeWebsiteLink: !!config.includeWebsiteLink,
    contactInfo: config.contactInfo,
    websiteUrl: config.websiteUrl,
    description: config.description,
   
  });

  const formatIssues = validateFormattedBody(finalized.body, finalized.hashtags, author.description, {
    includeContactInfo: !!config.includeContactInfo,
    includeWebsiteLink: !!config.includeWebsiteLink,
  }).filter((i) => i.severity === 'error');
  const authorityIssues: QualityIssue[] = detectUnsupportedFirstPersonClaims(finalized.body, author.description).length
    ? [{ code: 'unsupported_first_person_after_format', severity: 'error' }]
    : [];
  const linkedInIssues = validateLinkedInFormatting(finalized.body)
    .filter((issue) => issue.severity === 'error')
    .map((issue) => ({ code: issue.code, severity: 'error' as const }));
  const allIssues = mergeQualityIssues(
    deterministic.issues,
    technicalToQuality(technicalReview.issues),
    formatIssues,
    authorityIssues,
    linkedInIssues,
  ).map((issue) => isCriticalCandidateIssueCode(issue.code) && issue.severity !== 'error'
    ? { ...issue, severity: 'error' as const }
    : issue);
  const blocking = filterBlockingIssues(allIssues, slotAttemptIndex(counters));
  const warnings = allIssues.filter((i) => i.severity === 'warning');
  const acceptance = buildAcceptanceDecision({ deterministic, technicalReview, blocking, warnings, repairAttempts: counters.contentRepairAttempt });
  const observation = {
    generated,
    finalized,
    acceptance,
    technicalReview,
    issues: allIssues,
    plan,
    ideaCandidateId: slotOptions?.ideaCandidateId,
    ideaAttemptIndex: slotOptions?.ideaAttemptIndex,
    freshGenerationAttempt: counters.freshGenerationAttempt,
    contentRepairAttempt: counters.contentRepairAttempt,
  };

  if (!acceptance.accepted || blocking.some((issue) => isHardBlockIssueCode(issue.code)) || formatIssues.length || authorityIssues.length) {
    logSlotDecision(sourceTitle, plan, counters, acceptance, undefined, slotOptions);
    return { accepted: false, acceptance, deterministic, technicalReview, issues: allIssues, observation };
  }

  if (linkedInIssues.length) {
    logSlotDecision(sourceTitle, plan, counters, acceptance, undefined, slotOptions);
    return { accepted: false, acceptance, deterministic, technicalReview, issues: allIssues, observation };
  }

  const { imageContent, issues: imageIssues } = config.imageMode === 'providedBackground'
    ? await resolveImageContent(contentService, finalized, plan, provider)
    : { imageContent: null, issues: [] };
  logSlotDecision(sourceTitle, plan, counters, acceptance, { imageValidationIssues: imageIssues.map((i) => i.code) }, slotOptions);

  return {
    accepted: true,
    observation,
    result: {
      ok: true,
      finalized,
      imageContent,
      sourceTitle,
      plan,
      qualityScore: acceptance.qualityScore,
      attempts: counters.freshGenerationAttempt,
      acceptance,
    },
  };
}

export async function generateSlotPost(
  contentService: ContentService,
  plan: BatchPostPlan,
  trend: TrendCandidate | null,
  author: AuthorContext,
  config: GhostwriterBotConfig,
  acceptedBodies: string[],
  provider: 'OPENAI' | 'GEMINI' = 'OPENAI',
  slotOptions?: SlotGenerationOptions,
): Promise<GeneratedSlotResult> {
  const sourceTitle = trend?.topic ?? plan.sourceTopic ?? 'Author expertise';
  const sourceLink = trend?.link ?? '';
  const candidatePool = slotOptions?.candidatePool ?? new SlotCandidatePool();
  const freshGenerationLimit = Math.max(1, Math.min(
    MAX_FRESH_GENERATIONS,
    slotOptions?.freshGenerationLimit ?? MAX_FRESH_GENERATIONS,
  ));
  const freshGenerationOffset = Math.max(0, slotOptions?.freshGenerationOffset ?? 0);
  const ideaCandidateId = slotOptions?.ideaCandidateId ?? 'untracked-idea';
  const ideaFailureTracker = slotOptions?.ideaFailureTracker ?? new IdeaFailureTracker(ideaCandidateId);
  let ideaFailureState = ideaFailureTracker.state();
  let freshGenerationsUsed = 0;
  let writerOperationsUsed = 0;
  let lastAcceptance: SlotAcceptanceDecision | undefined;
  let initialLength = 0;

  if (slotOptions?.retainedCollisionCandidate) {
    const retained = slotOptions.retainedCollisionCandidate;
    const retainedCandidate = candidatePool.add({
      origin: 'collision_prior',
      generated: {
        headline: retained.finalized.headline,
        subheadline: retained.finalized.subheadline,
        bulletPoints: retained.finalized.bulletPoints,
        body: retained.finalized.body,
        hashtags: retained.finalized.hashtags,
      },
      finalized: retained.finalized,
      acceptance: retained.acceptance,
      technicalReview: { available: false, passed: false, confidence: 0, issues: [] },
      issues: [{ code: 'batch_similarity', severity: 'error' }],
      plan,
      ideaCandidateId,
      ideaAttemptIndex: slotOptions?.ideaAttemptIndex,
    });
    recordDraftTrace(slotOptions, retainedCandidate, { becameBestCandidate: candidatePool.best() === retainedCandidate });
  }

  generationLoop: for (let fresh = 1; fresh <= freshGenerationLimit; fresh++) {
    if (writerOperationsUsed >= (slotOptions?.writerOperationLimit ?? MAX_SLOT_WRITER_OPERATIONS)) break;
    freshGenerationsUsed = fresh;
    const globalFreshAttempt = freshGenerationOffset + fresh;
    const counters: AttemptCounters = {
      freshGenerationAttempt: globalFreshAttempt,
      contentRepairAttempt: 0,
      jsonRepairAttempt: 0,
      provider,
    };

    let generated: GeneratedPostContent;
    try {
      writerOperationsUsed += 1;
      generated = applyLinkedInFormatting(
        await contentService.generatePlannedPost(plan, author, sourceLink, provider, trend, slotOptions?.recentPosts ?? []),
        sourceTitle,
      );
    } catch (err) {
      if (err instanceof GeneratedOutputParseError) counters.jsonRepairAttempt = 2;
      console.error('[ghostwriter] generation failed', {
        sourceTitle: sourceTitle.slice(0, 60),
        freshGenerationAttempt: globalFreshAttempt,
        stage: err instanceof GeneratedOutputParseError ? err.stage : undefined,
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (initialLength === 0) {
      initialLength = finalizeGeneratedPostContent(generated, sourceTitle, {
        topic: sourceTitle,
        includeContactInfo: !!config.includeContactInfo,
        includeWebsiteLink: !!config.includeWebsiteLink,
        contactInfo: config.contactInfo,
        websiteUrl: config.websiteUrl,
        description: config.description,
      }).content.length;
    }

    let currentOrigin: SlotCandidateOrigin = slotOptions?.originOverride
      ?? (globalFreshAttempt === 1 ? 'initial_draft' : 'fresh_regeneration');

    for (let repairRound = 0; repairRound <= MAX_TARGETED_REPAIRS_PER_GENERATION; repairRound++) {
      const attempt = await tryAcceptPost(
        contentService,
        generated,
        sourceTitle,
        plan,
        author,
        config,
        acceptedBodies,
        provider,
        { ...counters, contentRepairAttempt: repairRound },
        slotOptions,
      );
      const observedOrigin = slotAttemptIndex({ ...counters, contentRepairAttempt: repairRound }) >= 7
        ? 'late_retry'
        : currentOrigin;
      const rankedCandidate = candidatePool.add({ ...attempt.observation, origin: observedOrigin });
      const becameBestCandidate = candidatePool.best() === rankedCandidate;
      recordDraftTrace(slotOptions, rankedCandidate, {
        becameBestCandidate,
        acceptedNormally: attempt.accepted && becameBestCandidate,
      });
      lastAcceptance = attempt.accepted ? attempt.result.acceptance : attempt.acceptance;
      ideaFailureState = ideaFailureTracker.recordAttempt({
        kind: repairRound === 0 ? 'fresh' : 'repair',
        issues: attempt.observation.issues,
        bestTier: candidatePool.bestForIdea(ideaCandidateId)?.tier,
      });
      if (repairRound === 0 && slotOptions?.ideaCandidateId) {
        console.info('[idea-recovery] idea evidence updated', {
          batchTraceId: slotOptions?.traceRecorder?.batchTraceId,
          slotTraceId: slotOptions?.slotTraceId,
          ideaAttemptId: diagnosticTraceId('idea', slotOptions.slotTraceId ?? 'untracked-slot', slotOptions.ideaCandidateId, slotOptions.ideaAttemptIndex ?? 0),
          initialIdea: slotOptions.ideaCandidateId,
          ideaAttemptIndex: slotOptions.ideaAttemptIndex ?? 0,
          freshGenerationCount: ideaFailureState.independentGenerationCount,
          recurringFailureCodes: [
            ...ideaFailureState.recurringBlockingCodes,
            ...ideaFailureState.recurringWarningCodes,
          ],
          ideaExhausted: ideaFailureState.exhausted,
          exhaustionReason: ideaFailureState.exhaustionReason,
        });
      }
      if (attempt.accepted) {
        console.log('[ghostwriter] post accepted', {
          batchTraceId: slotOptions?.traceRecorder?.batchTraceId,
          slotTraceId: slotOptions?.slotTraceId,
          sourceTitle: sourceTitle.slice(0, 60), angle: plan.angle, expressionMode: plan.expressionMode, freshGenerationAttempt: globalFreshAttempt, provider,
        });
        const writerPromptEstimate = estimatePromptTokens(JSON.stringify({ plan, author: { description: author.description, tone: author.tone, niches: author.niches }, recent: slotOptions?.recentPosts?.slice(0, 5).map((post) => post.slice(0, 96)) ?? [] }));
        logGenerationTelemetry({
          generationType: 'ghostwriter_batch_slot',
          expressionMode: plan.expressionMode ?? null,
          plannerCalls: 0,
          writerCalls: globalFreshAttempt,
          repairCalls: repairRound,
          plannerPromptTokens: [],
          writerPromptTokens: writerPromptEstimate,
          repairPromptTokens: [],
          totalPromptTokens: writerPromptEstimate,
          promptTokenEstimate: writerPromptEstimate,
          initialLength,
          repairInputLength: repairRound > 0 ? initialLength : null,
          repairOutputLength: repairRound > 0 ? attempt.result.finalized.content.length : null,
          finalLength: attempt.result.finalized.content.length,
          qualityRiskScore: Math.max(0, 100 - attempt.result.acceptance.qualityScore),
          detectedIssues: attempt.result.acceptance.warningIssueCodes,
          repairTriggered: repairRound > 0,
          repairAccepted: repairRound > 0,
          repairRejected: false,
          minimumLengthSatisfied: (() => {
            const depth = resolvePostDepthMetadata(plan);
            return !['TOO_SHORT', 'TOO_LONG'].includes(evaluateGeneratedPostLength(
              attempt.result.finalized.content,
              depth.targetLengthRange,
              depth.minimumCompleteLength,
            ));
          })(),
          plannerFallbackUsed: false,
          plannerValidationFailureReason: null,
          ...candidatePool.summary(),
        });
        const best = candidatePool.best();
        if (!best || best === rankedCandidate) return {
          ...attempt.result,
          fallbackProvenance: [attempt.result.acceptance.acceptanceMode === 'EDITORIAL_TOLERANCE'
            ? FALLBACK_PROVENANCE.EDITORIAL_TOLERANCE_ACCEPTANCE
            : repairRound > 0
              ? FALLBACK_PROVENANCE.REPAIRED_ACCEPTANCE
            : globalFreshAttempt > 1
              ? FALLBACK_PROVENANCE.REGENERATED_ACCEPTANCE
              : FALLBACK_PROVENANCE.NORMAL_ACCEPTANCE],
          ideaFailureState,
          freshGenerationsUsed,
          writerOperationsUsed,
          finalIdeaUsed: ideaCandidateId,
          ideaAttemptIndex: slotOptions?.ideaAttemptIndex,
        };
        logFallbackProvenance({
          provenance: FALLBACK_PROVENANCE.BEST_USABLE_FALLBACK,
          stage: 'candidate_retention',
          reason: `retained_${best.origin}_ranked_above_${rankedCandidate.origin}`,
          metadata: { tier: best.tier },
        });
        return {
          ...attempt.result,
          finalized: best.finalized,
          imageContent: buildSafeFallbackImageContent(best.finalized),
          sourceTitle: best.plan.sourceTopic ?? sourceTitle,
          plan: best.plan,
          qualityScore: best.acceptance.qualityScore,
          acceptance: best.acceptance,
          fallbackProvenance: [FALLBACK_PROVENANCE.BEST_USABLE_FALLBACK],
          ideaFailureState,
          freshGenerationsUsed,
          writerOperationsUsed,
          finalIdeaUsed: best.ideaCandidateId ?? ideaCandidateId,
          ideaAttemptIndex: best.ideaAttemptIndex ?? slotOptions?.ideaAttemptIndex,
        };
      }

      if (repairRound === 0 && ideaFailureState.exhausted && slotOptions?.stopWhenIdeaExhausted) {
        break generationLoop;
      }

      if (repairRound >= MAX_TARGETED_REPAIRS_PER_GENERATION) break;
      if (writerOperationsUsed >= (slotOptions?.writerOperationLimit ?? MAX_SLOT_WRITER_OPERATIONS)) break generationLoop;

      const deterministic = attempt.deterministic;
      const blocking = attempt.issues.filter((i) => i.severity === 'error');
      const repairInput = issuesToRepairInput(attempt.issues);
      const reviewFailureInput = repairInput.length === 0 && attempt.technicalReview.available !== false && !attempt.technicalReview.passed
        ? attempt.issues.filter((issue) => issue.severity === 'warning')
        : repairInput;

      counters.contentRepairAttempt = repairRound + 1;
      try {
        writerOperationsUsed += 1;
        if (isSpecificityOnlyBlocking(blocking)) {
          generated = applyLinkedInFormatting(
            await contentService.expandSpecificity(generated, deterministic.specificity, author, plan, provider),
            sourceTitle,
          );
          currentOrigin = 'specificity_expansion';
        } else {
          generated = applyLinkedInFormatting(
            await contentService.repairPost(
              generated,
              reviewFailureInput,
              author,
              provider,
              plan,
            ),
            sourceTitle,
          );
          currentOrigin = 'targeted_repair';
        }
      } catch {
        break;
      }
    }
  }

  if (slotOptions?.deferBestUsableReturn) {
    return {
      ok: false,
      reason: ideaFailureState.exhausted ? 'idea_exhausted' : 'idea_attempt_deferred',
      sourceTitle,
      acceptance: lastAcceptance,
      ideaFailureState,
      freshGenerationsUsed,
      writerOperationsUsed,
      finalIdeaUsed: ideaCandidateId,
      ideaAttemptIndex: slotOptions.ideaAttemptIndex,
    };
  }

  const bestUsableCandidate = candidatePool.best();
  if (bestUsableCandidate) {
    const summary = candidatePool.summary();
    recordDraftTrace(slotOptions, bestUsableCandidate, { returnedAsFallback: true });
    console.warn('[ghostwriter] slot returning best usable candidate after quality gate', {
      batchTraceId: slotOptions?.traceRecorder?.batchTraceId,
      slotTraceId: slotOptions?.slotTraceId,
      sourceTitle: sourceTitle.slice(0, 60),
      blockingIssueCodes: bestUsableCandidate.acceptance.blockingIssueCodes,
      ...summary,
    });
    logFallbackProvenance({
      provenance: FALLBACK_PROVENANCE.BEST_USABLE_FALLBACK,
      stage: 'candidate_retention',
      reason: 'quality_gate_exhausted',
      metadata: { tier: bestUsableCandidate.tier },
    });
    if (bestUsableCandidate.tier === 'EMERGENCY') {
      logFallbackProvenance({ provenance: FALLBACK_PROVENANCE.EMERGENCY_ACCEPTANCE, stage: 'candidate_retention' });
    }
    return {
      ok: true,
      finalized: bestUsableCandidate.finalized,
      imageContent: buildSafeFallbackImageContent(bestUsableCandidate.finalized),
      sourceTitle: bestUsableCandidate.plan.sourceTopic ?? sourceTitle,
      plan: bestUsableCandidate.plan,
      qualityScore: bestUsableCandidate.acceptance.qualityScore,
      attempts: freshGenerationOffset + freshGenerationsUsed,
      acceptance: bestUsableCandidate.acceptance,
      fallbackProvenance: [
        FALLBACK_PROVENANCE.BEST_USABLE_FALLBACK,
        ...(bestUsableCandidate.tier === 'EMERGENCY' ? [FALLBACK_PROVENANCE.EMERGENCY_ACCEPTANCE] : []),
      ],
      ideaFailureState,
      freshGenerationsUsed,
      writerOperationsUsed,
      finalIdeaUsed: bestUsableCandidate.ideaCandidateId ?? ideaCandidateId,
      ideaAttemptIndex: bestUsableCandidate.ideaAttemptIndex ?? slotOptions?.ideaAttemptIndex,
    };
  }

  return {
    ok: false,
    reason: lastAcceptance?.blockingIssueCodes.join(',') || 'quality_gate_exhausted',
    sourceTitle,
    acceptance: lastAcceptance,
    ideaFailureState,
    freshGenerationsUsed,
    writerOperationsUsed,
    finalIdeaUsed: ideaCandidateId,
    ideaAttemptIndex: slotOptions?.ideaAttemptIndex,
  };
}

export async function generateSlotPostWithIdeaRecovery(
  contentService: ContentService,
  initialIdea: SlotIdeaAttempt,
  author: AuthorContext,
  config: GhostwriterBotConfig,
  acceptedBodies: string[],
  provider: 'OPENAI' | 'GEMINI' = 'OPENAI',
  slotOptions?: SlotGenerationOptions,
  selectReplacement?: (
    failure: IdeaFailureState,
    attemptedCandidateIds: Set<string>,
  ) => Promise<SlotIdeaAttempt | null> | SlotIdeaAttempt | null,
): Promise<SlotIdeaRecoveryResult> {
  const candidatePool = slotOptions?.candidatePool ?? new SlotCandidatePool();
  const attemptedCandidateIds = new Set<string>();
  const attemptsById = new Map<string, SlotIdeaAttempt>();
  const trackers = new Map<string, IdeaFailureTracker>();
  let current = initialIdea;
  let ideaAttemptIndex = 0;
  let freshGenerationOffset = 0;
  let writerOperationsOffset = 0;
  let lastFailure: Extract<GeneratedSlotResult, { ok: false }> | undefined;

  while (writerOperationsOffset < MAX_SLOT_WRITER_OPERATIONS) {
    attemptedCandidateIds.add(current.candidateId);
    attemptsById.set(current.candidateId, current);
    const tracker = trackers.get(current.candidateId) ?? new IdeaFailureTracker(current.candidateId);
    trackers.set(current.candidateId, tracker);
    const remainingWriterOperations = MAX_SLOT_WRITER_OPERATIONS - writerOperationsOffset;
    const canAttemptReplacement = Boolean(selectReplacement) && ideaAttemptIndex + 1 < MAX_SLOT_IDEA_ATTEMPTS;
    const segmentLimit = canAttemptReplacement ? IDEA_EXHAUSTION_FRESH_GENERATIONS : MAX_FRESH_GENERATIONS;
    const deferBestUsableReturn = canAttemptReplacement;
    const result = await generateSlotPost(
      contentService,
      current.plan,
      current.trend,
      author,
      config,
      acceptedBodies,
      provider,
      {
        ...slotOptions,
        candidatePool,
        ideaCandidateId: current.candidateId,
        ideaAttemptIndex,
        ideaFailureTracker: tracker,
        freshGenerationLimit: segmentLimit,
        freshGenerationOffset,
        stopWhenIdeaExhausted: Boolean(selectReplacement),
        deferBestUsableReturn,
        writerOperationLimit: remainingWriterOperations,
        retainedCollisionCandidate: ideaAttemptIndex === 0 ? slotOptions?.retainedCollisionCandidate : undefined,
      },
    );
    freshGenerationOffset += result.freshGenerationsUsed ?? segmentLimit;
    writerOperationsOffset += result.writerOperationsUsed ?? remainingWriterOperations;

    if (result.ok && result.acceptance.accepted) {
      const finalIdea = attemptsById.get(result.finalIdeaUsed ?? current.candidateId) ?? current;
      const finalResult = {
        ...result,
        fallbackProvenance: finalIdea.candidateId !== initialIdea.candidateId
          ? [...(result.fallbackProvenance ?? []), FALLBACK_PROVENANCE.ALTERNATE_CANDIDATE_ACCEPTANCE]
          : result.fallbackProvenance,
        freshGenerationsUsed: freshGenerationOffset,
        writerOperationsUsed: writerOperationsOffset,
      };
      console.info('[idea-recovery] slot resolved', {
        batchTraceId: slotOptions?.traceRecorder?.batchTraceId,
        slotTraceId: slotOptions?.slotTraceId,
        initialIdea: initialIdea.candidateId,
        finalIdeaUsed: finalIdea.candidateId,
        ideaAttemptIndex: finalResult.ideaAttemptIndex ?? ideaAttemptIndex,
        replacementUsed: finalIdea.candidateId !== initialIdea.candidateId,
        fallbackUsed: false,
      });
      return { result: finalResult, finalIdea, attemptedCandidateIds: [...attemptedCandidateIds] };
    }

    if (!result.ok) lastFailure = result;
    const failure = result.ideaFailureState ?? tracker.state();
    if (failure.exhausted && selectReplacement && canAttemptReplacement && writerOperationsOffset < MAX_SLOT_WRITER_OPERATIONS) {
      const replacement = await selectReplacement(failure, attemptedCandidateIds);
      if (replacement) {
        console.info('[idea-recovery] replacing exhausted idea', {
          batchTraceId: slotOptions?.traceRecorder?.batchTraceId,
          slotTraceId: slotOptions?.slotTraceId,
          initialIdea: initialIdea.candidateId,
          ideaAttemptIndex,
          freshGenerationCount: failure.independentGenerationCount,
          recurringFailureCodes: [...failure.recurringBlockingCodes, ...failure.recurringWarningCodes],
          ideaExhausted: true,
          exhaustionReason: failure.exhaustionReason,
          replacementCandidateOrigin: replacement.origin ?? 'unknown',
          replacementCandidateId: replacement.candidateId,
          replacementReason: 'highest_ranked_safe_current_batch_alternate',
        });
        current = replacement;
        ideaAttemptIndex += 1;
        continue;
      }
      if (candidatePool.best()) break;
    }

    if (result.ok && (!deferBestUsableReturn || writerOperationsOffset >= MAX_SLOT_WRITER_OPERATIONS)) {
      const finalIdea = attemptsById.get(result.finalIdeaUsed ?? current.candidateId) ?? current;
      const finalResult = {
        ...result,
        fallbackProvenance: finalIdea.candidateId !== initialIdea.candidateId
          ? [...(result.fallbackProvenance ?? []), FALLBACK_PROVENANCE.ALTERNATE_CANDIDATE_ACCEPTANCE]
          : result.fallbackProvenance,
        freshGenerationsUsed: freshGenerationOffset,
        writerOperationsUsed: writerOperationsOffset,
      };
      console.info('[idea-recovery] slot resolved', {
        batchTraceId: slotOptions?.traceRecorder?.batchTraceId,
        slotTraceId: slotOptions?.slotTraceId,
        initialIdea: initialIdea.candidateId,
        finalIdeaUsed: finalIdea.candidateId,
        ideaAttemptIndex: finalResult.ideaAttemptIndex ?? ideaAttemptIndex,
        replacementUsed: finalIdea.candidateId !== initialIdea.candidateId,
        fallbackUsed: Boolean(finalResult.fallbackProvenance?.includes(FALLBACK_PROVENANCE.BEST_USABLE_FALLBACK)),
      });
      return { result: finalResult, finalIdea, attemptedCandidateIds: [...attemptedCandidateIds] };
    }

    if (writerOperationsOffset >= MAX_SLOT_WRITER_OPERATIONS) break;
  }

  const best = candidatePool.best();
  if (best) {
    recordDraftTrace(slotOptions, best, { returnedAsFallback: true });
    logFallbackProvenance({
      provenance: FALLBACK_PROVENANCE.BEST_USABLE_FALLBACK,
      stage: 'candidate_retention',
      reason: 'all_idea_attempts_exhausted',
      metadata: { tier: best.tier },
    });
    const finalIdea = attemptsById.get(best.ideaCandidateId ?? current.candidateId) ?? current;
    const result: Extract<GeneratedSlotResult, { ok: true }> = {
      ok: true,
      finalized: best.finalized,
      imageContent: buildSafeFallbackImageContent(best.finalized),
      sourceTitle: best.plan.sourceTopic ?? current.trend?.topic ?? 'Author expertise',
      plan: best.plan,
      qualityScore: best.acceptance.qualityScore,
      attempts: freshGenerationOffset,
      acceptance: best.acceptance,
      fallbackProvenance: [FALLBACK_PROVENANCE.BEST_USABLE_FALLBACK],
      ideaFailureState: trackers.get(finalIdea.candidateId)?.state(),
      freshGenerationsUsed: freshGenerationOffset,
      writerOperationsUsed: writerOperationsOffset,
      finalIdeaUsed: finalIdea.candidateId,
      ideaAttemptIndex: best.ideaAttemptIndex,
    };
    console.info('[idea-recovery] slot resolved', {
      batchTraceId: slotOptions?.traceRecorder?.batchTraceId,
      slotTraceId: slotOptions?.slotTraceId,
      initialIdea: initialIdea.candidateId,
      finalIdeaUsed: finalIdea.candidateId,
      ideaAttemptIndex: best.ideaAttemptIndex ?? ideaAttemptIndex,
      replacementUsed: finalIdea.candidateId !== initialIdea.candidateId,
      fallbackUsed: true,
    });
    return { result, finalIdea, attemptedCandidateIds: [...attemptedCandidateIds] };
  }

  const boundedFallback = await buildBoundedSafeWriterFallback({
    contentService,
    provider,
    plan: current.plan,
    trend: current.trend,
    author,
    config,
    acceptedBodies,
    batchFingerprints: slotOptions?.batchFingerprints,
    recentTopicHistory: slotOptions?.recentTopicHistory,
    candidatePool,
    traceOptions: slotOptions,
  });
  if (boundedFallback) {
    return { result: boundedFallback, finalIdea: current, attemptedCandidateIds: [...attemptedCandidateIds] };
  }

  throw new Error(
    `[ghostwriter] slot failed after bounded idea recovery: ${lastFailure?.reason ?? 'quality_gate_exhausted'}`,
  );
}

export async function generateSlotPostUntilSuccess(
  contentService: ContentService,
  plan: BatchPostPlan,
  trend: TrendCandidate | null,
  author: AuthorContext,
  config: GhostwriterBotConfig,
  acceptedBodies: string[],
  provider: 'OPENAI' | 'GEMINI' = 'OPENAI',
  slotOptions?: SlotGenerationOptions,
): Promise<Extract<GeneratedSlotResult, { ok: true }>> {
  let lastFailure: Extract<GeneratedSlotResult, { ok: false }> | undefined;
  const candidatePool = slotOptions?.candidatePool ?? new SlotCandidatePool();
  for (let round = 1; round <= MAX_QUOTA_FILL_ROUNDS; round++) {
    const result = await generateSlotPost(
      contentService,
      plan,
      trend,
      author,
      config,
      acceptedBodies,
      provider,
      {
        ...slotOptions,
        candidatePool,
        retainedCollisionCandidate: round === 1 ? slotOptions?.retainedCollisionCandidate : undefined,
      },
    );
    if (result.ok) return result;
    lastFailure = result;
    if (round < MAX_QUOTA_FILL_ROUNDS) {
      console.warn('[ghostwriter] slot retrying until quota met', {
        batchTraceId: slotOptions?.traceRecorder?.batchTraceId,
        slotTraceId: slotOptions?.slotTraceId,
        sourceTitle: result.sourceTitle?.slice(0, 60),
        reason: result.reason,
        round,
        blockingIssueCodes: result.acceptance?.blockingIssueCodes,
      });
    }
  }

  const boundedFallback = await buildBoundedSafeWriterFallback({
    contentService,
    provider,
    plan,
    trend,
    author,
    config,
    acceptedBodies,
    batchFingerprints: slotOptions?.batchFingerprints,
    recentTopicHistory: slotOptions?.recentTopicHistory,
    candidatePool,
    traceOptions: slotOptions,
  });
  if (boundedFallback) return boundedFallback;

  throw new Error(
    `[ghostwriter] slot failed after ${MAX_QUOTA_FILL_ROUNDS} rounds: ${lastFailure?.reason ?? 'quality_gate_exhausted'} (${lastFailure?.sourceTitle?.slice(0, 60) ?? 'unknown'})`,
  );
}
