import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import {
  ManualPostError,
  createDraft,
  updateManualPost,
  scheduleManualPost,
  publishManualPostNow,
  createAndPublishNow,
  createAndSchedule,
  listManualPosts,
  deleteManualPost,
  duplicateManualPost,
} from '../services/manualPostService';
import { PlanLimitError } from '../services/planEntitlementService';
import {
  generateManualPostContent,
  rewriteSavedManualPost,
  rewriteUnsavedManualContent,
} from '../services/manualPostAiService';

const router = Router();

// Resolve the authenticated user id, or throw a 401.
function requireUserId(req: Request): string {
  const userId = (req as any).userId as string | undefined;
  if (!userId) throw new ManualPostError(401, 'Unauthorized');
  return userId;
}

// Wrap a handler so ManualPostError -> proper status, anything else -> 500.
function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof PlanLimitError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof ManualPostError) {
        const body: Record<string, unknown> = { error: err.message };
        if (err.details !== undefined) body.entitlement = err.details;
        res.status(err.status).json(body);
        return;
      }
      console.error('[manual-posts] error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}

// AI: generate post content without saving.
router.post(
  '/generate',
  requireAuth,
  handle(async (req, res) => {
    const userId = requireUserId(req);
    const result = await generateManualPostContent(userId, req.body || {});
    res.json(result);
  }),
);

// AI: rewrite unsaved generated/edited content.
router.post(
  '/rewrite',
  requireAuth,
  handle(async (req, res) => {
    const userId = requireUserId(req);
    const result = await rewriteUnsavedManualContent(userId, req.body || {});
    res.json(result);
  }),
);

// 1. Create a manual draft.
router.post(
  '/drafts',
  requireAuth,
  handle(async (req, res) => {
    const userId = requireUserId(req);
    const post = await createDraft(userId, req.body || {});
    res.status(201).json(post);
  }),
);

// 5. Create + publish immediately.
router.post(
  '/publish-now',
  requireAuth,
  handle(async (req, res) => {
    const userId = requireUserId(req);
    const post = await createAndPublishNow(userId, req.body || {});
    res.json(post);
  }),
);

// 6. Create + schedule.
router.post(
  '/schedule',
  requireAuth,
  handle(async (req, res) => {
    const userId = requireUserId(req);
    const post = await createAndSchedule(userId, req.body || {});
    res.status(201).json(post);
  }),
);

// 7. List manual posts.
router.get(
  '/',
  requireAuth,
  handle(async (req, res) => {
    const userId = requireUserId(req);
    const { status, from, to } = req.query as { status?: string; from?: string; to?: string };
    const posts = await listManualPosts(userId, { status, from, to });
    res.json(posts);
  }),
);

// AI: rewrite a saved manual draft or scheduled post.
router.post(
  '/:postId/rewrite',
  requireAuth,
  handle(async (req, res) => {
    const userId = requireUserId(req);
    const post = await rewriteSavedManualPost(userId, req.params.postId, req.body || {});
    res.json(post);
  }),
);

// 4. Publish an existing post now.
router.post(
  '/:postId/publish-now',
  requireAuth,
  handle(async (req, res) => {
    const userId = requireUserId(req);
    const post = await publishManualPostNow(userId, req.params.postId);
    res.json(post);
  }),
);

// 3. Schedule an existing post.
router.post(
  '/:postId/schedule',
  requireAuth,
  handle(async (req, res) => {
    const userId = requireUserId(req);
    const post = await scheduleManualPost(userId, req.params.postId, req.body?.scheduledAt);
    res.json(post);
  }),
);

// 9. Duplicate a post into a new draft.
router.post(
  '/:postId/duplicate',
  requireAuth,
  handle(async (req, res) => {
    const userId = requireUserId(req);
    const post = await duplicateManualPost(userId, req.params.postId);
    res.status(201).json(post);
  }),
);

// 2. Update a draft / scheduled post.
router.patch(
  '/:postId',
  requireAuth,
  handle(async (req, res) => {
    const userId = requireUserId(req);
    const post = await updateManualPost(userId, req.params.postId, req.body || {});
    res.json(post);
  }),
);

// 8. Delete a draft / scheduled / failed post.
router.delete(
  '/:postId',
  requireAuth,
  handle(async (req, res) => {
    const userId = requireUserId(req);
    const result = await deleteManualPost(userId, req.params.postId);
    res.json(result);
  }),
);

export default router;
