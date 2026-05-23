import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { prisma } from '../prismaClient';

// Authenticates a request from the `Authorization: Bearer <token>` header and
// attaches `req.userId`. Also rejects tokens for deleted or deactivated users
// so a disabled account cannot keep using a previously issued token.
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Missing token' });

  const parts = header.split(' ');
  if (parts.length !== 2) return res.status(401).json({ error: 'Invalid auth header' });

  const token = parts[1];
  try {
    const payload = jwt.verify(token, config.jwtSecret) as { userId: string };

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, isActive: true },
    });
    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'Account inactive or not found' });
    }

    (req as any).userId = payload.userId;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}
