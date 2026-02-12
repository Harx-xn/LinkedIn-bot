import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  console.log("meoww")
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Missing token' });

  const parts = header.split(' ');
  if (parts.length !== 2) return res.status(401).json({ error: 'Invalid auth header' });

  const token = parts[1];
  try {
    const payload = jwt.verify(token, config.jwtSecret) as { userId: string };
    (req as any).userId = payload.userId;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}
