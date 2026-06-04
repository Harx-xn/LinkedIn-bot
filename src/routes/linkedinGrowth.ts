import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { getLinkedInGrowthDashboard } from '../services/linkedinGrowthDashboardService';
import { invalidateAnalyticsCache } from '../services/linkedinAnalyticsService';

const router = Router();

// New primary endpoint: GET /api/linkedin-growth/dashboard
router.get('/dashboard', requireAuth, async (req, res) => {
  const userId = (req as any).userId as string | undefined;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const dashboard = await getLinkedInGrowthDashboard(userId);
    return res.json(dashboard);
  } catch (err) {
    console.error('LinkedIn growth dashboard error:', err);
    return res.status(500).json({ error: 'Failed to load LinkedIn growth dashboard' });
  }
});

// Compatibility endpoint: GET /api/linkedin-growth/summary
// Kept for older frontends that still call the previous "summary" concept.
// It now returns the same dashboard payload from the unified service.
router.get('/summary', requireAuth, async (req, res) => {
  const userId = (req as any).userId as string | undefined;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const dashboard = await getLinkedInGrowthDashboard(userId);
    return res.json(dashboard);
  } catch (err) {
    console.error('LinkedIn growth dashboard error:', err);
    return res.status(500).json({ error: 'Failed to load LinkedIn growth dashboard' });
  }
});

// Force the next dashboard load to re-fetch live analytics from LinkedIn
// (bypassing the in-memory cache). Useful after publishing or reconnecting.
router.post('/refresh-analytics', requireAuth, async (req, res) => {
  const userId = (req as any).userId as string | undefined;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    invalidateAnalyticsCache(userId);
    return res.json({ ok: true });
  } catch (err) {
    console.error('LinkedIn growth refresh error:', err);
    return res.status(500).json({ error: 'Failed to refresh LinkedIn analytics' });
  }
});

export default router;
