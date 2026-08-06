import { randomUUID } from 'crypto';
import axios from 'axios';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { prisma } from '../prismaClient';
import { generateCarouselFromPost, getPlanCarouselAiQuota, MAX_AI_CAROUSEL_SLIDES_PER_GENERATION, MIN_POST_CAROUSEL_SLIDES } from '../services/carouselAiService';
import { renderAndStoreCarouselPdf } from '../services/carouselPdfService';
import { getUserPlanEntitlements } from '../services/planEntitlementService';
import { getBotVoice } from '../services/userContentContext';
import { deleteObjectFromR2 } from '../middleware/r2';

const router = Router();
const generationSchema = z.object({
  slideCount: z.number().int().min(MIN_POST_CAROUSEL_SLIDES).max(MAX_AI_CAROUSEL_SLIDES_PER_GENERATION).default(7),
  layout: z.enum(['classic', 'bold-number', 'editorial']).default('classic'),
  themeId: z.enum(['veyrais-blue', 'midnight', 'minimal', 'creator', 'custom']).default('veyrais-blue'),
  backgroundDesign: z.string().trim().min(1).max(40).default('soft-gradient'),
  instructions: z.string().trim().max(1000).optional().default(''),
  replaceExistingMedia: z.boolean().default(false),
  requestId: z.string().uuid().optional(),
});
const attachSchema = z.object({
  carouselProjectId: z.string().trim().min(1),
  replaceExistingMedia: z.boolean().default(false),
});
const activeLocks = new Map<string, number>();
const completedRequests = new Map<string, { expires: number; response: any }>();
const LOCK_MS = 5 * 60_000;

function fail(res: any, status: number, code: string, message: string) { return res.status(status).json({ code, message, error: message }); }
function editableStatus(post: { status: string }) { return post.status === 'DRAFT' || post.status === 'REVIEW'; }
function themeName(themeId: string) { return ({ 'veyrais-blue': 'Veyrais Blue', midnight: 'Midnight', minimal: 'Minimal', creator: 'Creator', custom: 'Custom' } as Record<string, string>)[themeId]; }

async function ownedPost(postId: string, userId: string) {
  return prisma.post.findFirst({ where: { id: postId, userId }, include: { carouselProject: true, linkedinAccount: true, user: { include: { region: true } } } });
}

function validateEditable(post: any, res: any) {
  if (!post) { fail(res, 404, 'POST_NOT_FOUND', 'Post not found.'); return false; }
  if (post.status === 'QUEUED') { fail(res, 409, 'POST_NOT_EDITABLE', 'Unschedule this post before changing its media attachment.'); return false; }
  if (!editableStatus(post)) { fail(res, 409, 'POST_NOT_EDITABLE', 'Only draft or review posts can have a carousel attached.'); return false; }
  return true;
}

router.get('/:postId/carousel', requireAuth, async (req, res) => {
  const post = await ownedPost(req.params.postId, req.userId!);
  if (!post) return fail(res, 404, 'POST_NOT_FOUND', 'Post not found.');
  return res.json({ post, carouselProject: post.carouselProject ? { ...post.carouselProject, project: JSON.parse(post.carouselProject.projectJson) } : null });
});

