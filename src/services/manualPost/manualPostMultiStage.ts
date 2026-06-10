import type { ContentService } from '../contentService';
import type { ContentProvider } from '../manualPostAiService';
import type { AuthorContext } from '../generationTypes';
import { ManualPostError } from '../manualPostService';
import {
  applyBoundedManualRevision,
  criticScoresNeedRewrite,
  evaluateDeterministicDraftQuality,
  parseManualCriticResult,
  preservedFactsSurviveRevision,
} from './manualPostCritic';
import {
  assembleManualPostBody,
} from './manualPostFormatting';
import {
  invokeManualDraftPrompt,
  invokeManualPlanningPrompt,
  invokeManualCriticPrompt,
} from './manualAiProvider';
import {
  buildManualCriticAndRevisionPrompt,
  buildManualDraftPrompt,
  buildManualPlanningPrompt,
} from './manualPostPrompts';
import {
  createFallbackManualPlan,
  selectManualPlan,
  selectedPlanToContentPlan,
} from './manualPostPlanning';
import type { ManualVoiceContext } from './manualVoiceProfileService';
import type { ManualPostFingerprintRecord } from './manualPostFingerprintService';
import type {
  ManualGeneratedPost,
  ManualProviderCallBudget,
  SelectedManualPlan,
} from './manualPostTypes';

export type ManualGenerationStageInput = {
  topic: string;
  additionalInstructions?: string;
  supportingContext?: string;
  author: AuthorContext;
  voiceContext?: ManualVoiceContext;
  recentFingerprints?: ManualPostFingerprintRecord[];
};

export type ManualGenerationStageResult = {
  post: ManualGeneratedPost;
  providerCalls: number;
  usedQualityRepair: boolean;
  selectedPlan: SelectedManualPlan;
};

export async function runManualGenerationMultiStage(
  contentService: ContentService,
  input: ManualGenerationStageInput,
  provider: ContentProvider,
  budget: ManualProviderCallBudget = {
    recordProviderCall: () => {},
    totalCalls: () => 0,
  },
): Promise<ManualGenerationStageResult> {
  let selectedPlan: SelectedManualPlan;

  try {
    const planningPrompt = buildManualPlanningPrompt(input);
    const planningRaw = await invokeManualPlanningPrompt(
      contentService,
      planningPrompt,
      provider,
      budget,
    );
    selectedPlan = selectManualPlan(
      planningRaw,
      input.topic,
      input.supportingContext,
      input.recentFingerprints ?? [],
    );
  } catch (error) {
    console.warn('[manual-post-v2] planning failed; using fallback plan', {
      message: error instanceof Error ? error.message : String(error),
    });
    selectedPlan = createFallbackManualPlan(input.topic);
  }

  const draftPrompt = buildManualDraftPrompt({
    ...input,
    selectedPlan,
  });

  let draft: ManualGeneratedPost;
  try {
    draft = await invokeManualDraftPrompt(contentService, draftPrompt, provider, budget);
  } catch (error) {
    console.error('[manual-post-v2] draft generation failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    throw new ManualPostError(502, 'Failed to generate post content');
  }

  if (!draft.contentPlan) {
    draft = {
      ...draft,
      contentPlan: selectedPlanToContentPlan(selectedPlan),
    };
  }

  if (!draft.hook.trim() && selectedPlan.hook.trim()) {
    draft = { ...draft, hook: selectedPlan.hook.trim() };
  }

  draft = {
    ...draft,
    sourceTopic: draft.sourceTopic || input.topic,
    contentPlan: selectedPlanToContentPlan(selectedPlan),
  };

  const assembled = assembleManualPostBody(draft);
  const deterministic = evaluateDeterministicDraftQuality(assembled);
  if (!deterministic.needsQualityRepair) {
    return {
      post: draft,
      providerCalls: budget.totalCalls(),
      usedQualityRepair: false,
      selectedPlan,
    };
  }

  try {
    const criticPrompt = buildManualCriticAndRevisionPrompt({
        topic: input.topic,
        author: input.author,
        voiceContext: input.voiceContext,
        selectedPlan,
        draft: {
          hook: draft.hook,
          body: draft.body,
          closingLine: draft.closingLine,
          hashtags: draft.hashtags,
        },
        deterministicIssues: deterministic.matches,
      });
      const criticRaw = await invokeManualCriticPrompt(
        contentService,
        criticPrompt,
        provider,
        budget,
      );
      const critic = parseManualCriticResult(criticRaw);
      const shouldRevise =
        critic.decision === 'REVISE' || criticScoresNeedRewrite(critic.scores);

      if (shouldRevise && critic.revised) {
        const revised = applyBoundedManualRevision(draft, {
          ...critic,
          decision: 'REVISE',
        });
        if (preservedFactsSurviveRevision(draft, revised)) {
          return {
            post: {
              ...revised,
              contentPlan: selectedPlanToContentPlan(selectedPlan),
              sourceTopic: draft.sourceTopic || input.topic,
            },
            providerCalls: budget.totalCalls(),
            usedQualityRepair: true,
            selectedPlan,
          };
        }
      }
    } catch (error) {
      console.warn('[manual-post-v2] critic/revision failed; returning draft', {
        message: error instanceof Error ? error.message : String(error),
      });
    }

  return {
    post: draft,
    providerCalls: budget.totalCalls(),
    usedQualityRepair: false,
    selectedPlan,
  };
}
