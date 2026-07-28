import { Router, Request } from 'express';
import { Prisma } from '@prisma/client';
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
import {
  BOT_STRATEGY_FIELDS,
  BotStrategyValidationError,
  buildEffectiveBotStrategy,
  hasAnyStrategyFields,
  parseStrategyFieldUpdate,
  resolveOnboardingStatus,
  syncPrimaryPillarsToNiches,
  type BotStrategyField,
} from '../services/botStrategyService';

const router = Router();
const VALID_IMAGE_STYLES = new Set([
  'professional', 'modern', 'minimal', 'bold', 'corporate', 'abstract',
]);
const VALID_IMAGE_ASPECT_RATIOS = new Set(['1:1', '4:5', '16:9']);
const TIME_SLOT_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const hasOwn = (body: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(body, key);

function parseTimeSlots(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Add at least one time slot.');
  }
  const slots = value.map((slot) => typeof slot === 'string' ? slot.trim() : '');
  if (slots.some((slot) => !TIME_SLOT_PATTERN.test(slot))) {
    throw new Error('Each time slot must use HH:mm format.');
  }
  const unique = Array.from(new Set(slots));
  if (unique.length !== slots.length) throw new Error('Time slots must be unique.');
  return unique.sort();
}

function serializeBotConfig(config: any) {
  return {
    ...config,
    imageMode: config.imageMode ?? null,
    effectiveImageMode: resolveBotImageMode(config),
    contactInfo: config.contactInfo || '',
    websiteUrl: config.websiteUrl || '',
    includeContactInfo: config.includeContactInfo ?? false,
    includeWebsiteLink: config.includeWebsiteLink ?? false,
    effectiveStrategy: buildEffectiveBotStrategy(config),
  };
}

