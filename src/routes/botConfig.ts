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

const router = Router();

// GET /bot/config - Get current user's bot config
router.get('/config', requireAuth, async (req: Request, res: any) => {
  try {
    const config = await prisma.botConfig.findUnique({
      where: { userId: req.userId }
    });

    // add description default too
    const batchPostingSchedule = parsePostingScheduleSafe(config?.postingSchedule ?? null);

    res.json(
      config
        ? {
            ...config,
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
            sources: '[]',
            backgroundImageUrl: '',
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
      }
    });

    const batchPostingSchedule = parsePostingScheduleSafe(config.postingSchedule);

    res.json({
      ...config,
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

export default router;
