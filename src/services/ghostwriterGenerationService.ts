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
  canForceAcceptBlockingCodes,
  detectUnsupportedFirstPersonClaims,
  filterBlockingIssues,
  issuesToRepairInput,
  runDeterministicValidation,
  sanitizeImageContent,
  validateFormattedBody,
  validateImageContent,
} from './ghostwriterValidationService';
import { normalizeHashtags } from './postContentFormatting';
import type { GhostwriterBotConfig } from './ghostwriterPipeline';

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

function buildAcceptanceDecision(params: {
  deterministic: ReturnType<typeof runDeterministicValidation>;
  technicalReview: TechnicalReviewResult;
  blocking: QualityIssue[];
  warnings: QualityIssue[];
}): SlotAcceptanceDecision {
  return {
    accepted: params.blocking.length === 0 && params.technicalReview.passed,
    deterministicScore: params.deterministic.deterministicScore,
    specificityScore: params.deterministic.specificity?.score ?? 0,
    qualityScore: params.deterministic.deterministicScore,
    technicalPassed: params.technicalReview.passed,
    blockingIssueCodes: params.blocking.map((i) => i.code),
    warningIssueCodes: params.warnings.map((i) => i.code),
  };
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
  | { accepted: true; result: Extract<GeneratedSlotResult, { ok: true }> }
  | { accepted: false; acceptance: SlotAcceptanceDecision };

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
  });
  let technicalReview: TechnicalReviewResult = { passed: true, confidence: 1, issues: [] };
  if (deterministic.passed) {
    technicalReview = await runTechnicalReview(contentService, generated, author, plan, provider);
  }

  const allIssues = mergeIssues(deterministic.issues, technicalToQuality(technicalReview.issues));
  const blocking = filterBlockingIssues(allIssues, slotAttemptIndex(counters));
  const warnings = allIssues.filter((i) => i.severity === 'warning');
  const acceptance = buildAcceptanceDecision({ deterministic, technicalReview, blocking, warnings });

  if (blocking.length > 0) {
    logSlotDecision(sourceTitle, plan, counters, acceptance);
    return { accepted: false, acceptance };
  }

  const finalized = finalizeGeneratedPostContent(generated, sourceTitle, {
    topic: sourceTitle,
    includeContactInfo: !!config.includeContactInfo,
    includeWebsiteLink: !!config.includeWebsiteLink,
    contactInfo: config.contactInfo,
    websiteUrl: config.websiteUrl,
    description: config.description,
    customLinks: config.customLinks,
  });

  const formatIssues = validateFormattedBody(finalized.body, finalized.hashtags, author.description, {
    includeContactInfo: !!config.includeContactInfo,
    includeWebsiteLink: !!config.includeWebsiteLink,
  }).filter((i) => i.severity === 'error');

  if (formatIssues.length || detectUnsupportedFirstPersonClaims(finalized.body, author.description).length) {
    logSlotDecision(sourceTitle, plan, counters, acceptance);
    return { accepted: false, acceptance };
  }

  if (validateLinkedInFormatting(finalized.body).some((i) => i.severity === 'error')) {
    logSlotDecision(sourceTitle, plan, counters, acceptance);
    return { accepted: false, acceptance };
  }

  const { imageContent, issues: imageIssues } = await resolveImageContent(contentService, finalized, plan, provider);
  logSlotDecision(sourceTitle, plan, counters, acceptance, { imageValidationIssues: imageIssues.map((i) => i.code) });

  return {
    accepted: true,
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
  let lastAcceptance: SlotAcceptanceDecision | undefined;
  let lastCandidate: ReturnType<typeof finalizeGeneratedPostContent> | null = null;
  let lastGenerated: GeneratedPostContent | null = null;

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
        await contentService.generatePlannedPost(plan, author, sourceLink, provider, trend),
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

    lastGenerated = generated;

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
      lastAcceptance = attempt.accepted ? attempt.result.acceptance : attempt.acceptance;
      if (attempt.accepted) {
        console.log('[ghostwriter] post accepted', {
          sourceTitle: sourceTitle.slice(0, 60),
          angle: plan.angle,
          freshGenerationAttempt: fresh,
          provider,
        });
        return attempt.result;
      }

      if (repairRound >= MAX_TARGETED_REPAIRS_PER_GENERATION) break;

      const deterministic = runDeterministicValidation(generated, author, plan, acceptedBodies, {
        sourceTitle,
        batchFingerprints: slotOptions?.batchFingerprints,
        history: slotOptions?.recentTopicHistory,
      });
      const blocking = deterministic.issues.filter((i) => i.severity === 'error');
      lastAcceptance = buildAcceptanceDecision({
        deterministic,
        technicalReview: { passed: false, confidence: 0, issues: [] },
        blocking,
        warnings: deterministic.issues.filter((i) => i.severity === 'warning'),
      });

      counters.contentRepairAttempt = repairRound + 1;
      try {
        if (isSpecificityOnlyBlocking(blocking)) {
          generated = applyLinkedInFormatting(
            await contentService.expandSpecificity(generated, deterministic.specificity, author, plan, provider),
            sourceTitle,
          );
        } else {
          const technicalReview = deterministic.passed
            ? await runTechnicalReview(contentService, generated, author, plan, provider)
            : { passed: false, confidence: 0, issues: [] as TechnicalReviewResult['issues'] };
          generated = applyLinkedInFormatting(
            await contentService.repairPost(
              generated,
              [...issuesToRepairInput(deterministic.issues), ...technicalReview.issues],
              author,
              provider,
              plan,
            ),
            sourceTitle,
          );
        }
      } catch {
        break;
      }
      lastGenerated = generated;
    }

    if (lastGenerated) {
      lastCandidate = finalizeGeneratedPostContent(lastGenerated, sourceTitle, {
        topic: sourceTitle,
        includeContactInfo: !!config.includeContactInfo,
        includeWebsiteLink: !!config.includeWebsiteLink,
        contactInfo: config.contactInfo,
        websiteUrl: config.websiteUrl,
        description: config.description,
        customLinks: config.customLinks,
      });
    }
  }

  const forceAccept = lastCandidate && lastAcceptance && (
    isSpecificityOnlyBlocking(
      lastAcceptance.blockingIssueCodes.map((code) => ({ code, severity: 'error' as const })),
    )
    || canForceAcceptBlockingCodes(lastAcceptance.blockingIssueCodes)
  );

  if (forceAccept) {
    console.warn('[ghostwriter] slot force-accepted after quality gate', {
      sourceTitle: sourceTitle.slice(0, 60),
      blockingIssueCodes: lastAcceptance!.blockingIssueCodes,
    });
    return {
      ok: true,
      finalized: lastCandidate!,
      imageContent: buildSafeFallbackImageContent(lastCandidate!),
      sourceTitle,
      plan,
      qualityScore: lastAcceptance!.qualityScore,
      attempts: MAX_FRESH_GENERATIONS,
      acceptance: lastAcceptance!,
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
  for (let round = 1; round <= MAX_QUOTA_FILL_ROUNDS; round++) {
    const result = await generateSlotPost(
      contentService,
      plan,
      trend,
      author,
      config,
      acceptedBodies,
      provider,
      slotOptions,
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

  throw new Error(
    `[ghostwriter] slot failed after ${MAX_QUOTA_FILL_ROUNDS} rounds: ${lastFailure?.reason ?? 'quality_gate_exhausted'} (${lastFailure?.sourceTitle?.slice(0, 60) ?? 'unknown'})`,
  );
}
