import crypto from 'crypto';
import { prisma } from '../prismaClient';

export function generateInviteCode() {
  return crypto.randomBytes(8).toString('hex');
}

export async function findValidInvite(code?: string | null) {
  const normalized = code?.trim();
  if (!normalized) return null;

  const now = new Date();
  const invite = await prisma.inviteLink.findUnique({
    where: { code: normalized },
    include: { region: { select: { id: true, name: true, slug: true, code: true, isActive: true } } },
  });

  if (!invite || !invite.isActive) return null;
  if (invite.expiresAt && invite.expiresAt < now) return null;
  if (invite.maxUses !== null && invite.usedCount >= invite.maxUses) return null;
  if (invite.region && !invite.region.isActive) return null;

  return invite;
}

export async function redeemInvite(inviteLinkId: string, userId: string) {
  const redemption = await prisma.inviteRedemption.upsert({
    where: { inviteLinkId_userId: { inviteLinkId, userId } },
    create: { inviteLinkId, userId },
    update: {},
  });

  await prisma.inviteLink.update({
    where: { id: inviteLinkId },
    data: { usedCount: { increment: 1 } },
  });

  return redemption;
}
