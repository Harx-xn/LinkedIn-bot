import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { getRecentDashboardActivity } from '../services/dashboardRecentActivityService';

const router = Router();

router.get('/recent-activity', requireAuth, async (req: Request, res: Response) => {
  const userId = (req as any).userId as string | undefined;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const activities = await getRecentDashboardActivity(userId);
    return res.json({ activities });
  } catch (error) {
    console.error('[dashboard] failed to load recent activity:', error);
    return res.status(500).json({ error: 'Failed to load recent activity' });
  }
});

export default router;
