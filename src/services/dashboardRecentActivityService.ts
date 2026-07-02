import { prisma } from '../prismaClient';

export type DashboardRecentActivity = {
  id: string;
  type: 'POST_PUBLISHED' | 'POST_SCHEDULED' | 'BATCH_GENERATION' | 'IMAGE_GENERATED' | 'MANUAL_AI_OPERATION';
  title: string;
  description?: string;
  status?: string;
  createdAt: string;
};

const ACTIVITY_LIMIT = 8;

function summarizePost(content: string): string | undefined {
  const compact = content.replace(/\s+/g, ' ').trim();
  if (!compact) return undefined;
  return compact.length > 100 ? `${compact.slice(0, 97)}...` : compact;
}

export async function getRecentDashboardActivity(
  userId: string,
  db: Pick<
    typeof prisma,
    'post' | 'botGenerationJob' | 'imageGenerationUsage' | 'manualAiRewriteUsage'
  > = prisma,
): Promise<DashboardRecentActivity[]> {
  const [publishedPosts, scheduledPosts, batchJobs, imageUsages, manualAiUsages] =
    await Promise.all([
      db.post.findMany({
        where: { userId, status: 'PUBLISHED', publishedAt: { not: null } },
        orderBy: { publishedAt: 'desc' },
        take: ACTIVITY_LIMIT,
        select: { id: true, content: true, publishedAt: true },
      }),
      db.post.findMany({
        where: { userId, status: 'QUEUED', scheduledAt: { not: null } },
        orderBy: { updatedAt: 'desc' },
        take: ACTIVITY_LIMIT,
        select: { id: true, content: true, scheduledAt: true, updatedAt: true },
      }),
      db.botGenerationJob.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: ACTIVITY_LIMIT,
        select: {
          id: true,
          status: true,
          createdAt: true,
          completedSlots: true,
          totalSlots: true,
        },
      }),
      db.imageGenerationUsage.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: ACTIVITY_LIMIT,
        select: { id: true, createdAt: true },
      }),
      db.manualAiRewriteUsage.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: ACTIVITY_LIMIT,
        select: { id: true, kind: true, createdAt: true },
      }),
    ]);

  const activities: DashboardRecentActivity[] = [
    ...publishedPosts.flatMap((post) =>
      post.publishedAt
        ? [{
            id: `published-${post.id}`,
            type: 'POST_PUBLISHED' as const,
            title: 'Post published',
            description: summarizePost(post.content),
            status: 'Published',
            createdAt: post.publishedAt.toISOString(),
          }]
        : [],
    ),
    ...scheduledPosts.map((post) => ({
      id: `scheduled-${post.id}`,
      type: 'POST_SCHEDULED' as const,
      title: 'Post scheduled',
      description: summarizePost(post.content),
      status: 'Scheduled',
      createdAt: post.updatedAt.toISOString(),
    })),
    ...batchJobs.map((job) => ({
      id: `batch-${job.id}`,
      type: 'BATCH_GENERATION' as const,
      title: 'Batch generation created',
      description: `${job.completedSlots} of ${job.totalSlots} slots completed`,
      status: job.status,
      createdAt: job.createdAt.toISOString(),
    })),
    ...imageUsages.map((usage) => ({
      id: `image-${usage.id}`,
      type: 'IMAGE_GENERATED' as const,
      title: 'Image generated',
      status: 'Completed',
      createdAt: usage.createdAt.toISOString(),
    })),
    ...manualAiUsages.map((usage) => ({
      id: `manual-ai-${usage.id}`,
      type: 'MANUAL_AI_OPERATION' as const,
      title:
        usage.kind === 'rewrite_unsaved'
          ? 'Manual AI rewrite used'
          : 'Manual AI post generated',
      status: 'Completed',
      createdAt: usage.createdAt.toISOString(),
    })),
  ];

  return activities
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, ACTIVITY_LIMIT);
}
