// Analytics API: a single dashboard payload (overview, growth, revenue, plan
// breakdown, post activity, and per-sub-admin rollups). The scope is derived
// from the caller's role so a regional admin only ever sees their own region.
import { Router } from 'express';
import { UserRole } from '@prisma/client';
import { authMiddleware } from '../middleware/authMiddleware';
import { requireRole } from '../middleware/requireRole';
import {
  getOverview,
  getGrowthSeries,
  getRevenueSeries,
  getPlanBreakdown,
  getActivity,
  getSubAdminRollups,
} from '../services/analyticsService';

const router = Router();

router.use(authMiddleware);
router.use(requireRole(UserRole.SUPER_ADMIN, UserRole.REGIONAL_ADMIN));

// Resolve the analytics scope from role.
// REGIONAL_ADMIN -> locked to own region.
// SUPER_ADMIN    -> platform-wide, or a single region via ?regionId.
function getScope(req: any): { regionId?: string } {
  if (req.user.role === UserRole.REGIONAL_ADMIN) {
    if (!req.user.regionId) throw new Error('User has no region assigned');
    return { regionId: req.user.regionId };
  }
  const rid = req.query?.regionId ? String(req.query.regionId) : undefined;
  return rid ? { regionId: rid } : {};
}

router.get('/dashboard', async (req, res) => {
  try {
    const scope = getScope(req);
    const months = req.query.months ? Math.min(24, Number(req.query.months)) : 12;

    const [overview, growth, revenue, plans, activity] = await Promise.all([
      getOverview(scope),
      getGrowthSeries(scope, months),
      getRevenueSeries(scope, months),
      getPlanBreakdown(scope),
      getActivity(scope),
    ]);

    const isSuper = req.user!.role === UserRole.SUPER_ADMIN && !scope.regionId;
    const subAdmins = isSuper ? await getSubAdminRollups() : undefined;

    return res.json({ scope, overview, growth, revenue, plans, activity, subAdmins });
  } catch (error: any) {
    return res.status(400).json({ message: error.message });
  }
});

export default router;
