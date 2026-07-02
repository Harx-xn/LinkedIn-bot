import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_BULK_DELETE_POSTS,
  BulkPostDeleteValidationError,
  executeBulkPostDelete,
  parseBulkDeletePostIds,
  validateBulkDeletePosts,
  type BulkDeleteTransaction,
  type BulkDeletePost,
} from './bulkPostDeleteService';

function post(id: string, status: string, source = 'AI'): BulkDeletePost {
  return { id, status, source, userId: 'user-1' };
}

describe('bulk post delete validation', () => {
  it('accepts multiple REVIEW, DRAFT, and FAILED posts', () => {
    assert.deepEqual(validateBulkDeletePosts(['review', 'draft', 'failed'], [
      post('review', 'REVIEW'), post('draft', 'DRAFT'), post('failed', 'FAILED'),
    ]), []);
  });

  it('accepts QUEUED posts', () => {
    assert.deepEqual(validateBulkDeletePosts(['queued'], [post('queued', 'QUEUED')]), []);
  });

  it('preserves the manual-post status allowlist', () => {
    assert.deepEqual(validateBulkDeletePosts(
      ['manual-review'],
      [post('manual-review', 'REVIEW', 'MANUAL')],
    ), [
      { id: 'manual-review', reason: 'Manual posts with status REVIEW cannot be deleted' },
    ]);
  });

  it('blocks PUBLISHED posts', () => {
    assert.deepEqual(validateBulkDeletePosts(['published'], [post('published', 'PUBLISHED')]), [
      { id: 'published', reason: 'PUBLISHED posts cannot be deleted' },
    ]);
  });

  it('blocks missing or cross-user IDs without revealing which case applies', () => {
    assert.deepEqual(validateBulkDeletePosts(['other-user'], []), [
      { id: 'other-user', reason: 'Post not found or does not belong to this user' },
    ]);
  });

  it('reports every invalid post in a mixed batch', () => {
    assert.deepEqual(validateBulkDeletePosts(
      ['draft', 'published', 'missing', 'sheet'],
      [post('draft', 'DRAFT'), post('published', 'PUBLISHED'), post('sheet', 'DRAFT', 'GOOGLE_SHEET')],
    ), [
      { id: 'published', reason: 'PUBLISHED posts cannot be deleted' },
      { id: 'missing', reason: 'Post not found or does not belong to this user' },
      { id: 'sheet', reason: 'Google Sheets posts cannot be bulk deleted until sheet reconciliation is defined' },
    ]);
  });

  it('requires a non-empty, unique, bounded string array', () => {
    assert.throws(() => parseBulkDeletePostIds(null), /must be an array/);
    assert.throws(() => parseBulkDeletePostIds({ postIds: [] }), /must not be empty/);
    assert.throws(() => parseBulkDeletePostIds({ postIds: ['one', 'one'] }), /unique/);
    assert.throws(() => parseBulkDeletePostIds({ postIds: [''] }), /non-empty string/);
    assert.throws(() => parseBulkDeletePostIds({
      postIds: Array.from({ length: MAX_BULK_DELETE_POSTS + 1 }, (_, i) => `${i}`),
    }), /more than 100/);
  });

  it('marks generated topic history REJECTED and reports deleted queued IDs', async () => {
    const deletedIds: string[] = [];
    const topicHistoryCalls: unknown[] = [];
    const tx: BulkDeleteTransaction = {
      post: {
        findMany: async () => [post('review', 'REVIEW'), post('queued', 'QUEUED')],
        delete: async (args) => {
          deletedIds.push((args as { where: { id: string } }).where.id);
          return {};
        },
      },
      generatedTopicHistory: {
        updateMany: async (args) => {
          topicHistoryCalls.push(args);
          return { count: 2 };
        },
      },
    };

    const result = await executeBulkPostDelete(tx, 'user-1', ['review', 'queued']);
    assert.deepEqual(result, {
      deletedCount: 2,
      deletedPostIds: ['review', 'queued'],
      deletedQueuedPostIds: ['queued'],
    });
    assert.deepEqual(deletedIds, ['review', 'queued']);
    assert.deepEqual(topicHistoryCalls, [{
      where: { postId: { in: ['review', 'queued'] } },
      data: { status: 'REJECTED' },
    }]);
  });

  it('does not perform side effects when a mixed batch is invalid', async () => {
    let deleteCalls = 0;
    let topicHistoryCalls = 0;
    const tx: BulkDeleteTransaction = {
      post: {
        findMany: async () => [post('draft', 'DRAFT'), post('published', 'PUBLISHED')],
        delete: async () => { deleteCalls += 1; return {}; },
      },
      generatedTopicHistory: {
        updateMany: async () => { topicHistoryCalls += 1; return { count: 0 }; },
      },
    };

    await assert.rejects(
      executeBulkPostDelete(tx, 'user-1', ['draft', 'published']),
      BulkPostDeleteValidationError,
    );
    assert.equal(deleteCalls, 0);
    assert.equal(topicHistoryCalls, 0);
  });
});
