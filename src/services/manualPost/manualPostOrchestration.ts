import { prisma } from '../../prismaClient';
import { canGenerate } from '../entitlementService';
import {
  canRewritePost,
  canUseManualAiOperation,
  recordManualAiOperation,
} from '../planEntitlementService';
import { getBotVoice } from '../userContentContext';
import {
  ManualPostError,
  MUTABLE_STATUSES,
} from '../manualPostService';
import {
  MAX_REWRITE_SUGGESTIONS_LENGTH,
  parseContentProvider,
  validateGenerateInput,
  validateUnsavedRewriteInput,
} from '../manualPostAiService';
import {
  invokeManualRewritePrompt,
  resolveManualContentService,
} from './manualAiProvider';
import { finalizeManualGeneratedPostV2 } from './manualPostFormatting';
import { runManualGenerationMultiStage } from './manualPostMultiStage';
import {
  buildManualRewritePromptV2,
} from './manualPostPrompts';
import { createManualProviderCallBudget } from './manualPostTypes';
import { getManualVoiceContext } from './manualVoiceProfileService';
import { getRecentManualFingerprints } from './manualPostFingerprintService';
import { RECENT_STYLE_POST_LIMIT, selectManualExpressionMode } from '../expressionModeService';
import {
  buildLengthRepairInstruction,
  evaluateGeneratedPostLength,
  isExplicitShorteningInstruction,
} from '../generatedPostLength';
import { safeRecommendMediaForPost } from '../mediaRecommendationService';
import type { ManualGeneratedPost } from './manualPostTypes';
import { evaluateSemanticProgression } from '../semanticProgression';
import {
  enforcePersonalExperienceNumberBoundary,
  markPersonalExperienceUsed,
  personalExperienceWasUsed,
  resolvePersonalExperience,
} from './personalExperienceService';
import {
  buildGenerationAuthorityContext,
  buildUserKnowledgeAuthorityContext,
  loadUserKnowledgeAuthorityContext,
  type GenerationAuthorityContext,
} from '../userKnowledgeAuthorityService';

function deriveTopicFromContent(content: string): string {
  const line = content
    .split('\n')
    .map((value) => value.trim())
    .find(Boolean);
  return (line ?? 'LinkedIn post').slice(0, 200);
}

function toAuthorContext(
  voice: Awaited<ReturnType<typeof getBotVoice>>,
  authorityContext?: GenerationAuthorityContext,
) {
  return {
    description: voice.description,
    tone: voice.tone,
    niches: voice.niches,
    targetAudience: voice.strategy
      ? [
          voice.strategy.targetAudience.primaryAudience,
          ...(voice.strategy.targetAudience.secondaryAudiences ?? []),
        ].filter(Boolean)
      : undefined,
    strategy: voice.strategy,
    authorityContext,
  };
}

