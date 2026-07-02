import { prisma } from '../prismaClient';

export const MAX_BULK_DELETE_POSTS = 100;

export type BulkDeletePost = {
  id: string;
  userId: string;
  status: string;
  source: string;
};

export type InvalidBulkDeletePost = {
  id: string;
  reason: string;
};

export class BulkPostDeleteValidationError extends Error {
  readonly invalidPosts: InvalidBulkDeletePost[];

  constructor(invalidPosts: InvalidBulkDeletePost[]) {
    super('Some posts cannot be deleted');
    this.invalidPosts = invalidPosts;
  }
}

export function validateBulkDeletePosts(
  requestedPostIds: string[],
  posts: BulkDeletePost[],
): InvalidBulkDeletePost[] {
  const postsById = new Map(posts.map((post) => [post.id, post]));

  return requestedPostIds.flatMap((id) => {
    const post = postsById.get(id);
    if (!post) {
      return [{ id, reason: 'Post not found or does not belong to this user' }];
    }
    if (post.status === 'PUBLISHED') {
      return [{ id, reason: 'PUBLISHED posts cannot be deleted' }];
    }
    if (
      post.source === 'MANUAL' &&
      !['DRAFT', 'QUEUED', 'FAILED'].includes(post.status)
    ) {
      return [{ id, reason: `Manual posts with status ${post.status} cannot be deleted` }];
    }
    if (post.source === 'GOOGLE_SHEET') {
      return [{ id, reason: 'Google Sheets posts cannot be bulk deleted until sheet reconciliation is defined' }];
    }
    return [];
  });
}

export function parseBulkDeletePostIds(body: unknown): string[] {
  const postIds = (body as { postIds?: unknown } | null)?.postIds;
  if (!Array.isArray(postIds)) throw new Error('postIds must be an array');
  if (postIds.length === 0) throw new Error('postIds must not be empty');
  if (postIds.length > MAX_BULK_DELETE_POSTS) {
    throw new Error(`postIds cannot contain more than ${MAX_BULK_DELETE_POSTS} values`);
  }
  if (postIds.some((id) => typeof id !== 'string' || !id.trim())) {
    throw new Error('Every postId must be a non-empty string');
  }

  const normalizedPostIds = postIds.map((id) => (id as string).trim());
  if (new Set(normalizedPostIds).size !== normalizedPostIds.length) {
    throw new Error('postIds must contain unique values');
  }
  return normalizedPostIds;
}

const BULK_DELETE_POST_SELECT = {
  id: true,
  userId: true,
  status: true,
  source: true,
} as const;

export type BulkDeleteTransaction = {
  post: {
    findMany(args: unknown): Promise<BulkDeletePost[]>;
    delete(args: unknown): Promise<unknown>;
  };
  generatedTopicHistory: {
    updateMany(args: unknown): Promise<unknown>;
  };
};

export async function executeBulkPostDelete(
  tx: BulkDeleteTransaction,
  userId: string,
  postIds: string[],
) {
    const posts = await tx.post.findMany({
      where: { id: { in: postIds }, userId },
      select: BULK_DELETE_POST_SELECT,
    });
    const invalidPosts = validateBulkDeletePosts(postIds, posts);
    if (invalidPosts.length > 0) throw new BulkPostDeleteValidationError(invalidPosts);

    const generatedPostIds = posts
      .filter((post) => post.source === 'AI' || post.source === 'AI_TRENDING')
      .map((post) => post.id);
    if (generatedPostIds.length > 0) {
      await tx.generatedTopicHistory.updateMany({
        where: { postId: { in: generatedPostIds } },
        data: { status: 'REJECTED' },
      });
    }

    for (const postId of postIds) {
      await tx.post.delete({ where: { id: postId } });
    }

    return {
      deletedCount: postIds.length,
      deletedPostIds: postIds,
      deletedQueuedPostIds: posts
        .filter((post) => post.status === 'QUEUED')
        .map((post) => post.id),
    };
}

export async function bulkDeletePosts(userId: string, postIds: string[]) {
  return prisma.$transaction(async (tx) => {
    return executeBulkPostDelete(tx as unknown as BulkDeleteTransaction, userId, postIds);
  });
}
