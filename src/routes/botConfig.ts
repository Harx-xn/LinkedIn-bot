import { Router, Request } from 'express';
import { prisma } from '../prismaClient';
import { requireAuth } from '../middleware/auth';
import {
  parseBoolean,
  cleanOptionalText,
  normalizeWebsiteUrl,
} from '../services/postContentFormatting';
import { NicheExpansionService, normalizeNicheKey } from '../services/nicheExpansionService';
import { decryptSecret } from '../services/secretCrypto';
import {
  parseBotImageModeInput,
  resolveBotImageMode,
} from '../services/botImageModeService';
import { getOwnedBrandLogoKey, normalizeBrandLogoPosition } from '../services/brandLogoService';

const router = Router();
const VALID_IMAGE_STYLES = new Set([
  'professional', 'modern', 'minimal', 'bold', 'corporate', 'abstract',
]);
const VALID_IMAGE_ASPECT_RATIOS = new Set(['1:1', '4:5', '16:9']);

// GET /bot/config - Get current user's bot config
router.get('/config', requireAuth, async (req: Request, res: any) => {
  try {
    const config = await prisma.botConfig.findUnique({
      where: { userId: req.userId }
    });

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
          }
        : {
            userId: req.userId,
            niches: '[]',
            sources: '["google"]',
            backgroundImageUrl: '',
            imageMode: null,
            effectiveImageMode: 'none',
            isEnabled: false,
            description: '',
            contactInfo: '',
            websiteUrl: '',
            includeContactInfo: false,
            includeWebsiteLink: false,
            brandLogoUrl: '',
            brandLogoEnabled: false,
            brandLogoPosition: 'bottomRight',
          }
    );
  } catch (error) {
    console.error('Error fetching bot config:', error);
    res.status(500).json({ error: 'Failed to fetch config' });
  }
});