async function generate(req: any, res: any, regenerate: boolean) {
  const parsed = generationSchema.safeParse(req.body || {});
  if (!parsed.success) return fail(res, 400, 'INVALID_CAROUSEL_REQUEST', parsed.error.issues[0]?.message || 'Invalid carousel request.');
  const userId = req.userId as string;
  const postId = req.params.postId as string;
  const requestId = parsed.data.requestId || randomUUID();
  const idempotencyKey = `${userId}:${postId}:${requestId}:${regenerate ? 'regenerate' : 'create'}`;
  const cached = completedRequests.get(idempotencyKey);
  if (cached && cached.expires > Date.now()) return res.json(cached.response);
  const lockKey = `user:${userId}`;
  if ((activeLocks.get(lockKey) || 0) > Date.now()) return fail(res, 409, 'CAROUSEL_GENERATION_IN_PROGRESS', 'A carousel generation is already running for this post.');
  activeLocks.set(lockKey, Date.now() + LOCK_MS);
  let uploadedKey: string | null = null;
  let completed = false;
  try {
    const post = await ownedPost(postId, userId);
    if (!validateEditable(post, res)) return;
    if (regenerate && !post!.carouselProject) return fail(res, 404, 'CAROUSEL_NOT_ATTACHED', 'This post does not have an attached carousel.');
    if (!regenerate && post!.carouselProject) return fail(res, 409, 'CAROUSEL_ALREADY_ATTACHED', 'This post already has a carousel. Use regenerate instead.');
    const entitlements = await getUserPlanEntitlements(userId);
    if (!entitlements.convertPostToCarouselEnabled) return fail(res, 403, 'POST_TO_CAROUSEL_NOT_INCLUDED', 'Post-to-carousel conversion is available on Pro and Ultimate.');
    if (entitlements.remaining.carouselAiGenerations !== null && entitlements.remaining.carouselAiGenerations <= 0) return fail(res, 429, 'CAROUSEL_AI_GENERATION_LIMIT_REACHED', 'You have used all AI carousel generations available in your current billing period.');
    if (!regenerate && entitlements.remaining.carouselSaves !== null && entitlements.remaining.carouselSaves <= 0) return fail(res, 403, 'CAROUSEL_SAVE_LIMIT_REACHED', 'You have reached your plan’s saved carousel limit.');
    const hasImage = post!.attachmentType === 'IMAGE' || Boolean(post!.mediaUrl);
    if (hasImage && !parsed.data.replaceExistingMedia) return fail(res, 409, 'POST_ATTACHMENT_CONFLICT', 'This post already has an image attachment. Confirm replacement before adding a carousel.');

    const generated = await generateCarouselFromPost({ postContent: post!.content, slideCount: parsed.data.slideCount, instructions: parsed.data.instructions, userId });
    const voice = await getBotVoice(userId);
    const profile = {
      name: post!.linkedinAccount?.profileName || post!.user.username,
      handle: post!.linkedinAccount?.linkedInMemberId || '',
      role: voice.description || '',
      website: voice.websiteUrl || '',
      image: post!.linkedinAccount?.profileImageUrl || undefined,
      logo: post!.user.region?.logoUrl || undefined,
    };
    const previousProject = post!.carouselProject ? JSON.parse(post!.carouselProject.projectJson) : null;
    const selectedLayout = parsed.data.layout === 'bold-number' ? 'Bold number' : parsed.data.layout[0].toUpperCase() + parsed.data.layout.slice(1);
    const slides = generated.slides.map((slide: any, index: number) => ({
      ...slide,
      layout: regenerate ? (previousProject?.slides?.[index]?.layout || selectedLayout) : selectedLayout,
      backgroundDesign: regenerate ? (previousProject?.slides?.[index]?.backgroundDesign || parsed.data.backgroundDesign) : parsed.data.backgroundDesign,
      backgroundIntensity: regenerate ? (previousProject?.slides?.[index]?.backgroundIntensity || 'balanced') : 'balanced',
      customColors: regenerate ? previousProject?.slides?.[index]?.customColors : undefined,
    }));
    const title = regenerate ? post!.carouselProject!.title : `Carousel — ${generated.title}`.slice(0, 240);
    const project = { title, theme: regenerate ? previousProject.theme : themeName(parsed.data.themeId), slides, profile: regenerate ? previousProject.profile : profile, updatedAt: Date.now() };
    const pdf = await renderAndStoreCarouselPdf({ project, userId, postId });
    uploadedKey = pdf.key;
    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      const currentEntitlements = await getUserPlanEntitlements(userId);
      if (currentEntitlements.remaining.carouselAiGenerations !== null && currentEntitlements.remaining.carouselAiGenerations <= 0) throw Object.assign(new Error('AI limit reached'), { code: 'CAROUSEL_AI_GENERATION_LIMIT_REACHED' });
      if (!regenerate && currentEntitlements.remaining.carouselSaves !== null && currentEntitlements.remaining.carouselSaves <= 0) throw Object.assign(new Error('Save limit reached'), { code: 'CAROUSEL_SAVE_LIMIT_REACHED' });
      const savedProject = regenerate
        ? await tx.carouselProject.update({ where: { id: post!.carouselProject!.id }, data: { title, projectJson: JSON.stringify(project) } })
        : await tx.carouselProject.create({ data: { userId, regionId: post!.regionId, title, projectJson: JSON.stringify(project) } });
      const updatedPost = await tx.post.update({ where: { id: postId }, data: { attachmentType: 'CAROUSEL', mediaUrl: null, carouselProjectId: savedProject.id, carouselPdfUrl: pdf.url, carouselFileName: pdf.filename, carouselUpdatedAt: now, carouselAttachmentStatus: 'CURRENT' } });
      await tx.carouselAiGenerationUsage.create({ data: { userId, regionId: post!.regionId } });
      return { updatedPost, savedProject };
    }, { isolationLevel: 'Serializable' });
    const quota = await getPlanCarouselAiQuota(userId);
    const response = { post: result.updatedPost, carouselProject: { id: result.savedProject.id, title, slideCount: slides.length, updatedAt: result.savedProject.updatedAt, project }, usage: { carouselAiGenerationsUsed: quota.used, carouselAiGenerationsRemaining: quota.remaining, savedCarousels: entitlements.usage.savedCarouselProjects + (regenerate ? 0 : 1), carouselSaveLimit: entitlements.carouselSaveLimit } };
    completedRequests.set(idempotencyKey, { expires: Date.now() + LOCK_MS, response });
    completed = true;
    return res.json(response);
  } catch (error: any) {
    if (uploadedKey && !completed) await deleteObjectFromR2(uploadedKey).catch(() => undefined);
    console.error('[post-carousel] generation failed', error);
    if (error?.code === 'CAROUSEL_AI_GENERATION_LIMIT_REACHED') return fail(res, 429, error.code, 'You have used all AI carousel generations available in your current billing period.');
    if (error?.code === 'CAROUSEL_SAVE_LIMIT_REACHED') return fail(res, 403, error.code, 'You have reached your plan’s saved carousel limit.');
    return fail(res, 502, 'CAROUSEL_GENERATION_FAILED', 'The carousel could not be generated. Your AI generation allowance was not used.');
  } finally {
    activeLocks.delete(lockKey);
  }
}

