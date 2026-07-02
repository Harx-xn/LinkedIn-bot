import { prisma } from '../prismaClient';
import { canPublish } from './entitlementService';
import {
  getUsableLinkedInAccountForUser,
  postToLinkedInFromPostId,
} from './linkedinService';
import { canPublishToLinkedIn } from './planEntitlementService';
import { scheduleManualPostFingerprintSync } from './manualPost/manualPostFingerprintService';

/**
 * Manual Posts / Composer service (Taplio-like).
 *
 * Lets a user write, save, schedule, publish, edit, and delete their own
 * LinkedIn posts. It reuses the EXISTING Post table, LinkedIn publishing
 * service, scheduler, and entitlement logic — nothing is duplicated and the
 * bot-generation flow is untouched.
 *
 * Key compatibility notes for this codebase:
 *  - Manual posts are marked with the existing `Post.source = "MANUAL"`.
 *  - The "scheduled" state maps to the existing status value "QUEUED", which is
 *    what the cron publisher in schedulerService.ts already consumes. So manual
 *    scheduled posts are published by the same scheduler automatically.
 *  - No Prisma migration is required; all needed fields already exist.
 */

// Existing status value used for scheduled-and-waiting-to-publish posts.
export const SCHEDULED_STATUS = 'QUEUED';
export const MANUAL_SOURCE = 'MANUAL';
const MAX_CONTENT_LENGTH = 3000;

// Statuses a manual post may be edited/scheduled/deleted in (i.e. not published).
export const MUTABLE_STATUSES = ['DRAFT', 'QUEUED', 'FAILED'];

// Error type that carries an HTTP status so the route layer can respond cleanly.
export class ManualPostError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'ManualPostError';
    this.status = status;
    this.details = details;
  }
}

export interface ManualPostInput {
  content?: unknown;
  mediaUrl?: unknown;
  hashtags?: unknown;
  manualTopic?: unknown;
  aiGenerated?: unknown;
}

interface ValidatedInput {
  content: string;
  mediaUrl: string | null;
}

// Trim + validate content/media. Content is required unless a media URL exists.
export function validateManualPostInput(content: unknown, mediaUrl: unknown): ValidatedInput {
  const trimmed = typeof content === 'string' ? content.trim() : '';
  const media =
    typeof mediaUrl === 'string' && mediaUrl.trim().length > 0 ? mediaUrl.trim() : null;

  if (!trimmed && !media) {
    throw new ManualPostError(400, 'Post content is required');
  }
  if (trimmed.length > MAX_CONTENT_LENGTH) {
    throw new ManualPostError(400, `Content must be ${MAX_CONTENT_LENGTH} characters or fewer`);
  }

  return { content: trimmed, mediaUrl: media };
}

// Parse an ISO date string and require it to be in the future.
function parseFutureDate(value: unknown): Date {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ManualPostError(400, 'scheduledAt is required');
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ManualPostError(400, 'Invalid scheduledAt date');
  }
  if (date.getTime() <= Date.now()) {
    throw new ManualPostError(400, 'scheduledAt must be in the future');
  }
  return date;
}

// Most recently updated LinkedIn account for the user (or null if none).
async function getLinkedInAccountId(userId: string): Promise<string | null> {
  const account = await getUsableLinkedInAccountForUser(userId);
  return account?.id ?? null;
}

// Entitlement gate shared by schedule + publish actions.
async function ensureCanPublishOrSchedule(userId: string): Promise<void> {
  const gate = await canPublish(userId);
  if (!gate.allowed) {
    throw new ManualPostError(403, gate.reason || 'You are not allowed to publish right now', gate.entitlement);
  }
}

// Look up a post that belongs to this user AND is a manual post. Always scopes
// by userId so one user can never touch another user's post. Bot/generated
// posts (source !== MANUAL) are intentionally invisible here.
async function findOwnedManualPost(userId: string, postId: string) {
  if (!postId) throw new ManualPostError(404, 'Post not found');
  const post = await prisma.post.findFirst({
    where: { id: postId, userId, source: MANUAL_SOURCE },
  });
  if (!post) throw new ManualPostError(404, 'Post not found');
  return post;
}

