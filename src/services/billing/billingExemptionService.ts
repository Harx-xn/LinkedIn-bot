import { UserRole } from '@prisma/client';
import { prisma } from '../../prismaClient';

export type EffectiveAccess = {
  hasAccess: boolean;
  unlimited: boolean;
  billingExempt: boolean;
  accessSource: 'BILLING_EXEMPT' | 'PRIVILEGED_ROLE' | 'STANDARD';
};

export async function getEffectiveAccess(
  userId: string,
  db: Pick<typeof prisma, 'user'> = prisma,
): Promise<EffectiveAccess> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { role: true, isBillingExempt: true },
  });
  if (!user) return { hasAccess: false, unlimited: false, billingExempt: false, accessSource: 'STANDARD' };
  if (user.isBillingExempt) {
    return { hasAccess: true, unlimited: true, billingExempt: true, accessSource: 'BILLING_EXEMPT' };
  }
  if (user.role !== UserRole.USER) {
    return { hasAccess: true, unlimited: true, billingExempt: false, accessSource: 'PRIVILEGED_ROLE' };
  }
  return { hasAccess: false, unlimited: false, billingExempt: false, accessSource: 'STANDARD' };
}

export async function hasUnlimitedAccess(userId: string): Promise<boolean> {
  return (await getEffectiveAccess(userId)).unlimited;
}
