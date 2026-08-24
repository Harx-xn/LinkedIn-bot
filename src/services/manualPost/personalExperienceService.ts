import { prisma } from '../../prismaClient';
import { ManualPostError } from '../manualPostService';

export const MAX_PERSONAL_EXPERIENCE_LENGTH = 4000;
export const MAX_EXPERIENCE_SUGGESTIONS = 4;

export type PersonalExperienceInput = {
  savedExperienceId?: string;
  rawText?: string;
  save?: boolean;
};

export type ResolvedPersonalExperience = {
  id?: string;
  rawText: string;
  title?: string | null;
  source: 'USER_SUPPLIED';
};

const STOP_WORDS = new Set('a an and are as at be been but by can did do does for from had has have i if in into is it its me my of on or our that the their them then these they this to was we were what when which while will with you your'.split(' '));

function tokens(value: string): string[] {
  return [...new Set((value.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token))
    .map((token) => token.replace(/(?:ing|ed|es|s)$/i, ''))
    .filter((token) => token.length > 2))];
}

export function experienceTopicSimilarity(topic: string, experience: string): number {
  const topicTokens = tokens(topic);
  const experienceTokens = new Set(tokens(experience));
  if (!topicTokens.length || !experienceTokens.size) return 0;
  const overlap = topicTokens.filter((token) => experienceTokens.has(token)).length;
  return overlap / Math.max(2, Math.min(topicTokens.length, experienceTokens.size));
}

export function classifyExperienceRelevance(topic: string, experience?: string): 'HIGH' | 'MEDIUM' | 'LOW' {
  if (!experience?.trim()) return 'LOW';
  const similarity = experienceTopicSimilarity(topic, experience);
  if (similarity >= .45) return 'HIGH';
  if (similarity >= .15) return 'MEDIUM';
  return 'LOW';
}

function deriveTitle(rawText: string): string {
  const firstSentence = rawText.split(/(?<=[.!?])\s+|\n/).map((part) => part.trim()).find(Boolean) ?? rawText;
  return firstSentence.slice(0, 120);
}

function deriveTopics(rawText: string): string[] {
  return tokens(rawText).slice(0, 12);
}

export function validatePersonalExperienceInput(raw: unknown): PersonalExperienceInput | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ManualPostError(400, 'personalExperience must be an object');
  const input = raw as Record<string, unknown>;
  const savedExperienceId = typeof input.savedExperienceId === 'string' ? input.savedExperienceId.trim() : '';
  const rawText = typeof input.rawText === 'string' ? input.rawText.trim() : '';
  if (savedExperienceId && rawText) throw new ManualPostError(400, 'Choose a saved experience or provide a new one, not both');
  if (!savedExperienceId && !rawText) return undefined;
  if (rawText.length > MAX_PERSONAL_EXPERIENCE_LENGTH) throw new ManualPostError(400, `personal experience must be ${MAX_PERSONAL_EXPERIENCE_LENGTH} characters or fewer`);
  return { ...(savedExperienceId ? { savedExperienceId } : {}), ...(rawText ? { rawText } : {}), save: input.save === true };
}

export async function savePersonalExperience(userId: string, rawText: string): Promise<ResolvedPersonalExperience> {
  const text = rawText.trim();
  if (!text) throw new ManualPostError(400, 'Personal experience is required');
  if (text.length > MAX_PERSONAL_EXPERIENCE_LENGTH) throw new ManualPostError(400, `personal experience must be ${MAX_PERSONAL_EXPERIENCE_LENGTH} characters or fewer`);
  const existing = await prisma.personalExperience.findFirst({ where: { userId, rawText: text, source: 'USER_SUPPLIED' } });
  const record = existing ?? await prisma.personalExperience.create({
    data: { userId, rawText: text, title: deriveTitle(text), summary: deriveTitle(text), topics: deriveTopics(text), source: 'USER_SUPPLIED' },
  });
  return { id: record.id, rawText: record.rawText, title: record.title, source: 'USER_SUPPLIED' };
}