// ---------------------------------------------------------------------------
// 1. Create draft
// ---------------------------------------------------------------------------
function parseOptionalHashtags(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseOptionalTopic(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 500) : null;
}

function parseAiGenerated(raw: unknown): boolean {
  return raw === true || raw === 'true' || raw === 1 || raw === '1';
}

function afterManualPostPersisted(post: { id: string; userId: string; source: string }) {
  if (post.source !== MANUAL_SOURCE) return;
  scheduleManualPostFingerprintSync(post.id, post.userId);
}

export async function createDraft(userId: string, body: ManualPostInput) {
  const { content, mediaUrl } = validateManualPostInput(body.content, body.mediaUrl);
  const linkedinAccountId = await getLinkedInAccountId(userId);

  const post = await prisma.post.create({
    data: {
      userId,
      content,
      mediaUrl,
      hashtags: parseOptionalHashtags(body.hashtags),
      manualTopic: parseOptionalTopic(body.manualTopic),
      aiGenerated: parseAiGenerated(body.aiGenerated),
      status: 'DRAFT',
      source: MANUAL_SOURCE,
      linkedinAccountId,
    },
  });
  afterManualPostPersisted(post);
  return post;
}

// ---------------------------------------------------------------------------
// 2. Update a draft or scheduled post
// ---------------------------------------------------------------------------
export async function updateManualPost(
  userId: string,
  postId: string,
  body: {
    content?: unknown;
    mediaUrl?: unknown;
    scheduledAt?: unknown;
    hashtags?: unknown;
    manualTopic?: unknown;
    aiGenerated?: unknown;
  },
) {
  const post = await findOwnedManualPost(userId, postId);

  if (post.status === 'PUBLISHED') {
    throw new ManualPostError(409, 'Cannot edit a published post');
  }

  const data: Record<string, unknown> = {};

  // If either content or mediaUrl is being changed, validate the resulting pair.
  if (body.content !== undefined || body.mediaUrl !== undefined) {
    const nextContent = body.content !== undefined ? body.content : post.content;
    const nextMedia = body.mediaUrl !== undefined ? body.mediaUrl : post.mediaUrl;
    const validated = validateManualPostInput(nextContent, nextMedia);
    if (body.content !== undefined) data.content = validated.content;
    if (body.mediaUrl !== undefined) data.mediaUrl = validated.mediaUrl;
  }

  if (body.hashtags !== undefined) {
    data.hashtags = parseOptionalHashtags(body.hashtags);
  }
  if (body.manualTopic !== undefined) {
    data.manualTopic = parseOptionalTopic(body.manualTopic);
  }
  if (body.aiGenerated !== undefined) {
    data.aiGenerated = parseAiGenerated(body.aiGenerated);
  }

  if (body.scheduledAt !== undefined) {
    if (body.scheduledAt === null) {
      // Remove the schedule -> back to a plain draft.
      data.scheduledAt = null;
      data.status = 'DRAFT';
    } else {
      // Scheduling here just sets the time/status; publishing is still gated by
      // the scheduler's canPublish() check at publish time, so trial limits
      // cannot be bypassed via edit.
      data.scheduledAt = parseFutureDate(body.scheduledAt);
      data.status = SCHEDULED_STATUS;
    }
  }

  const updated = await prisma.post.update({ where: { id: post.id }, data });
  afterManualPostPersisted(updated);
  return updated;
}

