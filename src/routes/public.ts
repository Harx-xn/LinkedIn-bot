// src/routes/public.ts
import { Router } from 'express';
import { prisma } from '../prismaClient';

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
    },
    orderBy: {
      price: 'asc',
    },
  });

  res.json(plans);
});

export default router;