import { Prisma } from '@prisma/client';
import { prisma } from '../../prismaClient';
import { MANUAL_SOURCE } from '../manualPostService';
import { tokenJaccardSimilarity } from '../deterministicTrendFingerprint';

export const FINGERPRINT_LOOKBACK_DAYS = 90;
export const FINGERPRINT_MIN_LOOKBACK_DAYS = 30;
export const CORE_CLAIM_REPEAT_THRESHOLD = 0.72;
export const CORE_CLAIM_REJECT_THRESHOLD = 0.78;

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'for', 'in', 'on', 'with', 'that', 'this', 'your', 'from',
]);

export type ExtractedManualFingerprint = {
  primaryTopic: string;
  subtopic: string | null;
  coreClaim: string;
  structure: string | null;
  hookType: string | null;
  evidenceType: string | null;
  ctaType: string | null;
  keywords: string[];
};

export type ManualPostFingerprintRecord = {
  id: string;
  postId: string;
  userId: string;
  primaryTopic: string;
  subtopic: string | null;
  coreClaim: string;
  structure: string | null;
  hookType: string | null;
  evidenceType: string | null;
  ctaType: string | null;
  keywords: string[];
  createdAt: Date;
};

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function splitParagraphs(content: string): string[] {
  return content
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function splitLines(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function extractKeywords(text: string, limit = 12): string[] {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 3 && !STOP_WORDS.has(token));

  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([token]) => token);
}

