import { prisma } from '../../prismaClient';

export interface CreateNotificationInput {
  userId: string;
  type: string;
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
  dedupeKey?: string;
}

export async function createNotification(input: CreateNotificationInput) {
  if (input.dedupeKey) {
    const existing = await prisma.notification.findFirst({
      where: {
        userId: input.userId,
        type: input.type,
        metadata: { path: ['dedupeKey'], equals: input.dedupeKey },
      },
    });
    if (existing) return existing;
  }

  return prisma.notification.create({
    data: {
      userId: input.userId,
      type: input.type,
      title: input.title,
      message: input.message,
      metadata: {
        ...(input.metadata ?? {}),
        ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
        actionPath: '/billing',
      },
    },
  });
}

export async function listUserNotifications(userId: string, limit = 50) {
  return prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

export async function markNotificationRead(userId: string, notificationId: string) {
  const row = await prisma.notification.findFirst({
    where: { id: notificationId, userId },
  });
  if (!row) return null;
  return prisma.notification.update({
    where: { id: notificationId },
    data: { readAt: new Date() },
  });
}

export async function markAllNotificationsRead(userId: string) {
  await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });
}
