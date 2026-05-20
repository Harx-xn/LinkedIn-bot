import type { UserRole } from '@prisma/client';

declare global {
  namespace Express {
    interface UserContext {
      id: string;
      email: string;
      username: string;
      role: UserRole;
      regionId: string | null;
    }

    interface Request {
      user?: UserContext;
      userId?: string;
    }
  }
}

export {};