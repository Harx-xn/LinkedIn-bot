import { prisma } from '../prismaClient';
import { TOPIC_DIVERSITY_CONFIG } from '../config/topicDiversityConfig';
import type { PostAngle, TopicFingerprint, TopicHistoryStatus } from './generationTypes';

export type TopicHistoryRow = {
  id: string;
  userId: string;
  postId: string | null;
  batchId: string | null;
  sourceTitle: string | null;
  normalizedTopic: string;
  topicCluster: string;
  coreClaim: string | null;
  angle: string | null;
  status: TopicHistoryStatus;
  generatedAt: Date;
  publishedAt: Date | null;
};

export async function loadRecentTopicHistory(
  userId: string,
  now: Date = new Date(),
): Promise<TopicHistoryRow[]> {
  const since = new Date(now);
  since.setDate(since.getDate() - TOPIC_DIVERSITY_CONFIG.historyLookbackDays);

  const rows = await prisma.generatedTopicHistory.findMany({
    where: {
      userId,
      generatedAt: { gte: since },
    },
    orderBy: { generatedAt: 'desc' },
    take: 200,
  });

  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    postId: r.postId,
    batchId: r.batchId,
    sourceTitle: r.sourceTitle,
    normalizedTopic: r.normalizedTopic,
    topicCluster: r.topicCluster,
    coreClaim: r.coreClaim,
    angle: r.angle,
    status: r.status as TopicHistoryStatus,
    generatedAt: r.generatedAt,
    publishedAt: r.publishedAt,
  }));
}

export async function createGeneratedTopicHistory(input: {
  userId: string;
  postId?: string;
  batchId?: string;
  sourceTitle?: string;
  fingerprint: TopicFingerprint;
  angle?: PostAngle;
  knownNewPost?: boolean;
}): Promise<void> {
  if (!input.postId) return;

  if (!input.knownNewPost) {
    const existing = await prisma.generatedTopicHistory.findFirst({
      where: { postId: input.postId },
    });
    if (existing) return;
  }

  await prisma.generatedTopicHistory.create({
    data: {
      userId: input.userId,
      postId: input.postId,
      batchId: input.batchId ?? null,
      sourceTitle: input.sourceTitle ?? null,
      normalizedTopic: input.fingerprint.normalizedTopic,
      topicCluster: input.fingerprint.topicCluster,
      coreClaim: input.fingerprint.coreClaim,
      angle: input.angle ?? null,
      status: 'GENERATED',
    },
  });
}

export async function updateTopicHistoryStatus(
  postId: string,
  status: TopicHistoryStatus,
  publishedAt?: Date,
): Promise<void> {
  try {
    const row = await prisma.generatedTopicHistory.findFirst({ where: { postId } });
    if (!row) return;

    await prisma.generatedTopicHistory.update({
      where: { id: row.id },
      data: {
        status,
        ...(publishedAt ? { publishedAt } : {}),
      },
    });
  } catch (err) {
    console.warn('[topic-history] status update failed', {
      postId,
      status,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function safeUpdateTopicHistoryStatus(
  postId: string | null | undefined,
  status: TopicHistoryStatus,
  publishedAt?: Date,
): Promise<void> {
  if (!postId) return;
  await updateTopicHistoryStatus(postId, status, publishedAt);
}