// GET /bot/config - Get current user's bot config
router.get('/config', requireAuth, async (req: Request, res: any) => {
  try {
    const owner = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: { regionId: true },
    });
    const config = await prisma.botConfig.upsert({
      where: { userId: req.userId! },
      create: {
        userId: req.userId!,
        regionId: owner?.regionId ?? null,
        niches: '[]',
        sources: '["google"]',
        timeSlots: ['09:00'],
      },
      update: {},
    });
    res.json(serializeBotConfig(config));
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
    backgroundImageUrl,
    isEnabled,
    tone,
    description,
  } = body;

  let imageModeUpdate: string | null | undefined;
  if (hasOwn(body, 'imageMode')) {
    try {
      imageModeUpdate = parseBotImageModeInput(body.imageMode);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid imageMode';
      return res.status(400).json({ error: message });
    }
  }

  let imageStyleUpdate: string | undefined;
  if (hasOwn(body, 'imageStyle')) {
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
  if (hasOwn(body, 'imageAspectRatio')) {
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

  const hasImageInstructions = hasOwn(body, 'imageInstructions');
  const imageInstructionsUpdate = hasImageInstructions
    ? (typeof body.imageInstructions === 'string' && body.imageInstructions.trim()
        ? body.imageInstructions.trim()
        : null)
    : undefined;

  try {
    const existingConfig = await prisma.botConfig.findUnique({
      where: { userId: req.userId! },
    });

    const hasNiches = hasOwn(body, 'niches');
    const hasSources = hasOwn(body, 'sources');
    const hasBackgroundImageUrl = hasOwn(body, 'backgroundImageUrl');
    const hasTone = hasOwn(body, 'tone');
    const hasDescription = hasOwn(body, 'description');
    const hasIsEnabled = hasOwn(body, 'isEnabled');
    const hasIncludeContactInfo = hasOwn(body, 'includeContactInfo');
    const hasIncludeWebsiteLink = hasOwn(body, 'includeWebsiteLink');
    const hasContactInfo = hasOwn(body, 'contactInfo');
    const hasWebsiteUrl = hasOwn(body, 'websiteUrl');
    const hasBrandLogoUrl = hasOwn(body, 'brandLogoUrl');
    const hasBrandLogoEnabled = hasOwn(body, 'brandLogoEnabled');
    const hasBrandLogoPosition = hasOwn(body, 'brandLogoPosition');
    const hasTimeSlots = hasOwn(body, 'timeSlots');
    let timeSlotsUpdate: string[] | undefined;
    if (hasTimeSlots) {
      try {
        timeSlotsUpdate = parseTimeSlots(body.timeSlots);
      } catch (err) {
        return res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid time slots' });
      }
    }

    const nichesStr = hasNiches
      ? (typeof niches === 'string' ? niches : JSON.stringify(niches || []))
      : existingConfig?.niches ?? '[]';
    const sourcesStr = hasSources
      ? (typeof sources === 'string' ? sources : JSON.stringify(sources || []))
      : existingConfig?.sources ?? '["google"]';


    let normalizedWebsiteUrl: string | null | undefined;
    if (hasWebsiteUrl) {
      try {
        normalizedWebsiteUrl = normalizeWebsiteUrl(body.websiteUrl);
      } catch {
        return res.status(400).json({ error: 'Invalid website URL' });
      }
    }

    const cleanedContactInfo = hasContactInfo
      ? cleanOptionalText(body.contactInfo, 500)
      : undefined;

    const owner = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: { regionId: true },
    });
    const regionId = owner?.regionId ?? null;

    const normalizedBackgroundImageUrl = hasBackgroundImageUrl
      ? (typeof backgroundImageUrl === 'string' && backgroundImageUrl.trim()
        ? backgroundImageUrl.trim()
        : null)
      : undefined;

    const brandLogoUrl = hasBrandLogoUrl
      ? (typeof body.brandLogoUrl === 'string' ? body.brandLogoUrl.trim() : '')
      : existingConfig?.brandLogoUrl ?? '';
    if (hasBrandLogoUrl && brandLogoUrl && !getOwnedBrandLogoKey(brandLogoUrl, req.userId!)) {
      return res.status(400).json({ error: 'Invalid brand logo upload' });
    }
    const normalizedBrandLogoUrl = hasBrandLogoUrl ? brandLogoUrl || null : undefined;
    const brandLogoEnabled = hasBrandLogoEnabled
      ? parseBoolean(body.brandLogoEnabled, false) && !!brandLogoUrl
      : undefined;
    const brandLogoPosition = hasBrandLogoPosition
      ? normalizeBrandLogoPosition(body.brandLogoPosition)
      : undefined;

    const legacyForStrategy = {
      ...existingConfig,
      niches: nichesStr,
      sources: sourcesStr,
      tone: hasTone
        ? (typeof tone === 'string' && tone.trim() ? tone : 'Professional')
        : existingConfig?.tone ?? 'Professional',
      description: hasDescription
        ? (typeof description === 'string' ? description : '')
        : existingConfig?.description ?? '',
    };

    const strategyUpdates: Partial<Record<BotStrategyField, Prisma.InputJsonValue | typeof Prisma.DbNull>> = {};
    for (const field of BOT_STRATEGY_FIELDS) {
      if (!hasOwn(body, field)) continue;
      try {
        const parsed = parseStrategyFieldUpdate(field, body[field], legacyForStrategy);
        strategyUpdates[field] = parsed === null ? Prisma.DbNull : parsed as Prisma.InputJsonValue;
      } catch (err) {
        if (err instanceof BotStrategyValidationError) {
          return res.status(400).json({ error: err.message });
        }
        throw err;
      }
    }

    // The simple niche editor and the structured strategy editor represent the
    // same primary topics. If only niches were changed, remove stale pillars so
    // topic generation cannot continue prioritizing the previous niche set.
    if (hasNiches && !hasOwn(body, 'contentPillars')) {
      const nextNiches = buildEffectiveBotStrategy({ niches: nichesStr }).legacy.niches;
      const currentPillars = buildEffectiveBotStrategy(existingConfig).contentPillars;
      strategyUpdates.contentPillars = syncPrimaryPillarsToNiches(
        currentPillars,
        nextNiches,
      ) as Prisma.InputJsonValue;
    }

    const mergedStrategyState = Object.fromEntries(
      BOT_STRATEGY_FIELDS.map((field) => [
        field,
        hasOwn(strategyUpdates, field)
          ? strategyUpdates[field]
          : existingConfig?.[field] ?? null,
      ]),
    ) as Partial<Record<BotStrategyField, unknown>>;
    const onboardingStatus = resolveOnboardingStatus(hasAnyStrategyFields(mergedStrategyState));

    const updateFields = {
      regionId,
      ...(hasNiches ? { niches: nichesStr } : {}),
      ...(hasSources ? { sources: sourcesStr } : {}),
      ...(hasBackgroundImageUrl ? { backgroundImageUrl: normalizedBackgroundImageUrl } : {}),
      ...(hasBrandLogoUrl ? { brandLogoUrl: normalizedBrandLogoUrl } : {}),
      ...(hasBrandLogoEnabled ? { brandLogoEnabled } : {}),
      ...(hasBrandLogoPosition ? { brandLogoPosition } : {}),
      ...(timeSlotsUpdate ? { timeSlots: timeSlotsUpdate } : {}),
      ...(hasTone
        ? { tone: typeof tone === 'string' && tone.trim() ? tone : 'Professional' }
        : {}),
      ...(hasIsEnabled ? { isEnabled: !!isEnabled } : {}),
      ...(hasDescription ? { description: typeof description === 'string' ? description : '' } : {}),
      ...(hasIncludeContactInfo ? { includeContactInfo: parseBoolean(body.includeContactInfo, false) } : {}),
      ...(hasIncludeWebsiteLink ? { includeWebsiteLink: parseBoolean(body.includeWebsiteLink, false) } : {}),
      ...(hasContactInfo ? { contactInfo: cleanedContactInfo } : {}),
      ...(hasWebsiteUrl ? { websiteUrl: normalizedWebsiteUrl } : {}),
      ...(imageModeUpdate !== undefined ? { imageMode: imageModeUpdate } : {}),
      ...(imageInstructionsUpdate !== undefined
        ? { imageInstructions: imageInstructionsUpdate }
        : {}),
      ...(imageStyleUpdate !== undefined ? { imageStyle: imageStyleUpdate } : {}),
      ...(imageAspectRatioUpdate !== undefined
        ? { imageAspectRatio: imageAspectRatioUpdate }
        : {}),
      ...strategyUpdates,
      onboardingStatus,
    };

    const createFields = {
      regionId,
      niches: nichesStr,
      sources: sourcesStr,
      backgroundImageUrl: normalizedBackgroundImageUrl ?? null,
      brandLogoUrl: normalizedBrandLogoUrl ?? null,
      brandLogoEnabled: brandLogoEnabled ?? false,
      brandLogoPosition: brandLogoPosition ?? 'bottomRight',
      timeSlots: timeSlotsUpdate ?? ['09:00'],
      tone: hasTone && typeof tone === 'string' && tone.trim() ? tone : 'Professional',
      isEnabled: hasIsEnabled ? !!isEnabled : false,
      description: hasDescription && typeof description === 'string' ? description : '',
      includeContactInfo: hasIncludeContactInfo ? parseBoolean(body.includeContactInfo, false) : false,
      includeWebsiteLink: hasIncludeWebsiteLink ? parseBoolean(body.includeWebsiteLink, false) : false,
      contactInfo: cleanedContactInfo ?? null,
      websiteUrl: normalizedWebsiteUrl ?? null,
      imageMode: imageModeUpdate ?? null,
      imageInstructions: imageInstructionsUpdate ?? null,
      imageStyle: imageStyleUpdate ?? null,
      imageAspectRatio: imageAspectRatioUpdate ?? null,
      ...strategyUpdates,
      onboardingStatus,
    };

    const config = await prisma.botConfig.upsert({
      where: { userId: req.userId! },
      create: {
        userId: req.userId!,
        ...createFields,
      },
      update: updateFields,
    });

    res.json(serializeBotConfig(config));
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
