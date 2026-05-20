import { google } from 'googleapis';
import { config } from '../config';

export function getGoogleOAuthClient(clientId: string, clientSecret: string) {
  return new google.auth.OAuth2(
    clientId,
    clientSecret,
    config.google.redirectUri
  );
}

export function getGoogleAuthUrl(
  clientId: string,
  clientSecret: string,
  state: string
) {
  const oAuth2Client = getGoogleOAuthClient(clientId, clientSecret);

  return oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
       'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/userinfo.email'
    ],
    state
  });
}

export async function exchangeGoogleCode(
  clientId: string,
  clientSecret: string,
  code: string
) {
  const oAuth2Client = getGoogleOAuthClient(clientId, clientSecret);
  const { tokens } = await oAuth2Client.getToken(code);
  return tokens;
}

export async function readGoogleSheetAsJson(params: {
  clientId: string;
  clientSecret: string;
  accessToken?: string | null;
  refreshToken?: string | null;
  spreadsheetId: string;
  range: string;
}) {
  const {
    clientId,
    clientSecret,
    accessToken,
    refreshToken,
    spreadsheetId,
    range
  } = params;

  const oAuth2Client = getGoogleOAuthClient(clientId, clientSecret);

  oAuth2Client.setCredentials({
    access_token: accessToken || undefined,
    refresh_token: refreshToken || undefined
  });

  const sheets = google.sheets({
    version: 'v4',
    auth: oAuth2Client
  });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range
  });

  const rows = response.data.values || [];

  if (rows.length === 0) {
    return [];
  }

  const headers = rows[0].map(header => String(header).trim());

  return rows.slice(1).map(row => {
    const item: Record<string, string> = {};

    headers.forEach((header, index) => {
      if (!header) return;
      item[header] = row[index] ? String(row[index]) : '';
    });

    return item;
  });
}
export type SheetPostInput = {
  content: string;
  hashtags?: string | null;
  scheduledAt?: Date | null;
  mediaUrl?: string | null;
};

function getCellValue(row: Record<string, string>, possibleKeys: string[]) {
  for (const key of possibleKeys) {
    const foundKey = Object.keys(row).find(
      existingKey => existingKey.toLowerCase().trim() === key.toLowerCase().trim()
    );

    if (foundKey && row[foundKey]) {
      return row[foundKey].trim();
    }
  }

  return '';
}

export async function fetchPostsFromSheet(params: {
  clientId: string;
  clientSecret: string;
  accessToken?: string | null;
  refreshToken?: string | null;
  spreadsheetId: string;
  range: string;
}): Promise<SheetPostInput[]> {
  const rows = await readGoogleSheetAsJson(params);

  return rows
    .map(row => {
      const content = getCellValue(row, [
        'content',
        'post',
        'post content',
        'text',
        'caption',
        'linkedin post'
      ]);

      const hashtags = getCellValue(row, [
        'hashtags',
        'tags',
        'hash tags'
      ]);

      const mediaUrl = getCellValue(row, [
        'mediaUrl',
        'media url',
        'image',
        'imageUrl',
        'image url'
      ]);

      const scheduledAtRaw = getCellValue(row, [
        'scheduledAt',
        'scheduled at',
        'date',
        'publish date',
        'scheduled date'
      ]);

      let scheduledAt: Date | null = null;

      if (scheduledAtRaw) {
        const parsedDate = new Date(scheduledAtRaw);

        if (!Number.isNaN(parsedDate.getTime())) {
          scheduledAt = parsedDate;
        }
      }

      return {
        content,
        hashtags: hashtags || null,
        mediaUrl: mediaUrl || null,
        scheduledAt
      };
    })
    .filter(post => post.content.length > 0);
}

export async function createLinkedInPostsSheet(params: {
  clientId: string;
  clientSecret: string;
  accessToken?: string | null;
  refreshToken?: string | null;
}) {
  const { clientId, clientSecret, accessToken, refreshToken } = params;

  const oAuth2Client = getGoogleOAuthClient(clientId, clientSecret);

  oAuth2Client.setCredentials({
    access_token: accessToken || undefined,
    refresh_token: refreshToken || undefined
  });

  const sheets = google.sheets({
    version: 'v4',
    auth: oAuth2Client
  });

  const response = await sheets.spreadsheets.create({
    requestBody: {
      properties: {
        title: 'LinkedIn Bot Posts'
      },
      sheets: [
        {
          properties: {
            title: 'Posts'
          }
        }
      ]
    }
  });

  const spreadsheetId = response.data.spreadsheetId;
  const spreadsheetUrl = response.data.spreadsheetUrl;

  if (!spreadsheetId) {
    throw new Error('Google did not return a spreadsheet ID.');
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'Posts!A1:E2',
    valueInputOption: 'RAW',
    requestBody: {
      values: [
        ['content', 'hashtags', 'scheduledAt', 'mediaUrl', 'status'],
        [
          'Write your LinkedIn post here',
          '#linkedin #automation',
          '2026-05-21 10:00',
          '',
          'DRAFT'
        ]
      ]
    }
  });

  return {
    spreadsheetId,
    spreadsheetUrl,
    range: 'Posts!A1:Z1000'
  };
}