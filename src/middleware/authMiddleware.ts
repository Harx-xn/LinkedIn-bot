import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../prismaClient';
import { config } from '../config';

type JwtPayload = {
  userId: string;
};

// Role-aware authentication: verifies the token, loads the full user (role +
// region) onto `req.user`, and blocks inactive accounts. Used by the admin,
// sub-admin, region, and analytics routes that need role/region context.
export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const token = authHeader.split(' ')[1];

    // Use the shared secret from config so every auth path stays in sync.
    const decoded = jwt.verify(token, config.jwtSecret) as JwtPayload;

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        email: true,
        username: true,
        role: true,
        regionId: true,
        isActive: true,
      },
    });

    if (!user || !user.isActive) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    req.user = {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
      regionId: user.regionId,
    };

    next();
  } catch {
    return res.status(401).json({ message: 'Invalid token' });
  }
}