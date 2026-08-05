import { Request, Router } from 'express';
import jwt from 'jsonwebtoken';
import { chromium } from 'playwright';
import { z } from 'zod';
import { config } from '../config';
import { prisma } from '../prismaClient';
import { createCarouselExport, deleteCarouselExport, getCarouselExport } from '../services/carouselExportStore';
import { completeCarouselAiGeneration, generateCarouselWithAi, getCarouselAiQuota } from '../services/carouselAiService';

const router = Router();
const text = z.string().max(5000);
const slideSchema = z.object({
  id: z.string().min(1).max(100), type: z.enum(['TITLE', 'BODY', 'RECAP', 'CLOSING']),
  label: text.optional().default(''), heading: text, body: text.optional().default(''),
  bullets: z.array(text).max(12).default([]), cta: text.optional().default(''),
  layout: z.string().max(40).optional().default('Classic'),
  backgroundDesign: z.string().max(40).optional(), backgroundIntensity: z.string().max(20).optional(),
  customColors: z.object({ bg: z.string().regex(/^#[0-9a-f]{6}$/i), ink: z.string().regex(/^#[0-9a-f]{6}$/i), primary: z.string().regex(/^#[0-9a-f]{6}$/i), secondary: z.string().regex(/^#[0-9a-f]{6}$/i) }).optional(),
}).passthrough();
const profileSchema = z.object({
  name: z.string().max(160), handle: z.string().max(160), role: z.string().max(240), website: z.string().max(500),
  image: z.string().max(5_000_000).optional(), logo: z.string().max(5_000_000).optional(),
}).passthrough();
const projectSchema = z.object({
  title: z.string().min(1).max(240), theme: z.enum(['Veyrais Blue', 'Midnight', 'Minimal', 'Creator', 'Custom']),
  slides: z.array(slideSchema).min(1).max(40), profile: profileSchema, updatedAt: z.number().optional(),
}).passthrough();

async function hasAuthenticatedUser(authorization?: string) {
  if (!authorization?.startsWith('Bearer ')) return false;
  try {
    const decoded = jwt.verify(authorization.slice(7), config.jwtSecret) as { userId?: string };
    if (!decoded.userId) return false;
    return Boolean(await prisma.user.findFirst({ where: { id: decoded.userId, isActive: true }, select: { id: true } }));
  } catch { return false; }
}

async function optionalUserId(authorization?: string) {
  if (!authorization?.startsWith('Bearer ')) return undefined;
  try {
    const decoded = jwt.verify(authorization.slice(7), config.jwtSecret) as { userId?: string };
    if (!decoded.userId) return undefined;
    const user = await prisma.user.findFirst({ where: { id: decoded.userId, isActive: true }, select: { id: true } });
    return user?.id;
  } catch { return undefined; }
}

function quotaKey(req: Request, userId?: string) {
  return userId ? `user:${userId}` : `guest:${req.ip || req.socket.remoteAddress || 'unknown'}:${req.get('user-agent') || 'unknown'}`;
}

router.get('/ai-quota', async (req, res) => {
  const userId = await optionalUserId(req.headers.authorization);
  return res.set('Cache-Control', 'no-store').json(getCarouselAiQuota(quotaKey(req, userId)));
});

router.post('/generate-ai', async (req, res) => {
  const input = z.object({
    topic: z.string().trim().min(3, 'Enter a topic with at least 3 characters').max(500),
    instructions: z.string().trim().max(1000).optional().default(''),
  }).safeParse(req.body || {});
  if (!input.success) return res.status(400).json({ error: input.error.issues[0]?.message || 'Invalid generation request' });
  const userId = await optionalUserId(req.headers.authorization);
  const key = quotaKey(req, userId);
  const quota = getCarouselAiQuota(key);
  if (!quota.remaining) return res.status(429).json({ error: 'You have used all 8 free AI generations for today.', quota });
  try {
    const carousel = await generateCarouselWithAi({ ...input.data, userId });
    return res.set('Cache-Control', 'no-store').json({ ...carousel, quota: completeCarouselAiGeneration(key) });
  } catch (error) {
    console.error('[carousel-ai] generation failed', error);
    const message = error instanceof Error ? error.message : 'Carousel generation failed';
    return res.status(message.includes('not configured') ? 503 : 502).json({ error: message, quota });
  }
});

router.get('/export-data/:token', (req, res) => {
  const entry = getCarouselExport(req.params.token);
  if (!entry) return res.status(404).json({ error: 'Export expired or not found' });
  return res.set('Cache-Control', 'no-store').json({ project: entry.project, attributionRequired: entry.attributionRequired });
});

router.post('/export-pdf', async (req, res) => {
  const parsed = projectSchema.safeParse(req.body?.project);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid carousel project', details: parsed.error.issues.slice(0, 5) });
  const authenticated = await hasAuthenticatedUser(req.headers.authorization);
  const filename = `${parsed.data.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'carousel'}.pdf`;
  const token = createCarouselExport({ project: parsed.data, attributionRequired: !authenticated, filename });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 768, height: 960 }, deviceScaleFactor: 1 });
    await page.goto(`${config.frontendUrl.replace(/\/$/, '')}/carousel-export/${encodeURIComponent(token)}`, { waitUntil: 'networkidle', timeout: 60_000 });
    await page.waitForSelector('.cm-export-document.is-ready', { timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    const pdf = await page.pdf({ width: '8in', height: '10in', printBackground: true, preferCSSPageSize: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' });
    return res.send(pdf);
  } finally {
    deleteCarouselExport(token);
    await browser?.close();
  }
});

export default router;
