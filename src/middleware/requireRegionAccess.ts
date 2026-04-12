import { Request, Response, NextFunction } from 'express';

export function requireRegionAccess(
  getRegionId: (req: Request) => string | undefined | null
) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (req.user.role === 'SUPER_ADMIN') {
      return next();
    }

    const targetRegionId = getRegionId(req);

    if (!targetRegionId) {
      return res.status(400).json({ message: 'Region id is required' });
    }

    if (!req.user.regionId || req.user.regionId !== targetRegionId) {
      return res.status(403).json({ message: 'Region access denied' });
    }

    next();
  };
}