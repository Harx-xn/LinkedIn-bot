  import { google } from "googleapis";
  import { config } from "../config";

  export const GOOGLE_OAUTH_SCOPES = [
    "https://www.googleapis.com/auth/drive.file",
  ];

  function getGoogleErrorText(err: unknown) {
    const message = err instanceof Error ? err.message : String(err ?? "");
    const responseData =
      typeof err === "object" && err !== null && "response" in err
        ? (err as { response?: { data?: unknown } }).response?.data
        : undefined;

    if (!responseData) return message;

    if (typeof responseData === "string") {
      return `${message} ${responseData}`.trim();
    }

    if (typeof responseData === "object" && responseData !== null) {
      const data = responseData as {
        error?: string;
        error_description?: string;
        message?: string;
      };
      return [
        message,
        data.error,
        data.error_description,
        data.message,
      ]
        .filter(Boolean)
        .join(" ");
    }

    return message;
  }

  function getGoogleErrorStatus(err: unknown) {
    if (typeof err !== "object" || err === null) return undefined;
    const maybeError = err as {
      code?: number;
      status?: number;
      response?: { status?: number };
    };
    return maybeError.code || maybeError.status || maybeError.response?.status;
  }

  export function getGoogleSheetsAccessErrorMessage(err: unknown) {
    const status = getGoogleErrorStatus(err);
    const text = getGoogleErrorText(err);

    if (/missing_refresh_token/i.test(text)) {
      return "Google Sheets reconnect required: the saved Google connection is missing a refresh token.";
    }

    if (status === 401 || /invalid_grant|invalid_token|token.*revoked|unauthorized/i.test(text)) {
      return "Google Sheets reconnect required: Google access was revoked or expired.";
    }

    if (status === 404 || /not[ _-]?found|requested entity was not found/i.test(text)) {
      return "Google Sheet not found. It may have been deleted, moved, or the spreadsheet ID is incorrect.";
    }

    if (status === 403 || /insufficient|forbidden|permission|access.*denied/i.test(text)) {
      return "Google denied access to this spreadsheet. With limited Google permissions, use a sheet created by this app or reconnect Google and choose a sheet through the app.";
    }

    return null;
  }

  function ensureRefreshToken(refreshToken?: string | null) {
    if (!refreshToken) {
      throw new Error("missing_refresh_token");
    }
  }

  function normalizeGoogleSheetsError(err: unknown): never {
    throw new Error(getGoogleSheetsAccessErrorMessage(err) || (err instanceof Error ? err.message : String(err)));
  }

  export function getGoogleOAuthClient(clientId: string, clientSecret: string) {
    return new google.auth.OAuth2(
      clientId,
      clientSecret,
      config.google.redirectUri,
    );
  }

  export function getGoogleAuthUrl(
    clientId: string,
    clientSecret: string,
    state: string,
  ) {
    const oAuth2Client = getGoogleOAuthClient(clientId, clientSecret);

    return oAuth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: GOOGLE_OAUTH_SCOPES,
      state,
    });
  }

  export async function exchangeGoogleCode(
    clientId: string,
    clientSecret: string,
    code: string,
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
      range,
    } = params;

    ensureRefreshToken(refreshToken);

    const oAuth2Client = getGoogleOAuthClient(clientId, clientSecret);

    oAuth2Client.setCredentials({
      access_token: accessToken || undefined,
      refresh_token: refreshToken || undefined,
    });

    const sheets = google.sheets({
      version: "v4",
      auth: oAuth2Client,
    });

    const response = await sheets.spreadsheets.values
      .get({
        spreadsheetId,
        range,
      })
      .catch(normalizeGoogleSheetsError);

    const rows = response.data.values || [];

    if (rows.length === 0) {
      return [];
    }

    const headers = rows[0].map((header) => String(header).trim());

    return rows.slice(1).map((row) => {
      const item: Record<string, string> = {};

      headers.forEach((header, index) => {
        if (!header) return;
        item[header] = row[index] ? String(row[index]) : "";
      });

      return item;
    });
  }
  export type SheetPostInput = {
    appPostId?: string | null;
    sheetRowNumber?: number;
    content: string;
    hashtags?: string | null;
    scheduledAt?: Date | null;
    mediaUrl?: string | null;
    status?: string | null;
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
      .map((row, index) => {
        const appPostId = getCellValue(row, [
          'appPostId',
          'app post id',
          'postId',
          'post id',
          'id'
        ]);

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
          'image url',
          'media'
        ]);

        const scheduledAtRaw = getCellValue(row, [
          'scheduledAt',
          'scheduled at',
          'date',
          'publish date',
          'scheduled date'
        ]);

        const statusRaw = getCellValue(row, [
          'status',
          'state'
        ]);

        let scheduledAt: Date | null = null;

        if (scheduledAtRaw) {
          const parsedDate = new Date(scheduledAtRaw);

          if (!Number.isNaN(parsedDate.getTime())) {
            scheduledAt = parsedDate;
          }
        }

        return {
          appPostId: appPostId || null,
          sheetRowNumber: index + 2,
          content,
          hashtags: hashtags || null,
          mediaUrl: mediaUrl || null,
          scheduledAt,
          status: statusRaw || null
        };
      })
      .filter(post => post.content.length > 0);
  }

  function getSheetName(range: string) {
    const separatorIndex = range.indexOf("!");
    return separatorIndex >= 0 ? range.slice(0, separatorIndex) : "Posts";
  }

  export function getGoogleSheetColumnName(columnNumber: number) {
    let current = columnNumber;
    let result = "";

    while (current > 0) {
      const remainder = (current - 1) % 26;
      result = String.fromCharCode(65 + remainder) + result;
      current = Math.floor((current - 1) / 26);
    }

    return result;
  }

  export async function updateGoogleSheetValues(params: {
    clientId: string;
    clientSecret: string;
    accessToken?: string | null;
    refreshToken?: string | null;
    spreadsheetId: string;
    range: string;
    values: string[][];
  }) {
    const {
      clientId,
      clientSecret,
      accessToken,
      refreshToken,
      spreadsheetId,
      range,
      values,
    } = params;

    ensureRefreshToken(refreshToken);

    const oAuth2Client = getGoogleOAuthClient(clientId, clientSecret);
    oAuth2Client.setCredentials({
      access_token: accessToken || undefined,
      refresh_token: refreshToken || undefined,
    });

    const sheets = google.sheets({ version: "v4", auth: oAuth2Client });

    await sheets.spreadsheets.values
      .update({
        spreadsheetId,
        range,
        valueInputOption: "RAW",
        requestBody: { values },
      })
      .catch(normalizeGoogleSheetsError);
  }

  export async function ensureGoogleSheetAppPostIdColumn(params: {
    clientId: string;
    clientSecret: string;
    accessToken?: string | null;
    refreshToken?: string | null;
    spreadsheetId: string;
    range: string;
  }) {
    const sheetName = getSheetName(params.range);
    const headerRange = `${sheetName}!1:1`;

    ensureRefreshToken(params.refreshToken);
    const oAuth2Client = getGoogleOAuthClient(params.clientId, params.clientSecret);
    oAuth2Client.setCredentials({
      access_token: params.accessToken || undefined,
      refresh_token: params.refreshToken || undefined,
    });

    const sheets = google.sheets({ version: "v4", auth: oAuth2Client });
    const response = await sheets.spreadsheets.values
      .get({
        spreadsheetId: params.spreadsheetId,
        range: headerRange,
      })
      .catch(normalizeGoogleSheetsError);
    const headers = (response.data.values?.[0] || []).map(value =>
      String(value).trim(),
    );
    const existingIndex = headers.findIndex(header =>
      ["apppostid", "app post id", "postid", "post id", "id"].includes(
        header.toLowerCase(),
      ),
    );

    if (existingIndex >= 0) {
      return {
        column: getGoogleSheetColumnName(existingIndex + 1),
        schemaUpgraded: false,
      };
    }

    const nextColumn = getGoogleSheetColumnName(headers.length + 1);
    await updateGoogleSheetValues({
      ...params,
      range: `${sheetName}!${nextColumn}1`,
      values: [["appPostId"]],
    });

    return {
      column: nextColumn,
      schemaUpgraded: true,
    };
  }

  export async function createLinkedInPostsSheet(params: {
    clientId: string;
    clientSecret: string;
    accessToken?: string | null;
    refreshToken?: string | null;
  }) {
    const { clientId, clientSecret, accessToken, refreshToken } = params;

    ensureRefreshToken(refreshToken);

    const oAuth2Client = getGoogleOAuthClient(clientId, clientSecret);

    oAuth2Client.setCredentials({
      access_token: accessToken || undefined,
      refresh_token: refreshToken || undefined,
    });

    const sheets = google.sheets({
      version: "v4",
      auth: oAuth2Client,
    });

    const response = await sheets.spreadsheets
      .create({
        requestBody: {
          properties: {
            title: "LinkedIn Bot Posts",
          },
          sheets: [
            {
              properties: {
                title: "Posts",
              },
            },
          ],
        },
      })
      .catch(normalizeGoogleSheetsError);

    const spreadsheetId = response.data.spreadsheetId;
    const spreadsheetUrl = response.data.spreadsheetUrl;

    if (!spreadsheetId) {
      throw new Error("Google did not return a spreadsheet ID.");
    }

    await sheets.spreadsheets.values
      .update({
        spreadsheetId,
        range: "Posts!A1:F2",
        valueInputOption: "RAW",
        requestBody: {
          values: [
            ["appPostId", "content", "hashtags", "scheduledAt", "mediaUrl", "status"],
            [
              "",
              "Write your LinkedIn post here",
              "#linkedin #automation",
              "2026-05-21 10:00",
              "",
              "DRAFT",
            ],
          ],
        },
      })
      .catch(normalizeGoogleSheetsError);

    return {
      spreadsheetId,
      spreadsheetUrl,
      range: "Posts!A1:Z1000",
    };
  }
