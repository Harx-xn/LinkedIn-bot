// src/routes/public.ts
import { Router } from 'express';
import { prisma } from '../prismaClient';
import { findValidInvite } from '../services/inviteService';
import { findValidPromotion } from '../services/promotionService';
import { listPublicSettings } from '../services/settingsService';

const router = Router();

router.get('/regions', async (_req, res) => {
  const regions = await prisma.region.findMany({
    where: { isActive: true },
    select: {
      id: true,
      name: true,
      slug: true,
      code: true,
    },
    orderBy: { name: 'asc' },
  });

  res.json(regions);
});


router.get('/plans', async (req, res) => {
  const { regionId } = req.query as { regionId?: string };

  if (!regionId) {
    return res.status(400).json({ error: 'Missing regionId' });
  }

  const plans = await prisma.plan.findMany({
    where: {
      regionId,
      isActive: true,
    },
    select: {
      id: true,
      name: true,
      code: true,
      price: true,
      currency: true,
      billingCycle: true,
      fullDashboardUnlock: true,
      maxRewritesPerPost: true,
      dailyPostLimit: true,
      dailyBatchGenerationLimit: true,
      imageGenerationEnabled: true,
      dailyImageGenerationLimit: true,
    },
    orderBy: {
      price: 'asc',
    },
  });

  res.json(plans);
});


router.get('/settings', async (req, res) => {
  const { regionId } = req.query as { regionId?: string };
  const settings = await listPublicSettings(regionId);
  res.json(settings);
});

router.get('/invites/:code', async (req, res) => {
  const invite = await findValidInvite(req.params.code);

  if (!invite) {
    return res.status(404).json({ valid: false, error: 'Invite link is invalid, expired, or fully used' });
  }

  return res.json({
    valid: true,
    code: invite.code,
    email: invite.email,
    promoCode: invite.promoCode,
    region: invite.region
      ? {
          id: invite.region.id,
          name: invite.region.name,
          slug: invite.region.slug,
          code: invite.region.code,
        }
      : null,
  });
});

router.get('/promotions/:code', async (req, res) => {
  const { regionId } = req.query as { regionId?: string };
  const promo = await findValidPromotion(req.params.code, { regionId });

  if (!promo) {
    return res.status(404).json({ valid: false, error: 'Promotion is invalid, expired, or fully redeemed' });
  }

  return res.json({
    valid: true,
    code: promo.code,
    name: promo.name,
    description: promo.description,
    type: promo.type,
    extraTrialDays: promo.type === 'INTERNAL_TRIAL' ? promo.extraTrialDays : undefined,
  });
});

export default router;