// ---------------------------------------------------------------------------
// 3. Schedule an existing post
// ---------------------------------------------------------------------------
export async function scheduleManualPost(userId: string, postId: string, scheduledAtRaw: unknown) {
  const post = await findOwnedManualPost(userId, postId);

  if (post.status === 'PUBLISHED') {
    throw new ManualPostError(409, 'Post already published');
  }

  const scheduledAt = parseFutureDate(scheduledAtRaw);
  await ensureCanPublishOrSchedule(userId);
  // Scheduling does not publish to LinkedIn; monthly quota is checked at publish time.

  const linkedinAccountId = post.linkedinAccountId ?? (await getLinkedInAccountId(userId));

  const scheduled = await prisma.post.update({
    where: { id: post.id },
    data: { scheduledAt, status: SCHEDULED_STATUS, linkedinAccountId },
  });
  afterManualPostPersisted(scheduled);
  return scheduled;
}

// ---------------------------------------------------------------------------
// 4. Publish an existing post immediately
// ---------------------------------------------------------------------------
export async function publishManualPostNow(userId: string, postId: string) {
  const post = await findOwnedManualPost(userId, postId);

  if (post.status === 'PUBLISHED') {
    throw new ManualPostError(409, 'Post already published');
  }

  await ensureCanPublishOrSchedule(userId);
  await canPublishToLinkedIn(userId, 1);

  let linkedinAccountId = post.linkedinAccountId;
  if (!linkedinAccountId) {
    linkedinAccountId = await getLinkedInAccountId(userId);
    if (!linkedinAccountId) {
      throw new ManualPostError(403, 'LinkedIn account not connected');
    }
    await prisma.post.update({ where: { id: post.id }, data: { linkedinAccountId } });
  }

  try {
    // Reuses the existing official LinkedIn API publisher (handles media too).
    // On success it sets status=PUBLISHED, publishedAt, linkedinPostUrn.
    await postToLinkedInFromPostId(post.id);
  } catch (err: any) {
    // Leave the post in its current (non-published) status; just surface error.
    throw new ManualPostError(500, err?.message || 'Failed to publish post');
  }

  const published = await prisma.post.findUnique({ where: { id: post.id } });
  if (published) afterManualPostPersisted(published);
  return published;
}

// ---------------------------------------------------------------------------
// 5. Create + publish immediately in one request
// ---------------------------------------------------------------------------
export async function createAndPublishNow(userId: string, body: ManualPostInput) {
  const { content, mediaUrl } = validateManualPostInput(body.content, body.mediaUrl);

  // Gate before creating anything so we don't leave orphan drafts.
  await ensureCanPublishOrSchedule(userId);
  await canPublishToLinkedIn(userId, 1);

  const linkedinAccountId = await getLinkedInAccountId(userId);
  if (!linkedinAccountId) {
    throw new ManualPostError(403, 'LinkedIn account not connected');
  }

  const post = await prisma.post.create({
    data: {
      userId,
      content,
      mediaUrl,
      status: 'DRAFT',
      source: MANUAL_SOURCE,
      linkedinAccountId,
    },
  });

  try {
    await postToLinkedInFromPostId(post.id);
  } catch (err: any) {
    throw new ManualPostError(500, err?.message || 'Failed to publish post');
  }

  const published = await prisma.post.findUnique({ where: { id: post.id } });
  if (published) afterManualPostPersisted(published);
  return published;
}

// ---------------------------------------------------------------------------
// 6. Create + schedule in one request
// ---------------------------------------------------------------------------
export async function createAndSchedule(userId: string, body: ManualPostInput & { scheduledAt?: unknown }) {
  const { content, mediaUrl } = validateManualPostInput(body.content, body.mediaUrl);
  const scheduledAt = parseFutureDate(body.scheduledAt);

  await ensureCanPublishOrSchedule(userId);

  const linkedinAccountId = await getLinkedInAccountId(userId);

  const scheduled = await prisma.post.create({
    data: {
      userId,
      content,
      mediaUrl,
      scheduledAt,
      status: SCHEDULED_STATUS,
      source: MANUAL_SOURCE,
      linkedinAccountId,
    },
  });
  afterManualPostPersisted(scheduled);
  return scheduled;
}

// ---------------------------------------------------------------------------
// 7. List manual posts
// ---------------------------------------------------------------------------
type ListFilters = { status?: string; from?: string; to?: string };

