import { Router, Request } from 'express';
import { prisma } from '../prismaClient';
import { requireAuth } from '../middleware/auth';
import {
  parseBoolean,
  cleanOptionalText,
  normalizeWebsiteUrl,
} from '../services/postContentFormatting';
import {
  BatchScheduleError,
  parsePostingScheduleSafe,
  serializePostingSchedule,
} from '../services/batchScheduleService';
import { NicheExpansionService, normalizeNicheKey } from '../services/nicheExpansionService';
import { decryptSecret } from '../services/secretCrypto';
import {
  parseBotImageModeInput,
  resolveBotImageMode,
} from '../services/botImageModeService';

const router = Router();

// GET /bot/config - Get current user's bot config
router.get('/config', requireAuth, async (req: Request, res: any) => {
  try {
    const config = await prisma.botConfig.findUnique({
      where: { userId: req.userId }
    });

    // add description default too
    const batchPostingSchedule = parsePostingScheduleSafe(config?.postingSchedule ?? null);
    const effectiveImageMode = config
      ? resolveBotImageMode(config)
      : 'none';

    res.json(
      config
        ? {
            ...config,
            imageMode: config.imageMode ?? null,
            effectiveImageMode,
            contactInfo: config.contactInfo || '',
            websiteUrl: config.websiteUrl || '',
            includeContactInfo: config.includeContactInfo ?? false,
            includeWebsiteLink: config.includeWebsiteLink ?? false,
            postingSchedule: config.postingSchedule || null,
            batchPostingSchedule,
          }
        : {
            userId: req.userId,
            niches: '[]',
            sources: '["google"]',
            backgroundImageUrl: '',
            imageMode: null,
            effectiveImageMode: 'none',
            isEnabled: false,
            description: '', // ✅
            contactInfo: '',
            websiteUrl: '',
            includeContactInfo: false,
            includeWebsiteLink: false,
            postingSchedule: null,
            batchPostingSchedule,
          }
    );
  } catch (error) {
    console.error('Error fetching bot config:', error);
    res.status(500).json({ error: 'Failed to fetch config' });
  }
});