async function repairManualPostLength(params: {
  generated: ManualGeneratedPost;
  fallbackContent: string;
  topic: string;
  additionalContext?: string;
  suggestions?: string;
  voice: Awaited<ReturnType<typeof getBotVoice>>;
  voiceContext: Awaited<ReturnType<typeof getManualVoiceContext>>;
  contentService: Awaited<ReturnType<typeof resolveManualContentService>>;
  provider: ReturnType<typeof parseContentProvider>;
  generationType: string;
}) {
  let generated = params.generated;
  let finalized = finalizeManualGeneratedPostV2(generated, params.fallbackContent, {
    topic: params.topic,
    voice: params.voice,
  }, false);
  const initialLength = finalized.content.length;
  const status = evaluateGeneratedPostLength(finalized.content);
  const repairedFor = status === 'TOO_SHORT' || status === 'TOO_LONG' ? status : null;
  const minimumExempt = isExplicitShorteningInstruction(params.suggestions);
  let repairAttempts = 0;
  let repairAccepted = false;
  let repairRejected = false;
  let repairInputLength: number | null = null;
  let repairOutputLength: number | null = null;
  const progression = evaluateSemanticProgression(finalized.content, {
    allowEnumeration: /\b(?:listicle|checklist|steps|how-to|how to)\b/i.test(params.suggestions ?? ''),
  });
  const lengthNeedsRepair = status === 'TOO_LONG' || (status === 'TOO_SHORT' && !minimumExempt);
  const progressionNeedsRepair = !progression.passed && !minimumExempt;
  if (lengthNeedsRepair || progressionNeedsRepair) {
    repairAttempts = 1;
    repairInputLength = finalized.content.length;
    const repairInstructions = [
      lengthNeedsRepair ? buildLengthRepairInstruction(status as 'TOO_SHORT' | 'TOO_LONG') : '',
      progressionNeedsRepair
        ? `Repair only these argument-progression issues:\n${progression.issues.map((issue) => `- ${issue}`).join('\n')}\nReplace redundant material with a genuinely missing dimension; do not synonym-swap or append a second conclusion.`
        : '',
      params.additionalContext ?? '',
    ].filter(Boolean).join('\n\n');
    const prompt = buildManualRewritePromptV2({
      currentContent: finalized.content,
      suggestions: repairInstructions,
      author: toAuthorContext(params.voice),
      voiceContext: params.voiceContext,
    });
    try {
      const repaired = await invokeManualRewritePrompt(params.contentService, prompt, params.provider);
      const candidate = finalizeManualGeneratedPostV2(repaired, finalized.content, {
        topic: params.topic,
        voice: params.voice,
      }, false);
      repairOutputLength = candidate.content.length;
      const candidateLength = evaluateGeneratedPostLength(candidate.content);
      const candidateProgression = evaluateSemanticProgression(candidate.content, {
        allowEnumeration: /\b(?:listicle|checklist|steps|how-to|how to)\b/i.test(params.suggestions ?? ''),
      });
      const lengthObjectiveMet = candidateLength !== 'TOO_LONG'
        && (minimumExempt || candidateLength !== 'TOO_SHORT');
      const progressionObjectiveMet = !progressionNeedsRepair || candidateProgression.passed;
      if (lengthObjectiveMet && progressionObjectiveMet) {
        finalized = candidate;
        repairAccepted = true;
      } else {
        repairRejected = true;
      }
    } catch (error) {
      repairRejected = true;
      console.warn('[generated-post-quality] combined rewrite repair failed; returning coherent draft', {
        generationType: params.generationType,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!minimumExempt && evaluateGeneratedPostLength(finalized.content) === 'TOO_SHORT') {
    repairAttempts += 1;
    const recoveryPrompt = buildManualRewritePromptV2({
      currentContent: finalized.content,
      suggestions: `FINAL BOUNDED LENGTH RECOVERY:
The current rewrite is below 1,600 visible characters and the previous repair did not satisfy the contract.
Develop one or two substantive dimensions already supported by the current claim: its mechanism, interpretation, consequence, or useful qualification.
Return 1,600-3,000 characters. Preserve credible facts and the central claim. Do not pad, repeat, fabricate evidence, or add a generic conclusion.`,
      author: toAuthorContext(params.voice),
      voiceContext: params.voiceContext,
    });
    try {
      const recovered = await invokeManualRewritePrompt(params.contentService, recoveryPrompt, params.provider);
      const candidate = finalizeManualGeneratedPostV2(recovered, finalized.content, {
        topic: params.topic,
        voice: params.voice,
      }, false);
      repairOutputLength = candidate.content.length;
      const candidateStatus = evaluateGeneratedPostLength(candidate.content);
      const candidateProgression = evaluateSemanticProgression(candidate.content, {
        allowEnumeration: /\b(?:listicle|checklist|steps|how-to|how to)\b/i.test(params.suggestions ?? ''),
      });
      if (candidateStatus !== 'TOO_SHORT' && candidateStatus !== 'TOO_LONG' && candidateProgression.passed) {
        finalized = candidate;
        repairAccepted = true;
      } else {
        repairRejected = true;
      }
    } catch (error) {
      repairRejected = true;
      console.warn('[generated-post-quality] final bounded rewrite recovery failed', {
        generationType: params.generationType,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const finalStatus = evaluateGeneratedPostLength(finalized.content);
  if (finalStatus === 'TOO_LONG' || (!minimumExempt && finalStatus === 'TOO_SHORT')) {
    throw new ManualPostError(502, 'AI provider could not satisfy the generated post length contract after bounded recovery');
  }

  console.info('[generated-post-length]', {
    generationType: params.generationType,
    initialLength,
    finalLength: finalized.content.length,
    lengthStatus: evaluateGeneratedPostLength(finalized.content),
    repairAttempts,
    repairInputLength,
    repairOutputLength,
    repairAccepted,
    repairRejected,
    repairedFor,
    minimumExempt,
    semanticProgressionRepairTriggered: progressionNeedsRepair,
    minimumLengthSatisfied: minimumExempt || finalized.content.length >= 1600,
  });
  return finalized;
}

export async function generateManualPostV2(
  userId: string,
  body: {
    topic?: unknown;
    additionalInstructions?: unknown;
    supportingContext?: unknown;
    personalExperience?: unknown;
    provider?: unknown;
  },
) {
  const gate = await canGenerate(userId);
  if (!gate.allowed) {
    throw new ManualPostError(
      403,
      gate.reason || 'You are not allowed to generate content right now',
      gate.entitlement,
    );
  }

  await canUseManualAiOperation(userId);

  const { topic, additionalInstructions, supportingContext, personalExperience: experienceInput } = validateGenerateInput(body);
  const provider = parseContentProvider(body.provider);
  const personalExperience = await resolvePersonalExperience(userId, experienceInput);
  const voice = await getBotVoice(userId);
  let knowledgeContext = buildUserKnowledgeAuthorityContext({
    profileDescription: voice.description,
    profilePositioning: voice.strategy?.profilePositioning,
    niches: voice.niches,
    explicitInstructions: [additionalInstructions].filter((value): value is string => !!value?.trim()),
  });
  const [voiceContext, recentVoiceRows, loadedKnowledgeContext] = await Promise.all([
    getManualVoiceContext(userId, topic),
    prisma.post.findMany({ where: { userId, status: { in: ['REVIEW', 'DRAFT', 'SCHEDULED', 'PUBLISHED'] } }, orderBy: { createdAt: 'desc' }, take: RECENT_STYLE_POST_LIMIT, select: { content: true } }),
    loadUserKnowledgeAuthorityContext(userId, {
      niches: voice.niches,
      explicitInstructions: [additionalInstructions].filter((value): value is string => !!value?.trim()),
    }).catch((error) => {
      console.warn('[user-authority] manual evidence load failed; using conservative profile-only boundaries', {
        userId,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }),
  ]);
  if (loadedKnowledgeContext) knowledgeContext = loadedKnowledgeContext;
  const manualAuthorityContext = buildGenerationAuthorityContext(knowledgeContext, 'MANUAL', [topic]);
  const recentPosts = recentVoiceRows.map((post) => post.content);
  const expressionMode = selectManualExpressionMode(topic, additionalInstructions, voice.strategy?.writingStyle, recentPosts);
  let recentFingerprints: Awaited<ReturnType<typeof getRecentManualFingerprints>> = [];
  try {
    recentFingerprints = await getRecentManualFingerprints(userId);
  } catch (error) {
    console.warn('[manual-fingerprint] retrieval failed; continuing without fingerprints', {
      userId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const contentService = await resolveManualContentService(userId, provider);
  const budget = createManualProviderCallBudget();

  let generated;
  let selectedPlan: Awaited<ReturnType<typeof runManualGenerationMultiStage>>['selectedPlan'];
  try {
    const result = await runManualGenerationMultiStage(
      contentService,
      {
        topic,
        additionalInstructions,
        supportingContext,
        personalExperience,
        author: toAuthorContext(voice, manualAuthorityContext),
        voiceContext,
        recentFingerprints,
        recentPosts,
        expressionMode,
      },
      provider,
      budget,
    );
    if (process.env.VOICE_DIVERSITY_DEBUG === 'true') console.info('[manual-expression-mode]', { expressionMode, recentPostsAnalyzed: recentPosts.length });
    generated = result.post;
    selectedPlan = result.selectedPlan;
  } catch (error) {
    if (error instanceof ManualPostError) throw error;
    console.error('[manual-post-v2] generation failed', {
      userId,
      message: error instanceof Error ? error.message : String(error),
    });
    throw new ManualPostError(502, 'Failed to generate post content');
  }

  // Length and quality issues are combined into the multi-stage pipeline's
  // single targeted repair. Finalization performs the final safety/max check.
  let normalized = finalizeManualGeneratedPostV2(generated, topic, { topic, voice });
  if (personalExperience) {
    const boundedContent = enforcePersonalExperienceNumberBoundary(
      normalized.content,
      `${topic}\n${additionalInstructions ?? ''}\n${supportingContext ?? ''}\n${voice.description ?? ''}\n${personalExperience.rawText}`,
    );
    if (boundedContent && boundedContent !== normalized.content) normalized = { ...normalized, content: boundedContent };
  }
  const normalizedStatus = evaluateGeneratedPostLength(normalized.content);
  if (normalizedStatus === 'TOO_LONG') {
    throw new ManualPostError(502, 'AI provider could not satisfy the final generated post length invariant');
  }

  await recordManualAiOperation(userId, 'generate');
  const experienceUsed = Boolean(personalExperience && personalExperienceWasUsed(
    normalized.content,
    personalExperience.rawText,
    selectedPlan.experienceRelevance ?? 'LOW',
  ));
  if (experienceUsed && personalExperience?.id) await markPersonalExperienceUsed(userId, personalExperience.id);

  return {
    content: normalized.content,
    hashtags: normalized.hashtags || null,
    topic,
    generatedBy: 'AI' as const,
    experienceUsed,
    savedExperienceId: personalExperience?.id ?? null,
    mediaRecommendation: safeRecommendMediaForPost(normalized.content),
  };
}

export async function rewriteUnsavedManualPostV2(
  userId: string,
  body: {
    content?: unknown;
    suggestions?: unknown;
    topic?: unknown;
    provider?: unknown;
  },
) {
  const gate = await canGenerate(userId);
  if (!gate.allowed) {
    throw new ManualPostError(
      403,
      gate.reason || 'You are not allowed to rewrite content right now',
      gate.entitlement,
    );
  }

  const usage = await canUseManualAiOperation(userId);

  const { content, suggestions, topic: suppliedTopic } = validateUnsavedRewriteInput(body);
  const provider = parseContentProvider(body.provider);
  const voice = await getBotVoice(userId);
  const topic = suppliedTopic ?? deriveTopicFromContent(content);
  const voiceContext = await getManualVoiceContext(userId, topic);
  const contentService = await resolveManualContentService(userId, provider);

  const prompt = buildManualRewritePromptV2({
    currentContent: content,
    suggestions,
    author: toAuthorContext(voice),
    voiceContext,
  });

  let generated;
  try {
    generated = await invokeManualRewritePrompt(contentService, prompt, provider);
  } catch (error) {
    console.error('[manual-post-v2] unsaved rewrite failed', {
      userId,
      message: error instanceof Error ? error.message : String(error),
    });
    throw new ManualPostError(502, 'Failed to rewrite post content');
  }

  const normalized = await repairManualPostLength({
    generated,
    fallbackContent: content,
    topic,
    suggestions,
    additionalContext: suggestions,
    voice,
    voiceContext,
    contentService,
    provider,
    generationType: 'manual_rewrite_unsaved',
  });

  await recordManualAiOperation(userId, 'rewrite_unsaved');

  return {
    content: normalized.content,
    hashtags: normalized.hashtags || null,
    topic,
    rewriteCount: usage.usedThisMonth + 1,
    mediaRecommendation: safeRecommendMediaForPost(normalized.content),
  };
}

async function findRewritableManualPost(userId: string, postId: string) {
  const post = await prisma.post.findFirst({
    where: { id: postId, userId },
  });
  if (!post) throw new ManualPostError(404, 'Post not found');
  if (post.status === 'PUBLISHED') {
    throw new ManualPostError(409, 'Cannot rewrite a published post');
  }
  if (!MUTABLE_STATUSES.includes(post.status)) {
    throw new ManualPostError(409, `Cannot rewrite a post with status ${post.status}`);
  }
  return post;
}

export async function rewriteSavedManualPostV2(
  userId: string,
  postId: string,
  body: { suggestions?: unknown; provider?: unknown },
) {
  const suggestions = typeof body.suggestions === 'string' ? body.suggestions.trim() : '';
  if (!suggestions) throw new ManualPostError(400, 'suggestions is required');
  if (suggestions.length > MAX_REWRITE_SUGGESTIONS_LENGTH) {
    throw new ManualPostError(
      400,
      `suggestions must be ${MAX_REWRITE_SUGGESTIONS_LENGTH} characters or fewer`,
    );
  }

  const post = await findRewritableManualPost(userId, postId);
  await canRewritePost(userId, post.id);

  const provider = parseContentProvider(body.provider);
  const voice = await getBotVoice(userId);
  const topic = post.manualTopic ?? deriveTopicFromContent(post.content);
  const voiceContext = await getManualVoiceContext(userId, topic);
  const contentService = await resolveManualContentService(userId, provider);

  const prompt = buildManualRewritePromptV2({
    currentContent: post.content,
    suggestions,
    author: toAuthorContext(voice),
    voiceContext,
  });

  let generated;
  try {
    generated = await invokeManualRewritePrompt(contentService, prompt, provider);
  } catch (error) {
    console.error('[manual-post-v2] saved rewrite failed', {
      userId,
      postId,
      message: error instanceof Error ? error.message : String(error),
    });
    throw new ManualPostError(502, 'Failed to rewrite post content');
  }

  const normalized = await repairManualPostLength({
    generated,
    fallbackContent: post.content,
    topic,
    suggestions,
    additionalContext: suggestions,
    voice,
    voiceContext,
    contentService,
    provider,
    generationType: 'manual_rewrite_saved',
  });

  const updated = await prisma.post.update({
    where: { id: post.id },
    data: {
      content: normalized.content,
      hashtags: normalized.hashtags || post.hashtags,
      rewriteCount: { increment: 1 },
      errorMessage: null,
      aiGenerated: true,
      manualTopic: post.manualTopic ?? topic,
    },
  });

  return updated;
}