// PUT /bot/config - Update or Create bot config (personalization/content only)
router.put('/config', requireAuth, async (req: Request, res: any) => {
  const body = req.body as Record<string, unknown>;

  const {
    niches,
    sources,
    customRssFeeds,
    customLinks,
    customRedditFeeds,
    backgroundImageUrl,
    isEnabled,
    tone,
    description,
  } = body;

  const includeContactInfo = parseBoolean(body.includeContactInfo, false);
  const includeWebsiteLink = parseBoolean(body.includeWebsiteLink, false);

  let normalizedWebsiteUrl: string | null = null;
  try {
    normalizedWebsiteUrl = normalizeWebsiteUrl(body.websiteUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid website URL' });
  }

  const cleanedContactInfo = cleanOptionalText(body.contactInfo, 500);

  let imageModeUpdate: string | null | undefined;
  if (Object.prototype.hasOwnProperty.call(body, 'imageMode')) {
    try {
      imageModeUpdate = parseBotImageModeInput(body.imageMode);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid imageMode';
      return res.status(400).json({ error: message });
    }
  }

  let imageStyleUpdate: string | undefined;
  if (Object.prototype.hasOwnProperty.call(body, 'imageStyle')) {
    if (body.imageStyle !== null && body.imageStyle !== '') {
      if (typeof body.imageStyle !== 'string') {
        return res.status(400).json({ error: 'Invalid imageStyle' });
      }
      imageStyleUpdate = body.imageStyle.trim().toLowerCase();
    }
    if (imageStyleUpdate && !VALID_IMAGE_STYLES.has(imageStyleUpdate)) {
      return res.status(400).json({ error: 'Invalid imageStyle' });
    }
  }

  let imageAspectRatioUpdate: string | undefined;
  if (Object.prototype.hasOwnProperty.call(body, 'imageAspectRatio')) {
    if (body.imageAspectRatio !== null && body.imageAspectRatio !== '') {
      if (typeof body.imageAspectRatio !== 'string') {
        return res.status(400).json({ error: 'Invalid imageAspectRatio' });
      }
      imageAspectRatioUpdate = body.imageAspectRatio.trim();
    }
    if (imageAspectRatioUpdate && !VALID_IMAGE_ASPECT_RATIOS.has(imageAspectRatioUpdate)) {
      return res.status(400).json({ error: 'Invalid imageAspectRatio' });
    }
  }

  const hasImageInstructions = Object.prototype.hasOwnProperty.call(body, 'imageInstructions');
  const imageInstructionsUpdate = hasImageInstructions
    ? (typeof body.imageInstructions === 'string' && body.imageInstructions.trim()
        ? body.imageInstructions.trim()
        : null)
    : undefined;

  try {
    const nichesStr = typeof niches === 'string' ? niches : JSON.stringify(niches || []);
    const sourcesStr = typeof sources === 'string' ? sources : JSON.stringify(sources || []);
    const customRssFeedsStr =
      typeof customRssFeeds === 'string' ? customRssFeeds : JSON.stringify(customRssFeeds || []);
    const customLinksStr =
      typeof customLinks === 'string' ? customLinks : JSON.stringify(customLinks || []);
    const customRedditFeedsStr =
      typeof customRedditFeeds === 'string'
        ? customRedditFeeds
        : JSON.stringify(customRedditFeeds || []);

    const owner = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: { regionId: true },
    });
    const regionId = owner?.regionId ?? null;

    const normalizedBackgroundImageUrl =
      typeof backgroundImageUrl === 'string' && backgroundImageUrl.trim()
        ? backgroundImageUrl.trim()
        : null;
    const brandLogoUrl = typeof body.brandLogoUrl === 'string' ? body.brandLogoUrl.trim() : '';
    if (brandLogoUrl && !getOwnedBrandLogoKey(brandLogoUrl, req.userId!)) {
      return res.status(400).json({ error: 'Invalid brand logo upload' });
    }
    const normalizedBrandLogoUrl = brandLogoUrl || null;
    const brandLogoEnabled = parseBoolean(body.brandLogoEnabled, false) && !!normalizedBrandLogoUrl;
    const brandLogoPosition = normalizeBrandLogoPosition(body.brandLogoPosition);

    const sharedContentFields = {
      regionId,
      niches: nichesStr,
      sources: sourcesStr,
      customRssFeeds: customRssFeedsStr,
      customLinks: customLinksStr,
      customRedditFeeds: customRedditFeedsStr,
      backgroundImageUrl: normalizedBackgroundImageUrl,
      brandLogoUrl: normalizedBrandLogoUrl,
      brandLogoEnabled,
      brandLogoPosition,
      tone: typeof tone === 'string' && tone.trim() ? tone : 'Professional',
      isEnabled: !!isEnabled,
      description: typeof description === 'string' ? description : '',
      includeContactInfo,
      includeWebsiteLink,
      contactInfo: cleanedContactInfo,
      websiteUrl: normalizedWebsiteUrl,
      ...(imageModeUpdate !== undefined ? { imageMode: imageModeUpdate } : {}),
      ...(imageInstructionsUpdate !== undefined
        ? { imageInstructions: imageInstructionsUpdate }
        : {}),
      ...(imageStyleUpdate !== undefined ? { imageStyle: imageStyleUpdate } : {}),
      ...(imageAspectRatioUpdate !== undefined
        ? { imageAspectRatio: imageAspectRatioUpdate }
        : {}),
    };

    const config = await prisma.botConfig.upsert({
      where: { userId: req.userId! },
      create: {
        userId: req.userId!,
        imageMode: imageModeUpdate ?? null,
        imageInstructions: imageInstructionsUpdate ?? null,
        imageStyle: imageStyleUpdate ?? null,
        imageAspectRatio: imageAspectRatioUpdate ?? null,
        ...sharedContentFields,
      },
      update: sharedContentFields,
    });

    res.json({
      ...config,
      imageMode: config.imageMode ?? null,
      effectiveImageMode: resolveBotImageMode(config),
      contactInfo: config.contactInfo || '',
      websiteUrl: config.websiteUrl || '',
      includeContactInfo: config.includeContactInfo ?? false,
      includeWebsiteLink: config.includeWebsiteLink ?? false,
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
