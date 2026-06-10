import { MANUAL_SOURCE } from '../manualPostService';

/** Batch / bot post sources — never used as voice samples. */
export const BATCH_POST_SOURCES = new Set(['AI', 'AI_TRENDING', 'GOOGLE_SHEET']);

export type VoiceSamplePost = {
  id: string;
  userId: string;
  source: string;
  status: string;
  content: string;
  hashtags: string | null;
  manualTopic: string | null;
  aiGenerated: boolean;
  rewriteCount: number;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type VoiceSampleOrigin =
  | 'fully_manual'
  | 'edited_ai_assisted'
  | 'published_manual'
  | 'edited_draft_fallback';

const MIN_SAMPLE_CONTENT_LENGTH = 80;
const USER_EDIT_WINDOW_MS = 5 * 60 * 1000;

export function isBatchPostSource(source: string): boolean {
  return BATCH_POST_SOURCES.has(source) || source !== MANUAL_SOURCE;
}

export function isManualPostSource(source: string): boolean {
  return source === MANUAL_SOURCE;
}

/**
 * Without AiGeneration.initialContent / PostRevision snapshots, treat freshly
 * saved AI output as unedited. AiGeneration hooks can extend this later.
 */
export function isUneditedAiOutput(post: Pick<VoiceSamplePost, 'aiGenerated' | 'rewriteCount' | 'createdAt' | 'updatedAt'>): boolean {
  if (!post.aiGenerated) return false;
  if (post.rewriteCount > 0) return false;

  const editWindowMs = post.updatedAt.getTime() - post.createdAt.getTime();
  return editWindowMs < USER_EDIT_WINDOW_MS;
}

/**
 * Post-only heuristic for meaningful user editing on AI-assisted manual posts.
 * Requires time in editor and excludes AI-only rewrite rounds as voice evidence.
 */
export function hasSubstantialUserEditing(post: VoiceSamplePost): boolean {
  if (!post.aiGenerated) return true;

  const editWindowMs = post.updatedAt.getTime() - post.createdAt.getTime();
  if (editWindowMs < USER_EDIT_WINDOW_MS) return false;

  // rewriteCount tracks AI rewrite operations, not user voice — still allow
  // published posts that were polished in the composer after generation.
  if (post.status === 'PUBLISHED' && post.publishedAt) return true;

  // Strongly edited drafts when insufficient published samples exist.
  if (post.status === 'DRAFT' && editWindowMs >= USER_EDIT_WINDOW_MS * 2) {
    return true;
  }

  return false;
}

export function classifyVoiceSampleOrigin(post: VoiceSamplePost): VoiceSampleOrigin | null {
  if (!isManualPostSource(post.source)) return null;
  if (isUneditedAiOutput(post)) return null;
  if (!post.content.trim() || post.content.trim().length < MIN_SAMPLE_CONTENT_LENGTH) return null;

  if (!post.aiGenerated) {
    return post.status === 'PUBLISHED' ? 'published_manual' : 'fully_manual';
  }

  if (!hasSubstantialUserEditing(post)) return null;
  if (post.status === 'PUBLISHED') return 'published_manual';
  return post.status === 'DRAFT' ? 'edited_draft_fallback' : 'edited_ai_assisted';
}

export function isEligibleVoiceSample(post: VoiceSamplePost): boolean {
  return classifyVoiceSampleOrigin(post) !== null;
}
