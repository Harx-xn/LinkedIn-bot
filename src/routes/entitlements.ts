import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { getUserPlanEntitlements } from '../services/planEntitlementService';

const router = Router();

// GET /entitlements/me - current user's plan entitlements + usage/remaining.
router.get('/me', requireAuth, async (req: Request, res: Response) => {
  const userId = (req as any).userId as string | undefined;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const entitlements = await getUserPlanEntitlements(userId);
    return res.json(entitlements);
  } catch (err) {
    console.error('[entitlements] failed to load entitlements:', err);
    return res.status(500).json({ error: 'Failed to load entitlements' });
  }
});

export default router;