router.post('/:postId/carousel/generate', requireAuth, (req, res) => generate(req, res, false));
router.post('/:postId/carousel/regenerate', requireAuth, (req, res) => generate(req, res, true));

router.post('/:postId/carousel/attach', requireAuth, async (req, res) => {
  const parsed = attachSchema.safeParse(req.body || {});
  if (!parsed.success) return fail(res, 400, 'INVALID_CAROUSEL_REQUEST', 'Select a carousel to attach.');

  const userId = req.userId!;
  const post = await ownedPost(req.params.postId, userId);
  if (!validateEditable(post, res)) return;

  const entitlements = await getUserPlanEntitlements(userId);
  if (!entitlements.convertPostToCarouselEnabled) {
    return fail(res, 403, 'POST_TO_CAROUSEL_NOT_INCLUDED', 'Post-to-carousel features are available on Pro and Ultimate.');
  }

  const selected = await prisma.carouselProject.findUnique({
    where: { id: parsed.data.carouselProjectId },
  });
  if (!selected) return fail(res, 404, 'CAROUSEL_PROJECT_NOT_FOUND', 'The selected carousel could not be found.');
  if (selected.userId !== userId) return fail(res, 403, 'CAROUSEL_PROJECT_FORBIDDEN', 'You do not have access to this carousel.');

  let project: any;
  try {
    project = JSON.parse(selected.projectJson);
    if (!project || typeof project.title !== 'string' || !Array.isArray(project.slides) || project.slides.length === 0) throw new Error('Invalid project');
  } catch {
    return fail(res, 422, 'CAROUSEL_PDF_FAILED', 'The carousel PDF could not be prepared.');
  }

  const hasImage = post!.attachmentType === 'IMAGE' || Boolean(post!.mediaUrl);
  if (hasImage && !parsed.data.replaceExistingMedia) {
    return fail(res, 409, 'POST_ATTACHMENT_CONFLICT', 'This post already has an image. Confirm replacement before attaching a carousel.');
  }

  try {
    const reusable = await prisma.post.findFirst({
      where: {
        userId,
        carouselProjectId: selected.id,
        attachmentType: 'CAROUSEL',
        carouselAttachmentStatus: 'CURRENT',
        carouselPdfUrl: { not: null },
        carouselUpdatedAt: { gte: selected.updatedAt },
      },
      orderBy: { carouselUpdatedAt: 'desc' },
      select: { carouselPdfUrl: true, carouselFileName: true, carouselUpdatedAt: true },
    });

    let reusablePdfAccessible = false;
    if (reusable?.carouselPdfUrl) {
      try {
        await axios.head(reusable.carouselPdfUrl, { timeout: 10_000 });
        reusablePdfAccessible = true;
      } catch {
        reusablePdfAccessible = false;
      }
    }

    const pdf = reusable?.carouselPdfUrl && reusablePdfAccessible
      ? {
          url: reusable.carouselPdfUrl,
          filename: reusable.carouselFileName || `${selected.title}.pdf`,
          updatedAt: reusable.carouselUpdatedAt || new Date(),
        }
      : await renderAndStoreCarouselPdf({ project, userId, postId: post!.id }).then((created) => ({ ...created, updatedAt: new Date() }));

    const updated = await prisma.post.update({
      where: { id: post!.id },
      data: {
        attachmentType: 'CAROUSEL',
        mediaUrl: null,
        carouselProjectId: selected.id,
        carouselPdfUrl: pdf.url,
        carouselFileName: pdf.filename,
        carouselUpdatedAt: pdf.updatedAt,
        carouselAttachmentStatus: 'CURRENT',
      },
    });

    return res.json({
      post: updated,
      carouselProject: { id: selected.id, title: selected.title, slideCount: project.slides.length, updatedAt: selected.updatedAt, project },
    });
  } catch (error) {
    console.error('[post-carousel] attach existing failed', error);
    return fail(res, 502, 'CAROUSEL_PDF_FAILED', 'The carousel PDF could not be prepared.');
  }
});

