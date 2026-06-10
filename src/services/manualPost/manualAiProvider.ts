import { getContentServiceForUser } from '../userContentContext';
import type { ContentService } from '../contentService';
import { ManualPostError } from '../manualPostService';
import type { ContentProvider } from '../manualPostAiService';
import { parseManualProviderOutputWithRepair } from './manualPostJsonRepair';
import { parseManualPlanningResult } from './manualPostPlanning';
import type {
  ManualGeneratedPost,
  ManualPlanningResult,
  ManualProviderCallBudget,
} from './manualPostTypes';

export async function resolveManualContentService(
  userId: string,
  provider: ContentProvider,
): Promise<ContentService> {
  const contentService = await getContentServiceForUser(userId);
  const hasPrimary = contentService.hasProvider(provider);
  const hasFallback =
    provider === 'OPENAI'
      ? contentService.hasProvider('GEMINI')
      : contentService.hasProvider('OPENAI');

  if (!hasPrimary && !hasFallback) {
    throw new ManualPostError(
      503,
      provider === 'OPENAI'
        ? 'AI provider unavailable. Configure OpenAI or Gemini API keys.'
        : 'AI provider unavailable. Configure Gemini or OpenAI API keys.',
    );
  }

  return contentService;
}

async function fetchManualStageRaw(
  contentService: ContentService,
  prompt: string,
  provider: ContentProvider,
  budget: ManualProviderCallBudget,
  mode: 'generation' | 'rewrite',
): Promise<string> {
  budget.recordProviderCall();
  if (mode === 'rewrite') {
    return contentService.fetchComposerRewriteRaw(prompt, provider);
  }
  return contentService.fetchComposerGenerationRaw(prompt, provider);
}

/** Stage 1: combined angle, hook, and content-plan call. */
export async function invokeManualPlanningPrompt(
  contentService: ContentService,
  prompt: string,
  provider: ContentProvider,
  budget: ManualProviderCallBudget,
): Promise<ManualPlanningResult> {
  const raw = await fetchManualStageRaw(contentService, prompt, provider, budget, 'generation');
  return parseManualPlanningResult(raw);
}

/** Stage 2: draft-generation call bound to the selected plan. */
export async function invokeManualDraftPrompt(
  contentService: ContentService,
  prompt: string,
  provider: ContentProvider,
  budget: ManualProviderCallBudget,
): Promise<ManualGeneratedPost> {
  const raw = await fetchManualStageRaw(contentService, prompt, provider, budget, 'generation');
  const parsed = await parseManualProviderOutputWithRepair(contentService, raw, provider, prompt);
  return parsed;
}

/** Stage 3: critic and optional targeted revision call. */
export async function invokeManualCriticPrompt(
  contentService: ContentService,
  prompt: string,
  provider: ContentProvider,
  budget: ManualProviderCallBudget,
): Promise<string> {
  return fetchManualStageRaw(contentService, prompt, provider, budget, 'rewrite');
}

/** Legacy single-call manual generation kept for rewrite transport tests. */
export async function invokeManualGenerationPrompt(
  contentService: ContentService,
  prompt: string,
  provider: ContentProvider,
): Promise<ManualGeneratedPost> {
  const raw = await contentService.fetchComposerGenerationRaw(prompt, provider);
  const parsed = await parseManualProviderOutputWithRepair(contentService, raw, provider, prompt);
  return parsed;
}

/** Invoke manual-composer rewrite via manual-only schema parsing and JSON repair. */
export async function invokeManualRewritePrompt(
  contentService: ContentService,
  prompt: string,
  provider: ContentProvider,
): Promise<ManualGeneratedPost> {
  const raw = await contentService.fetchComposerRewriteRaw(prompt, provider);
  const parsed = await parseManualProviderOutputWithRepair(contentService, raw, provider, prompt);
  return parsed;
}
