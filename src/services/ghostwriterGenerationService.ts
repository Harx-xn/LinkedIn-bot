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
  type SlotCandidateOrigin,
} from './ghostwriterCandidateSelection';
import {
  FALLBACK_PROVENANCE,
  logFallbackProvenance,
  type FallbackProvenance,
} from './fallbackProvenanceService';

export const MAX_FRESH_GENERATIONS = 3;
export const MAX_TARGETED_REPAIRS_PER_GENERATION = 2;
export const MAX_QUOTA_FILL_ROUNDS = 2;

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
    }
  | {
      ok: false;
      reason: string;
      sourceTitle?: string;
      acceptance?: SlotAcceptanceDecision;
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
};

function mergeIssues(...groups: QualityIssue[][]): QualityIssue[] {
  const seen = new Set<string>();
  const out: QualityIssue[] = [];
  for (const group of groups) {
    for (const issue of group) {
      const key = `${issue.code}:${issue.evidence?.join('|') ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(issue);
    }
  }
  return out;
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
}): SlotAcceptanceDecision {
  const reviewAvailable = params.technicalReview.available !== false;
  const semanticQuality = reviewAvailable
    ? Math.round((
      (params.technicalReview.informationDensity ?? 100)
      + (params.technicalReview.progressionQuality ?? 100)
      + (100 - (params.technicalReview.redundancyRisk ?? 0))
      + (100 - (params.technicalReview.genericDiscourseRisk ?? 0))
      + (params.technicalReview.claimFidelity ?? 100)
    ) / 5)
    : params.deterministic.deterministicScore;
  return {
    accepted: params.blocking.length === 0 && (!reviewAvailable || params.technicalReview.passed),
    deterministicScore: params.deterministic.deterministicScore,
    specificityScore: params.deterministic.specificity?.score ?? 0,
    qualityScore: Math.min(params.deterministic.deterministicScore, semanticQuality),
    technicalPassed: reviewAvailable && params.technicalReview.passed,
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
export function buildBoundedSafeWriterFallback(params: {
  plan: BatchPostPlan;
  trend: TrendCandidate | null;
  author: AuthorContext;
  config: GhostwriterBotConfig;
  acceptedBodies: string[];
  batchFingerprints?: TopicFingerprint[];
  recentTopicHistory?: TopicHistoryRow[];
  candidatePool?: SlotCandidatePool;
}): Extract<GeneratedSlotResult, { ok: true }> | null {
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
  const plannedSupport = [
    params.plan.depthPlan?.underlyingCauseOrMechanism,
    params.plan.depthPlan?.meaningfulConsequence,
    params.plan.depthPlan?.usefulTensionOrQualification,
    params.plan.depthPlan?.endingInsight,
  ].filter((value): value is string => Boolean(value?.trim()))
    .map((value) => value.replace(/\s+/g, ' ').trim())
    .filter((value, index, all) => all.indexOf(value) === index && value.toLowerCase() !== claim.toLowerCase())
    .slice(0, 2);
  const safeSupport = plannedSupport.length
    ? plannedSupport
    : ['The practical value is making the next decision with the relevant constraint stated clearly.'];
  const generated = applyLinkedInFormatting({
    headline: claim.slice(0, 90),
    subheadline: '',
    bulletPoints: [],
    body: [claim, ...safeSupport].join('\n\n'),
    hashtags: '',
  }, sourceTitle);
  const deterministic = runDeterministicValidation(generated, params.author, params.plan, params.acceptedBodies, {
    sourceTitle,
    batchFingerprints: params.batchFingerprints,
    history: params.recentTopicHistory,
    enforceLength: false,
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
  const issues = mergeIssues(deterministic.issues, formatIssues, authorityIssues, linkedInIssues);
  if (issues.some((issue) => isCriticalCandidateIssueCode(issue.code))) return null;
  const blocking = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity === 'warning');
  const technicalReview: TechnicalReviewResult = { available: false, passed: false, confidence: 0, issues: [] };
  const acceptance = buildAcceptanceDecision({ deterministic, technicalReview, blocking, warnings });
  const pool = params.candidatePool ?? new SlotCandidatePool();
  const ranked = pool.add({ origin: 'emergency_fallback', generated, finalized, acceptance, technicalReview, issues, plan: params.plan });
  if (!ranked.eligible) return null;
  logFallbackProvenance({ provenance: FALLBACK_PROVENANCE.WRITER_FALLBACK, stage: 'bounded_safe_writer', reason: 'writer_attempts_exhausted' });
  logFallbackProvenance({ provenance: FALLBACK_PROVENANCE.EMERGENCY_ACCEPTANCE, stage: 'bounded_safe_writer', metadata: { tier: ranked.tier } });
  return {
    ok: true,
    finalized,
    imageContent: buildSafeFallbackImageContent(finalized),
    sourceTitle,
    plan: params.plan,
    qualityScore: acceptance.qualityScore,
    attempts: MAX_FRESH_GENERATIONS * MAX_QUOTA_FILL_ROUNDS,
    acceptance,
    fallbackProvenance: [FALLBACK_PROVENANCE.WRITER_FALLBACK, FALLBACK_PROVENANCE.EMERGENCY_ACCEPTANCE],
  };
}

function logSlotDecision(
  sourceTitle: string,
  plan: BatchPostPlan,
  counters: AttemptCounters,
  acceptance: SlotAcceptanceDecision,
  extra?: { imageValidationIssues?: string[] },
) {
  console.log('[ghostwriter] slot validation', {
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
  const allIssues = mergeIssues(
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
  const acceptance = buildAcceptanceDecision({ deterministic, technicalReview, blocking, warnings });
  const observation = { generated, finalized, acceptance, technicalReview, issues: allIssues, plan };

  if (blocking.length > 0 || formatIssues.length || authorityIssues.length) {
    logSlotDecision(sourceTitle, plan, counters, acceptance);
    return { accepted: false, acceptance, deterministic, technicalReview, issues: allIssues, observation };
  }

  if (linkedInIssues.length) {
    logSlotDecision(sourceTitle, plan, counters, acceptance);
    return { accepted: false, acceptance, deterministic, technicalReview, issues: allIssues, observation };
  }

  const { imageContent, issues: imageIssues } = config.imageMode === 'providedBackground'
    ? await resolveImageContent(contentService, finalized, plan, provider)
    : { imageContent: null, issues: [] };
  logSlotDecision(sourceTitle, plan, counters, acceptance, { imageValidationIssues: imageIssues.map((i) => i.code) });

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
  let lastAcceptance: SlotAcceptanceDecision | undefined;
  let initialLength = 0;

  if (slotOptions?.retainedCollisionCandidate) {
    const retained = slotOptions.retainedCollisionCandidate;
    candidatePool.add({
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
    });
  }

  for (let fresh = 1; fresh <= MAX_FRESH_GENERATIONS; fresh++) {
    const counters: AttemptCounters = {
      freshGenerationAttempt: fresh,
      contentRepairAttempt: 0,
      jsonRepairAttempt: 0,
      provider,
    };

    let generated: GeneratedPostContent;
    try {
      generated = applyLinkedInFormatting(
        await contentService.generatePlannedPost(plan, author, sourceLink, provider, trend, slotOptions?.recentPosts ?? []),
        sourceTitle,
      );
    } catch (err) {
      if (err instanceof GeneratedOutputParseError) counters.jsonRepairAttempt = 2;
      console.error('[ghostwriter] generation failed', {
        sourceTitle: sourceTitle.slice(0, 60),
        freshGenerationAttempt: fresh,
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
      ?? (fresh === 1 ? 'initial_draft' : 'fresh_regeneration');

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
      lastAcceptance = attempt.accepted ? attempt.result.acceptance : attempt.acceptance;
      if (attempt.accepted) {
        console.log('[ghostwriter] post accepted', { sourceTitle: sourceTitle.slice(0, 60), angle: plan.angle, expressionMode: plan.expressionMode, freshGenerationAttempt: fresh, provider });
        const writerPromptEstimate = estimatePromptTokens(JSON.stringify({ plan, author: { description: author.description, tone: author.tone, niches: author.niches }, recent: slotOptions?.recentPosts?.slice(0, 5).map((post) => post.slice(0, 96)) ?? [] }));
        logGenerationTelemetry({
          generationType: 'ghostwriter_batch_slot',
          expressionMode: plan.expressionMode ?? null,
          plannerCalls: 0,
          writerCalls: fresh,
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
        if (!best || best === rankedCandidate) return attempt.result;
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
          qualityScore: best.acceptance.qualityScore,
          acceptance: best.acceptance,
          fallbackProvenance: [FALLBACK_PROVENANCE.BEST_USABLE_FALLBACK],
        };
      }

      if (repairRound >= MAX_TARGETED_REPAIRS_PER_GENERATION) break;

      const deterministic = attempt.deterministic;
      const blocking = attempt.issues.filter((i) => i.severity === 'error');

      counters.contentRepairAttempt = repairRound + 1;
      try {
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
              issuesToRepairInput(attempt.issues),
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

  const bestUsableCandidate = candidatePool.best();
  if (bestUsableCandidate) {
    const summary = candidatePool.summary();
    console.warn('[ghostwriter] slot returning best usable candidate after quality gate', {
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
      sourceTitle,
      plan,
      qualityScore: bestUsableCandidate.acceptance.qualityScore,
      attempts: MAX_FRESH_GENERATIONS,
      acceptance: bestUsableCandidate.acceptance,
      fallbackProvenance: [
        FALLBACK_PROVENANCE.BEST_USABLE_FALLBACK,
        ...(bestUsableCandidate.tier === 'EMERGENCY' ? [FALLBACK_PROVENANCE.EMERGENCY_ACCEPTANCE] : []),
      ],
    };
  }

  return {
    ok: false,
    reason: lastAcceptance?.blockingIssueCodes.join(',') || 'quality_gate_exhausted',
    sourceTitle,
    acceptance: lastAcceptance,
  };
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
        sourceTitle: result.sourceTitle?.slice(0, 60),
        reason: result.reason,
        round,
        blockingIssueCodes: result.acceptance?.blockingIssueCodes,
      });
    }
  }

  const boundedFallback = buildBoundedSafeWriterFallback({
    plan,
    trend,
    author,
    config,
    acceptedBodies,
    batchFingerprints: slotOptions?.batchFingerprints,
    recentTopicHistory: slotOptions?.recentTopicHistory,
    candidatePool,
  });
  if (boundedFallback) return boundedFallback;

  throw new Error(
    `[ghostwriter] slot failed after ${MAX_QUOTA_FILL_ROUNDS} rounds: ${lastFailure?.reason ?? 'quality_gate_exhausted'} (${lastFailure?.sourceTitle?.slice(0, 60) ?? 'unknown'})`,
  );
}
