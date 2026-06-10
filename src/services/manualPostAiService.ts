import {
  generateManualPostV2,
  rewriteSavedManualPostV2,
  rewriteUnsavedManualPostV2,
} from './manualPost/manualPostOrchestration';
import { ManualPostError } from './manualPostService';

export const MAX_MANUAL_TOPIC_LENGTH = 500;
export const MAX_ADDITIONAL_INSTRUCTIONS_LENGTH = 1000;
export const MAX_SUPPORTING_CONTEXT_LENGTH = 3000;
export const MAX_REWRITE_SUGGESTIONS_LENGTH = 1000;
export const MAX_REWRITE_CONTENT_LENGTH = 3000;

export type ContentProvider = 'OPENAI' | 'GEMINI';

export function parseContentProvider(raw: unknown): ContentProvider {
  if (raw === undefined || raw === null || raw === '') return 'OPENAI';
  if (typeof raw !== 'string') {
    throw new ManualPostError(400, 'Invalid provider; use OPENAI or GEMINI');
  }
  const normalized = raw.trim().toUpperCase();
  if (normalized === 'OPENAI' || normalized === 'GEMINI') return normalized;
  throw new ManualPostError(400, 'Invalid provider; use OPENAI or GEMINI');
}

export function validateGenerateInput(body: {
  topic?: unknown;
  additionalInstructions?: unknown;
  supportingContext?: unknown;
}): { topic: string; additionalInstructions?: string; supportingContext?: string } {
  const topic = typeof body.topic === 'string' ? body.topic.trim() : '';
  if (!topic) throw new ManualPostError(400, 'topic is required');
  if (topic.length > MAX_MANUAL_TOPIC_LENGTH) {
    throw new ManualPostError(400, `topic must be ${MAX_MANUAL_TOPIC_LENGTH} characters or fewer`);
  }

  let additionalInstructions: string | undefined;
  if (body.additionalInstructions !== undefined && body.additionalInstructions !== null) {
    if (typeof body.additionalInstructions !== 'string') {
      throw new ManualPostError(400, 'additionalInstructions must be a string');
    }
    additionalInstructions = body.additionalInstructions.trim();
    if (additionalInstructions.length > MAX_ADDITIONAL_INSTRUCTIONS_LENGTH) {
      throw new ManualPostError(
        400,
        `additionalInstructions must be ${MAX_ADDITIONAL_INSTRUCTIONS_LENGTH} characters or fewer`,
      );
    }
    if (!additionalInstructions) additionalInstructions = undefined;
  }

  let supportingContext: string | undefined;
  if (body.supportingContext !== undefined && body.supportingContext !== null) {
    if (typeof body.supportingContext !== 'string') {
      throw new ManualPostError(400, 'supportingContext must be a string');
    }
    supportingContext = body.supportingContext.trim();
    if (supportingContext.length > MAX_SUPPORTING_CONTEXT_LENGTH) {
      throw new ManualPostError(
        400,
        `supportingContext must be ${MAX_SUPPORTING_CONTEXT_LENGTH} characters or fewer`,
      );
    }
    if (!supportingContext) supportingContext = undefined;
  }

  return { topic, additionalInstructions, supportingContext };
}

export function validateUnsavedRewriteInput(body: {
  content?: unknown;
  suggestions?: unknown;
  topic?: unknown;
}): { content: string; suggestions: string; topic?: string } {
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content) throw new ManualPostError(400, 'content is required');
  if (content.length > MAX_REWRITE_CONTENT_LENGTH) {
    throw new ManualPostError(400, `content must be ${MAX_REWRITE_CONTENT_LENGTH} characters or fewer`);
  }

  const suggestions = typeof body.suggestions === 'string' ? body.suggestions.trim() : '';
  if (!suggestions) throw new ManualPostError(400, 'suggestions is required');
  if (suggestions.length > MAX_REWRITE_SUGGESTIONS_LENGTH) {
    throw new ManualPostError(
      400,
      `suggestions must be ${MAX_REWRITE_SUGGESTIONS_LENGTH} characters or fewer`,
    );
  }

  let topic: string | undefined;
  if (body.topic !== undefined && body.topic !== null) {
    if (typeof body.topic !== 'string') throw new ManualPostError(400, 'topic must be a string');
    topic = body.topic.trim() || undefined;
    if (topic && topic.length > MAX_MANUAL_TOPIC_LENGTH) {
      throw new ManualPostError(400, `topic must be ${MAX_MANUAL_TOPIC_LENGTH} characters or fewer`);
    }
  }

  return { content, suggestions, topic };
}

/** Route-facing alias — delegates to manual-only orchestration. */
export const generateManualPostContent = generateManualPostV2;

/** Route-facing alias — delegates to manual-only orchestration. */
export const rewriteUnsavedManualContent = rewriteUnsavedManualPostV2;

/** Route-facing alias — delegates to manual-only orchestration. */
export const rewriteSavedManualPost = rewriteSavedManualPostV2;