export async function resolvePersonalExperience(
  userId: string,
  input?: PersonalExperienceInput,
): Promise<ResolvedPersonalExperience | undefined> {
  if (!input) return undefined;
  if (input.savedExperienceId) {
    const record = await prisma.personalExperience.findFirst({ where: { id: input.savedExperienceId, userId, source: 'USER_SUPPLIED' } });
    if (!record) throw new ManualPostError(404, 'Saved personal experience not found');
    return { id: record.id, rawText: record.rawText, title: record.title, source: 'USER_SUPPLIED' };
  }
  if (!input.rawText) return undefined;
  if (input.save) return savePersonalExperience(userId, input.rawText);
  return { rawText: input.rawText, title: deriveTitle(input.rawText), source: 'USER_SUPPLIED' };
}

function jsonText(value: unknown): string {
  if (!value) return '';
  if (Array.isArray(value)) return value.map(String).join(' ');
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).map(String).join(' ');
  return String(value);
}

export type PersonalExperienceRetrievalRecord = {
  id: string;
  title: string | null;
  rawText: string;
  summary: string | null;
  topics: unknown;
  lessons: unknown;
  outcomes: unknown;
  source: 'USER_SUPPLIED' | 'PROFILE_DERIVED' | 'POST_DERIVED';
  usageCount: number;
  lastUsedAt: Date | null;
};

export function rankPersonalExperienceSuggestions(
  records: PersonalExperienceRetrievalRecord[],
  topic: string,
  limit = 3,
  now = Date.now(),
) {
  const boundedLimit = Math.max(1, Math.min(MAX_EXPERIENCE_SUGGESTIONS, limit));
  return records.map((record) => {
    const searchable = [record.title, record.summary, record.rawText, jsonText(record.topics), jsonText(record.lessons), jsonText(record.outcomes)].filter(Boolean).join(' ');
    const relevance = experienceTopicSimilarity(topic, searchable);
    const reusePenalty = Math.min(.35, record.usageCount * .06);
    const recentUsePenalty = record.lastUsedAt && now - record.lastUsedAt.getTime() < 30 * 86_400_000 ? .18 : 0;
    return { record, relevance, reusePenalty, score: relevance - reusePenalty - recentUsePenalty };
  }).filter((item) => item.relevance >= .12)
    .sort((a, b) => b.score - a.score || b.relevance - a.relevance)
    .slice(0, boundedLimit)
    .map(({ record, relevance, reusePenalty }) => ({
      id: record.id, title: record.title, rawText: record.rawText, summary: record.summary,
      source: record.source, usageCount: record.usageCount, lastUsedAt: record.lastUsedAt,
      relevanceScore: Math.round(relevance * 100), reusePenalty: Math.round(reusePenalty * 100),
    }));
}

export async function suggestPersonalExperiences(userId: string, topic: string, limit = 3) {
  const records = await prisma.personalExperience.findMany({
    where: { userId, source: 'USER_SUPPLIED' }, orderBy: { updatedAt: 'desc' }, take: 50,
  });
  return rankPersonalExperienceSuggestions(records, topic, limit);
}

export async function markPersonalExperienceUsed(userId: string, experienceId: string): Promise<void> {
  await prisma.personalExperience.updateMany({
    where: { id: experienceId, userId, source: 'USER_SUPPLIED' },
    data: { usageCount: { increment: 1 }, lastUsedAt: new Date() },
  });
}

const FIRST_PERSON = /\b(?:I|I'm|I've|I'd|my|me|we|we've|our)\b/i;

export function personalExperienceWasUsed(content: string, experience: string, relevance: 'HIGH' | 'MEDIUM' | 'LOW'): boolean {
  if (relevance === 'LOW' || !FIRST_PERSON.test(content)) return false;
  return experienceTopicSimilarity(experience, content) >= .12;
}

/** Removes sentences containing numbers absent from all explicitly supplied manual evidence. */
export function enforcePersonalExperienceNumberBoundary(content: string, allowedEvidence: string): string {
  const allowedNumbers = new Set(allowedEvidence.match(/\b\d+(?:[.,]\d+)?%?\b/g) ?? []);
  const blocks = content.split(/(\n+)/);
  return blocks.map((block) => {
    if (/^\n+$/.test(block)) return block;
    const sentences = block.split(/(?<=[.!?])\s+/);
    return sentences.filter((sentence) => {
      const numbers = sentence.match(/\b\d+(?:[.,]\d+)?%?\b/g) ?? [];
      return numbers.every((number) => allowedNumbers.has(number));
    }).join(' ');
  }).join('').replace(/\n{3,}/g, '\n\n').trim();
}
