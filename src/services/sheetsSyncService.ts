import { prisma } from '../prismaClient';

export function isGoogleInvalidGrantError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  const responseMessage =
    typeof err === 'object' && err !== null && 'response' in err
      ? String((err as { response?: { data?: { error?: string } } }).response?.data?.error ?? '')
      : '';
  return /invalid_grant/i.test(message) || /invalid_grant/i.test(responseMessage);
}

export async function markSheetConfigReauthRequired(userId: string, message = 'Google authorization expired or was revoked') {
  await prisma.sheetConfig.updateMany({
    where: { userId },
    data: {
      active: false,
      authStatus: 'REAUTH_REQUIRED',
      lastSyncError: message.slice(0, 500),
    },
  });
}

export async function handleSheetSyncError(configId: string, userId: string, err: unknown): Promise<'reauth' | 'retryable'> {
  if (isGoogleInvalidGrantError(err)) {
    await markSheetConfigReauthRequired(userId);
    console.warn('[sheets] reconnect required', { configId, userId });
    return 'reauth';
  }

  const message = err instanceof Error ? err.message : String(err);
  await prisma.sheetConfig.updateMany({
    where: { id: configId },
    data: { lastSyncError: message.slice(0, 500) },
  });
  return 'retryable';
}
