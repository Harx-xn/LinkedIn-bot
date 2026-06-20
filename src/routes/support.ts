import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { prisma } from '../prismaClient';

const router = Router();

class SupportRequestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SupportRequestError';
  }
}

function validateTextField(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string') {
    throw new SupportRequestError(400, `${field} is required`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new SupportRequestError(400, `${field} is required`);
  }
  if (trimmed.length < min) {
    throw new SupportRequestError(400, `${field} must be at least ${min} characters`);
  }
  if (trimmed.length > max) {
    throw new SupportRequestError(400, `${field} must be at most ${max} characters`);
  }

  return trimmed;
}

function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof SupportRequestError) {
        return res.status(err.status).json({ error: err.message });
      }
      console.error('[support] error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
}

router.post(
  '/requests',
  requireAuth,
  handle(async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      throw new SupportRequestError(401, 'Unauthorized');
    }

    const subject = validateTextField(req.body?.subject, 'subject', 3, 160);
    const message = validateTextField(req.body?.message, 'message', 10, 5000);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, regionId: true },
    });
    if (!user) {
      throw new SupportRequestError(401, 'Unauthorized');
    }

    const supportRequest = await prisma.supportRequest.create({
      data: {
        userId: user.id,
        regionId: user.regionId,
        subject,
        message,
      },
      select: {
        id: true,
        subject: true,
        message: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        resolvedAt: true,
      },
    });

    res.status(201).json({ supportRequest });
  }),
);

router.get(
  '/requests',
  requireAuth,
  handle(async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      throw new SupportRequestError(401, 'Unauthorized');
    }

    const supportRequests = await prisma.supportRequest.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        subject: true,
        message: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        resolvedAt: true,
      },
    });

    res.json({ supportRequests });
  }),
);

export default router;