router.post('/:postId/carousel/refresh-pdf', requireAuth, async (req, res) => {
  const post = await ownedPost(req.params.postId, req.userId!);
  if (!validateEditable(post, res)) return;
  if (!post!.carouselProject) return fail(res, 404, 'CAROUSEL_NOT_ATTACHED', 'This post does not have an attached carousel.');
  const project = JSON.parse(post!.carouselProject.projectJson);
  const pdf = await renderAndStoreCarouselPdf({ project, userId: req.userId!, postId: post!.id });
  const updated = await prisma.post.update({ where: { id: post!.id }, data: { carouselPdfUrl: pdf.url, carouselFileName: pdf.filename, carouselUpdatedAt: new Date(), carouselAttachmentStatus: 'CURRENT', attachmentType: 'CAROUSEL', mediaUrl: null } });
  return res.json({ post: updated, carouselProject: { id: post!.carouselProject.id, project } });
});

router.delete('/:postId/carousel', requireAuth, async (req, res) => {
  const post = await ownedPost(req.params.postId, req.userId!);
  if (!validateEditable(post, res)) return;
  const updated = await prisma.post.update({ where: { id: post!.id }, data: { carouselProjectId: null, carouselPdfUrl: null, carouselFileName: null, carouselUpdatedAt: null, carouselAttachmentStatus: null, attachmentType: post!.mediaUrl ? 'IMAGE' : 'NONE' } });
  return res.json(updated);
});

export default router;