// PUT /bot/config - Update or Create bot config
router.put('/config', requireAuth, async (req: Request, res: any) => {


  const {
    niches,
    sources,
    customRssFeeds,
    customLinks,
    customRedditFeeds,
    backgroundImageUrl,
    isEnabled,
    tone,
    postsPerWeek,
    description // ✅
  } = req.body;

  const includeContactInfo = parseBoolean(req.body.includeContactInfo, false);
  const includeWebsiteLink = parseBoolean(req.body.includeWebsiteLink, false);

  let normalizedWebsiteUrl: string | null = null;
  try {
    normalizedWebsiteUrl = normalizeWebsiteUrl(req.body.websiteUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid website URL' });
  }

    const cleanedContactInfo = cleanOptionalText(req.body.contactInfo, 500);

    let imageModeUpdate: string | null | undefined;
    if (Object.prototype.hasOwnProperty.call(req.body, 'imageMode')) {
      try {
        imageModeUpdate = parseBotImageModeInput(req.body.imageMode);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid imageMode';
        return res.status(400).json({ error: message });
      }
    }

    const hasSchedulePayload =
      Object.prototype.hasOwnProperty.call(req.body, 'batchPostingSchedule') ||
      Object.prototype.hasOwnProperty.call(req.body, 'postingSchedule');

    let postingScheduleUpdate: string | undefined;
    if (hasSchedulePayload) {
      const scheduleInput = req.body.batchPostingSchedule ?? req.body.postingSchedule;
      try {
        postingScheduleUpdate = serializePostingSchedule(scheduleInput ?? null);
      } catch (err) {
        if (err instanceof BatchScheduleError) {
          return res.status(400).json({ error: `Invalid posting schedule: ${err.message}` });
        }
        throw err;
      }
    }

    try {
    const nichesStr = typeof niches === 'string' ? niches : JSON.stringify(niches || []);
    const sourcesStr = typeof sources === 'string' ? sources : JSON.stringify(sources || []);
    const customRssFeedsStr = typeof customRssFeeds === 'string' ? customRssFeeds : JSON.stringify(customRssFeeds || []);
    const customLinksStr = typeof customLinks === 'string' ? customLinks : JSON.stringify(customLinks || []);
    const customRedditFeedsStr = typeof customRedditFeeds === 'string' ? customRedditFeeds : JSON.stringify(customRedditFeeds || []);

    // Stamp the config with the user's region so region-scoped admin/analytics
    // queries include bot-generated data.
    const owner = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: { regionId: true },
    });
    const regionId = owner?.regionId ?? null;

    const config = await prisma.botConfig.upsert({
      where: { userId: req.userId! },
      create: {
        userId: req.userId!,
        regionId,
        niches: nichesStr,
        sources: sourcesStr,
        customRssFeeds: customRssFeedsStr,
        customLinks: customLinksStr,
        customRedditFeeds: customRedditFeedsStr,
        backgroundImageUrl: backgroundImageUrl || undefined,
        imageMode: imageModeUpdate ?? null,
        tone: tone || 'Professional',
        postsPerWeek: postsPerWeek || 7,
        isEnabled: !!isEnabled,
        postingSchedule: postingScheduleUpdate ?? serializePostingSchedule(null),
        description: description || '', // ✅
        includeContactInfo,
        includeWebsiteLink,
        contactInfo: cleanedContactInfo,
        websiteUrl: normalizedWebsiteUrl,
      },
      update: {
        regionId,
        niches: nichesStr,
        sources: sourcesStr,
        customRssFeeds: customRssFeedsStr,
        customLinks: customLinksStr,
        customRedditFeeds: customRedditFeedsStr,
        backgroundImageUrl: backgroundImageUrl || null,
        tone: tone || 'Professional',
        postsPerWeek: postsPerWeek || 7,
        isEnabled: !!isEnabled,
        description: description || '', // ✅
        includeContactInfo,
        includeWebsiteLink,
        contactInfo: cleanedContactInfo,
        websiteUrl: normalizedWebsiteUrl,
        ...(postingScheduleUpdate ? { postingSchedule: postingScheduleUpdate } : {}),
        ...(imageModeUpdate !== undefined ? { imageMode: imageModeUpdate } : {}),
      }
    });

    const batchPostingSchedule = parsePostingScheduleSafe(config.postingSchedule);

    res.json({
      ...config,
      imageMode: config.imageMode ?? null,
      effectiveImageMode: resolveBotImageMode(config),
      contactInfo: config.contactInfo || '',
      websiteUrl: config.websiteUrl || '',
      includeContactInfo: config.includeContactInfo ?? false,
      includeWebsiteLink: config.includeWebsiteLink ?? false,
      postingSchedule: config.postingSchedule || null,
      batchPostingSchedule,
    });
  } catch (error) {
    console.error('Error saving bot config:', error);
    res.status(500).json({ error: 'Failed to save config' });
  }
});

router.get('/niches/expansions', requireAuth, async (req: Request, res: any) => {
  try {
    const plans = await prisma.userNicheSearchPlan.findMany({
      where: { userId: req.userId! },
      orderBy: { updatedAt: 'desc' },
    });
    res.json(
      plans.map((p) => ({
        niche: p.niche,
        domain: p.domain,
        confidence: p.confidence,
        subtopics: p.subtopics,
        queryCount: Array.isArray(p.queries) ? (p.queries as string[]).length : 0,
        generatedAt: p.generatedAt.toISOString(),
      })),
    );
  } catch (error) {
    console.error('Error fetching niche expansions:', error);
    res.status(500).json({ error: 'Failed to fetch niche expansions' });
  }
});

router.post('/niches/:niche/refresh-expansion', requireAuth, async (req: Request, res: any) => {
  try {
    const niche = decodeURIComponent(req.params.niche);
    const user = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: { region: { select: { openaiApiKey: true } } },
    });
    const service = new NicheExpansionService(decryptSecret(user?.region?.openaiApiKey));
    const plan = await service.getOrCreatePlan(req.userId!, niche, true);
    res.json({
      niche: plan.niche,
      domain: plan.domain,
      confidence: plan.confidence,
      subtopics: plan.subtopics,
      queryCount: plan.queries.length,
      generatedAt: (plan.generatedAt ?? new Date()).toISOString(),
      normalizedKey: normalizeNicheKey(niche),
    });
  } catch (error) {
    console.error('Error refreshing niche expansion:', error);
    res.status(500).json({ error: 'Failed to refresh niche expansion' });
  }
});

export default router;
