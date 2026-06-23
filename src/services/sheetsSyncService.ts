import { prisma } from '../prismaClient';
import {
  ensureGoogleSheetAppPostIdColumn,
  fetchPostsFromSheet,
  updateGoogleSheetValues,
} from './sheetsService';
import { getUsableLinkedInAccountForUser } from './linkedinService';

export const APP_POST_STATUSES = [
  'DRAFT',
  'REVIEW',
  'QUEUED',
  'PUBLISHED',
  'FAILED',
] as const;

export type AppPostStatus = (typeof APP_POST_STATUSES)[number];

export function normalizeSheetPostStatus(value?: string | null): {
  status: AppPostStatus | null;
  skip: boolean;
  invalid: boolean;
} {
  const normalized = value?.trim().toUpperCase();

  if (!normalized) {
    return { status: null, skip: false, invalid: false };
  }

  if (normalized === 'SKIP') {
    return { status: null, skip: true, invalid: false };
  }

  const aliases: Record<string, AppPostStatus> = {
    DRAFT: 'DRAFT',
    REVIEW: 'REVIEW',
    QUEUE: 'QUEUED',
    QUEUED: 'QUEUED',
    SCHEDULE: 'QUEUED',
    SCHEDULED: 'QUEUED',
    PUBLISH: 'PUBLISHED',
    PUBLISHED: 'PUBLISHED',
    POSTED: 'PUBLISHED',
    FAIL: 'FAILED',
    FAILED: 'FAILED',
    ERROR: 'FAILED',
  };
  const status = aliases[normalized] || null;

  return {
    status,
    skip: false,
    invalid: status === null,
  };
}

export type SheetSyncResult = {
  created: number;
  updated: number;
  skipped: number;
  invalid: number;
  rowsFound: number;
  schemaUpgraded: boolean;
  errors: string[];
};

export async function syncGoogleSheetPosts(params: {
  config: {
    id: string;
    userId: string;
    regionId?: string | null;
    spreadsheetId: string;
    range: string;
    accessToken?: string | null;
    refreshToken?: string | null;
  };
  clientId: string;
  clientSecret: string;
}): Promise<SheetSyncResult> {
  const { config, clientId, clientSecret } = params;
  const googleParams = {
    clientId,
    clientSecret,
    accessToken: config.accessToken,
    refreshToken: config.refreshToken,
    spreadsheetId: config.spreadsheetId,
    range: config.range,
  };
  const idColumn = await ensureGoogleSheetAppPostIdColumn(googleParams);
  const sheetName = config.range.includes('!')
    ? config.range.slice(0, config.range.indexOf('!'))
    : 'Posts';
  const rows = await fetchPostsFromSheet({
    ...googleParams,
    range: `${sheetName}!A1:ZZ1000`,
  });
  const linkedInAccount = await getUsableLinkedInAccountForUser(config.userId);
  const result: SheetSyncResult = {
    created: 0,
    updated: 0,
    skipped: 0,
    invalid: 0,
    rowsFound: rows.length,
    schemaUpgraded: idColumn.schemaUpgraded,
    errors: [],
  };

  for (const row of rows) {
    const rowLabel = row.sheetRowNumber
      ? `Row ${row.sheetRowNumber}`
      : 'Sheet row';
    const normalizedStatus = normalizeSheetPostStatus(row.status);

    if (normalizedStatus.skip) {
      result.skipped++;
      continue;
    }

    if (normalizedStatus.invalid) {
      result.invalid++;
      result.errors.push(`${rowLabel}: invalid status "${row.status}".`);
    }

    try {
      let existingPost = row.appPostId
        ? await prisma.post.findFirst({
            where: {
              id: row.appPostId,
              userId: config.userId,
            },
          })
        : null;

      if (!existingPost) {
        existingPost = await prisma.post.findFirst({
          where: {
            userId: config.userId,
            content: row.content,
            source: 'GOOGLE_SHEET',
          },
        });
      }

      const statusForCreate =
        normalizedStatus.status || (row.scheduledAt ? 'QUEUED' : 'DRAFT');
      const post = existingPost
        ? await (async () => {
            await prisma.post.updateMany({
              where: {
                id: existingPost.id,
                userId: config.userId,
              },
              data: {
                linkedinAccountId: linkedInAccount?.id || null,
                content: row.content,
                hashtags: row.hashtags,
                mediaUrl: row.mediaUrl,
                scheduledAt: row.scheduledAt,
                ...(normalizedStatus.status
                  ? {
                      status: normalizedStatus.status,
                      errorMessage: null,
                    }
                  : {}),
              },
            });

            return { id: existingPost.id };
          })()
        : await prisma.post.create({
            data: {
              userId: config.userId,
              regionId: config.regionId,
              linkedinAccountId: linkedInAccount?.id || null,
              content: row.content,
              hashtags: row.hashtags,
              mediaUrl: row.mediaUrl,
              scheduledAt: row.scheduledAt,
              source: 'GOOGLE_SHEET',
              status: statusForCreate,
            },
          });

      if (existingPost) {
        result.updated++;
      } else {
        result.created++;
      }

      if (
        row.sheetRowNumber &&
        (!row.appPostId || row.appPostId !== post.id)
      ) {
        await updateGoogleSheetValues({
          ...googleParams,
          range: `${sheetName}!${idColumn.column}${row.sheetRowNumber}`,
          values: [[post.id]],
        });
      }
    } catch (err) {
      result.skipped++;
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`${rowLabel}: ${message}`);
    }
  }

  await prisma.sheetConfig.update({
    where: { id: config.id },
    data: {
      lastSyncError: result.errors.length
        ? result.errors.join(' ').slice(0, 500)
        : null,
    },
  });

  return result;
}

export function isGoogleInvalidGrantError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  const responseMessage =
    typeof err === 'object' && err !== null && 'response' in err
      ? String((err as { response?: { data?: { error?: string } } }).response?.data?.error ?? '')
      : '';
  return (
    /invalid_grant|reconnect required|revoked|expired|missing a refresh token/i.test(message) ||
    /invalid_grant/i.test(responseMessage)
  );
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