// Accept the spec's "SCHEDULED" vocabulary as an alias for the stored "QUEUED".
function normalizeStatusFilter(status?: string): string | undefined {
  if (!status) return undefined;
  const upper = status.toUpperCase();
  if (upper === 'SCHEDULED') return SCHEDULED_STATUS;
  return upper;
}

function effectiveDate(p: { publishedAt: Date | null; scheduledAt: Date | null; createdAt: Date }): Date {
  return p.publishedAt ?? p.scheduledAt ?? p.createdAt;
}

export async function listManualPosts(userId: string, filters: ListFilters) {
  const where: Record<string, unknown> = { userId, source: MANUAL_SOURCE };
  const status = normalizeStatusFilter(filters.status);
  if (status) where.status = status;

  const posts = await prisma.post.findMany({
    where,
    select: {
      id: true,
      content: true,
      status: true,
      mediaUrl: true,
      source: true,
      hashtags: true,
      manualTopic: true,
      aiGenerated: true,
      rewriteCount: true,
      scheduledAt: true,
      publishedAt: true,
      createdAt: true,
      updatedAt: true,
      linkedinPostUrn: true,
    },
  });

  // Optional date-range filter on the post's effective date.
  let filtered = posts;
  const fromDate = filters.from ? new Date(filters.from) : null;
  const toDate = filters.to ? new Date(filters.to) : null;
  if (fromDate && !Number.isNaN(fromDate.getTime())) {
    filtered = filtered.filter((p) => effectiveDate(p).getTime() >= fromDate.getTime());
  }
  if (toDate && !Number.isNaN(toDate.getTime())) {
    filtered = filtered.filter((p) => effectiveDate(p).getTime() <= toDate.getTime());
  }

  // Ordering: scheduled (QUEUED) by scheduledAt asc, then drafts/failed by
  // updatedAt desc, then published by publishedAt desc.
  const groupRank: Record<string, number> = { QUEUED: 0, DRAFT: 1, FAILED: 1, REVIEW: 1, PUBLISHED: 2 };
  filtered.sort((a, b) => {
    const ra = groupRank[a.status] ?? 3;
    const rb = groupRank[b.status] ?? 3;
    if (ra !== rb) return ra - rb;

    if (a.status === 'QUEUED' && b.status === 'QUEUED') {
      return (a.scheduledAt?.getTime() ?? 0) - (b.scheduledAt?.getTime() ?? 0);
    }
    if (a.status === 'PUBLISHED' && b.status === 'PUBLISHED') {
      return (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0);
    }
    return b.updatedAt.getTime() - a.updatedAt.getTime();
  });

  return filtered;
}

// ---------------------------------------------------------------------------
// 8. Delete a draft / scheduled / failed post
// ---------------------------------------------------------------------------
export async function deleteManualPost(userId: string, postId: string) {
  const post = await findOwnedManualPost(userId, postId);

  if (post.status === 'PUBLISHED') {
    throw new ManualPostError(409, 'Cannot delete a published post');
  }
  if (!MUTABLE_STATUSES.includes(post.status)) {
    throw new ManualPostError(409, `Cannot delete a post with status ${post.status}`);
  }

  await prisma.post.delete({ where: { id: post.id } });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 9. Duplicate a post into a new draft
// ---------------------------------------------------------------------------
export async function duplicateManualPost(userId: string, postId: string) {
  const post = await findOwnedManualPost(userId, postId);
  const linkedinAccountId = post.linkedinAccountId ?? (await getLinkedInAccountId(userId));

  const duplicate = await prisma.post.create({
    data: {
      userId,
      content: post.content,
      mediaUrl: post.mediaUrl,
      hashtags: post.hashtags,
      manualTopic: post.manualTopic,
      aiGenerated: post.aiGenerated,
      status: 'DRAFT',
      source: MANUAL_SOURCE,
      linkedinAccountId,
    },
  });
  afterManualPostPersisted(duplicate);
  return duplicate;
}