function classifyHookType(firstLine: string): string {
  const line = firstLine.trim();
  if (!line) return 'unknown';
  if (line.endsWith('?')) return 'question_hook';
  if (/^(most|many|few|every)\b/i.test(line)) return 'observation_hook';
  if (/\b(should|must|avoid|stop|don't|do not)\b/i.test(line)) return 'contrarian_hook';
  if (/\b(here(?:'s| is)|the problem|the issue)\b/i.test(line)) return 'problem_statement';
  return 'specific_observation';
}

function classifyEvidenceType(content: string): string {
  if (/\bconsider a\b|\bhypothetical\b|\bimagine\b/i.test(content)) return 'labeled_hypothetical';
  if (/\b(i|we|my team|our team)\b/i.test(content)) return 'supplied_experience';
  if (/\b(for example|such as|e\.g\.)\b/i.test(content)) return 'technical_example';
  return 'reasoned_observation';
}

function classifyCtaType(closingLine: string): string {
  const line = closingLine.trim();
  if (!line) return 'none';
  if (line.endsWith('?')) return 'engagement_question';
  if (/\b(takeaway|lesson|implication|result)\b/i.test(line)) return 'takeaway';
  return 'closing_takeaway';
}

function classifyStructure(content: string): string {
  const lines = splitLines(content);
  const bulletCount = lines.filter((line) => /^[-•*]\s+/.test(line)).length;
  if (bulletCount >= 3) return 'hook_bullets_close';
  if (content.includes('→')) return 'hook_problem_mechanism_close';
  const paragraphs = splitParagraphs(content);
  if (paragraphs.length >= 4) return 'multi_paragraph_argument';
  return 'hook_body_close';
}

function pickCoreClaim(content: string, manualTopic?: string | null): string {
  const paragraphs = splitParagraphs(content);
  const candidates = paragraphs
    .flatMap((paragraph) => paragraph.split(/(?<=[.!?])\s+/))
    .map(normalizeText)
    .filter((sentence) => sentence.length >= 40);

  const scored = candidates
    .map((sentence) => {
      let score = sentence.length;
      if (/\b(because|should|must|means|requires|prevents)\b/i.test(sentence)) score += 30;
      if (manualTopic && tokenJaccardSimilarity(sentence, manualTopic) > 0.2) score += 20;
      return { sentence, score };
    })
    .sort((a, b) => b.score - a.score);

  if (scored[0]?.sentence) return scored[0].sentence.slice(0, 500);

  const fallback = manualTopic?.trim() || splitLines(content)[0] || 'Manual LinkedIn post';
  return fallback.slice(0, 500);
}

function pickPrimaryTopic(manualTopic: string | null | undefined, content: string): string {
  if (manualTopic?.trim()) return manualTopic.trim().slice(0, 200);
  const firstLine = splitLines(content)[0] ?? 'LinkedIn post';
  return firstLine.slice(0, 200);
}

function pickSubtopic(keywords: string[], primaryTopic: string): string | null {
  const primaryTokens = new Set(primaryTopic.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const candidate = keywords.find((keyword) => !primaryTokens.has(keyword));
  return candidate ?? null;
}

export function extractManualPostFingerprint(input: {
  content: string;
  manualTopic?: string | null;
  hashtags?: string | null;
}): ExtractedManualFingerprint | null {
  const content = normalizeText(input.content.replace(/\n{3,}/g, '\n\n'));
  if (!content || content.length < 40) return null;

  const lines = splitLines(content);
  const firstLine = lines[0] ?? '';
  const closingLine = lines[lines.length - 1] ?? '';
  const keywords = extractKeywords(`${content} ${input.hashtags ?? ''}`);
  const primaryTopic = pickPrimaryTopic(input.manualTopic, content);

  return {
    primaryTopic,
    subtopic: pickSubtopic(keywords, primaryTopic),
    coreClaim: pickCoreClaim(content, input.manualTopic),
    structure: classifyStructure(content),
    hookType: classifyHookType(firstLine),
    evidenceType: classifyEvidenceType(content),
    ctaType: classifyCtaType(closingLine),
    keywords,
  };
}

export function calculateFingerprintSimilarity(
  candidate: {
    coreClaim: string;
    structure?: string | null;
    hookType?: string | null;
    evidenceType?: string | null;
    ctaType?: string | null;
    primaryTopic?: string | null;
  },
  existing: Pick<
    ManualPostFingerprintRecord,
    'coreClaim' | 'structure' | 'hookType' | 'evidenceType' | 'ctaType' | 'primaryTopic'
  >,
): {
  score: number;
  coreClaimSimilarity: number;
  primaryTopicSimilarity: number;
  reasons: string[];
} {
  const reasons: string[] = [];
  const coreClaimSimilarity = tokenJaccardSimilarity(candidate.coreClaim, existing.coreClaim);
  const primaryTopicSimilarity = tokenJaccardSimilarity(
    candidate.primaryTopic ?? candidate.coreClaim,
    existing.primaryTopic,
  );

  let score = coreClaimSimilarity;

  if (candidate.hookType && existing.hookType && candidate.hookType === existing.hookType) {
    score += 0.12;
    reasons.push('repeated_hook_type');
  }
  if (candidate.structure && existing.structure && candidate.structure === existing.structure) {
    score += 0.1;
    reasons.push('repeated_structure');
  }
  if (candidate.evidenceType && existing.evidenceType && candidate.evidenceType === existing.evidenceType) {
    score += 0.08;
    reasons.push('repeated_evidence_style');
  }
  if (candidate.ctaType && existing.ctaType && candidate.ctaType === existing.ctaType) {
    score += 0.08;
    reasons.push('repeated_closing_style');
  }

  if (coreClaimSimilarity >= CORE_CLAIM_REPEAT_THRESHOLD) {
    reasons.push('repeated_core_claim');
  }

  return {
    score: Math.min(1, score),
    coreClaimSimilarity,
    primaryTopicSimilarity,
    reasons,
  };
}

function mapFingerprintRow(row: {
  id: string;
  postId: string;
  userId: string;
  primaryTopic: string;
  subtopic: string | null;
  coreClaim: string;
  structure: string | null;
  hookType: string | null;
  evidenceType: string | null;
  ctaType: string | null;
  keywords: unknown;
  createdAt: Date;
}): ManualPostFingerprintRecord {
  return {
    ...row,
    keywords: Array.isArray(row.keywords) ? row.keywords.map(String) : [],
  };
}

export async function saveManualPostFingerprint(
  userId: string,
  postId: string,
  extracted: ExtractedManualFingerprint,
): Promise<void> {
  const keywordsJson = extracted.keywords as Prisma.InputJsonValue;

  await prisma.postContentFingerprint.upsert({
    where: { postId },
    create: {
      postId,
      userId,
      primaryTopic: extracted.primaryTopic,
      subtopic: extracted.subtopic,
      coreClaim: extracted.coreClaim,
      structure: extracted.structure,
      hookType: extracted.hookType,
      evidenceType: extracted.evidenceType,
      ctaType: extracted.ctaType,
      keywords: keywordsJson,
    },
    update: {
      userId,
      primaryTopic: extracted.primaryTopic,
      subtopic: extracted.subtopic,
      coreClaim: extracted.coreClaim,
      structure: extracted.structure,
      hookType: extracted.hookType,
      evidenceType: extracted.evidenceType,
      ctaType: extracted.ctaType,
      keywords: keywordsJson,
    },
  });
}

export async function getRecentManualFingerprints(
  userId: string,
  lookbackDays = FINGERPRINT_LOOKBACK_DAYS,
): Promise<ManualPostFingerprintRecord[]> {
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const rows = await prisma.postContentFingerprint.findMany({
    where: {
      userId,
      createdAt: { gte: since },
    },
    orderBy: { createdAt: 'desc' },
    take: 60,
  });

  return rows.map(mapFingerprintRow);
}

export async function syncManualPostFingerprint(postId: string, userId: string): Promise<void> {
  const post = await prisma.post.findFirst({
    where: { id: postId, userId, source: MANUAL_SOURCE },
    select: {
      id: true,
      userId: true,
      source: true,
      content: true,
      manualTopic: true,
      hashtags: true,
    },
  });

  if (!post) return;

  const extracted = extractManualPostFingerprint({
    content: post.content,
    manualTopic: post.manualTopic,
    hashtags: post.hashtags,
  });

  if (!extracted) {
    console.warn('[manual-fingerprint] extraction skipped', { postId, userId });
    return;
  }

  await saveManualPostFingerprint(userId, postId, extracted);
}

/** Fire-and-forget fingerprint sync; never throws to callers. */
export function scheduleManualPostFingerprintSync(postId: string, userId: string): void {
  void syncManualPostFingerprint(postId, userId).catch((error) => {
    console.warn('[manual-fingerprint] sync failed', {
      postId,
      userId,
      message: error instanceof Error ? error.message : String(error),
    });
  });
}

export function isBroadTopicAllowed(
  candidateTopic: string,
  existingTopic: string,
  coreClaimSimilarity: number,
): boolean {
  const topicSimilarity = tokenJaccardSimilarity(candidateTopic, existingTopic);
  return topicSimilarity >= 0.45 && coreClaimSimilarity < CORE_CLAIM_REPEAT_THRESHOLD;
}
