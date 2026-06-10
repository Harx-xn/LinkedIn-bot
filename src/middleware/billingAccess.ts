import { Request, Response, NextFunction } from 'express';
import { UserRole } from '@prisma/client';
import { prisma } from '../prismaClient';
import { hasDashboardAccess } from '../services/billing/billingAccessService';

/**
 * Blocks entitlement-protected features for users who have not completed billing
 * setup (BILLING_REQUIRED, TRIAL_PENDING, etc.). Admins are always allowed.
 */
export async function requireDashboardAccess(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const userId = (req as any).userId as string | undefined;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });

  if (!user) {
    return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
  }

  if (user.role !== UserRole.USER) {
    return next();
  }

  const allowed = await hasDashboardAccess(userId);
  if (!allowed) {
    return res.status(403).json({
      error: 'Complete billing setup to access this feature.',
      code: 'BILLING_REQUIRED',
    });
  }

  return next();
}
