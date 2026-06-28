  import { google, sheets_v4 } from "googleapis";
  import { config } from "../config";

  export const GOOGLE_OAUTH_SCOPES = [
    "https://www.googleapis.com/auth/drive.file",
  ];

  const POST_TEMPLATE_ROW_LIMIT = 1000;

  export function getPostTemplateExampleScheduledAt(now = new Date()): string {
    const example = new Date(now);
    example.setUTCDate(example.getUTCDate() + 1);
    example.setUTCHours(10, 0, 0, 0);
    return example.toISOString().slice(0, 16).replace("T", " ");
  }

  export function buildPostTemplateFormattingRequests(
    sheetId: number,
  ): sheets_v4.Schema$Request[] {
    const columnWidths = [180, 600, 240, 190, 300, 160];
    const requests: sheets_v4.Schema$Request[] = [
      {
        updateSheetProperties: {
          properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
          fields: "gridProperties.frozenRowCount",
        },
      },
      ...columnWidths.map((pixelSize, index) => ({
        updateDimensionProperties: {
          range: {
            sheetId,
            dimension: "COLUMNS",
            startIndex: index,
            endIndex: index + 1,
          },
          properties: { pixelSize },
          fields: "pixelSize",
        },
      })),
      {
        updateDimensionProperties: {
          range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 },
          properties: { pixelSize: 38 },
          fields: "pixelSize",
        },
      },
      {
        updateDimensionProperties: {
          range: {
            sheetId,
            dimension: "ROWS",
            startIndex: 1,
            endIndex: POST_TEMPLATE_ROW_LIMIT,
          },
          properties: { pixelSize: 64 },
          fields: "pixelSize",
        },
      },
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 6 },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.102, green: 0.18, blue: 0.32 },
              textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
              horizontalAlignment: "CENTER",
              verticalAlignment: "MIDDLE",
              borders: {
                top: { style: "SOLID", color: { red: 0.25, green: 0.35, blue: 0.5 } },
                bottom: { style: "SOLID", color: { red: 0.25, green: 0.35, blue: 0.5 } },
                left: { style: "SOLID", color: { red: 0.25, green: 0.35, blue: 0.5 } },
                right: { style: "SOLID", color: { red: 0.25, green: 0.35, blue: 0.5 } },
              },
            },
          },
          fields: "userEnteredFormat",
        },
      },
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 1, endRowIndex: POST_TEMPLATE_ROW_LIMIT, startColumnIndex: 0, endColumnIndex: 6 },
          cell: { userEnteredFormat: { verticalAlignment: "TOP" } },
          fields: "userEnteredFormat.verticalAlignment",
        },
      },
      ...[1, 2, 4].map((columnIndex) => ({
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: 1,
            endRowIndex: POST_TEMPLATE_ROW_LIMIT,
            startColumnIndex: columnIndex,
            endColumnIndex: columnIndex + 1,
          },
          cell: { userEnteredFormat: { wrapStrategy: "WRAP" } },
          fields: "userEnteredFormat.wrapStrategy",
        },
      })),
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 1, endRowIndex: POST_TEMPLATE_ROW_LIMIT, startColumnIndex: 3, endColumnIndex: 4 },
          cell: { userEnteredFormat: { numberFormat: { type: "DATE_TIME", pattern: "yyyy-mm-dd hh:mm" } } },
          fields: "userEnteredFormat.numberFormat",
        },
      },
      {
        setDataValidation: {
          range: { sheetId, startRowIndex: 1, endRowIndex: POST_TEMPLATE_ROW_LIMIT, startColumnIndex: 3, endColumnIndex: 4 },
          rule: {
            condition: { type: "DATE_IS_VALID" },
            strict: true,
            showCustomUi: true,
            inputMessage: "Enter a valid date and time, for example 2026-07-01 10:00.",
          },
        },
      },
      {
        setDataValidation: {
          range: { sheetId, startRowIndex: 1, endRowIndex: POST_TEMPLATE_ROW_LIMIT, startColumnIndex: 5, endColumnIndex: 6 },
          rule: {
            condition: { type: "ONE_OF_LIST", values: ["QUEUED", "DRAFT", "PUBLISHED"].map((userEnteredValue) => ({ userEnteredValue })) },
            strict: true,
            showCustomUi: true,
            inputMessage: "Choose QUEUED, DRAFT, or PUBLISHED.",
          },
        },
      },
      {
        setBasicFilter: {
          filter: { range: { sheetId, startRowIndex: 0, endRowIndex: POST_TEMPLATE_ROW_LIMIT, startColumnIndex: 0, endColumnIndex: 6 } },
        },
      },
    ];

    const statusColors: Array<[string, sheets_v4.Schema$Color]> = [
      ["DRAFT", { red: 0.9, green: 0.91, blue: 0.93 }],
      ["QUEUED", { red: 0.82, green: 0.9, blue: 1 }],
      ["PUBLISHED", { red: 0.82, green: 0.94, blue: 0.85 }],
    ];
    statusColors.forEach(([status, backgroundColor], index) => {
      requests.push({
        addConditionalFormatRule: {
          index,
          rule: {
            ranges: [{ sheetId, startRowIndex: 1, endRowIndex: POST_TEMPLATE_ROW_LIMIT, startColumnIndex: 5, endColumnIndex: 6 }],
            booleanRule: {
              condition: { type: "TEXT_EQ", values: [{ userEnteredValue: status }] },
              format: { backgroundColor, textFormat: { bold: true } },
            },
          },
        },
      });
    });

    return requests;
  }

  async function formatPostTemplateSheet(
    sheets: sheets_v4.Sheets,
    spreadsheetId: string,
    sheetId: number,
  ) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: buildPostTemplateFormattingRequests(sheetId) },
    }).catch(normalizeGoogleSheetsError);
  }

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

  export type GoogleSheetMediaRow = {
    rowNumber: number;
    appPostId: string;
    content: string;
    hashtags: string;
    scheduledAt: string;
    mediaUrl: string;
    status: string;
  };

  export function isSelectableGoogleSheetMediaRowStatus(status: string): boolean {
    const normalized = status.trim().toUpperCase();
    return normalized !== 'PUBLISHED' && normalized !== 'QUEUED';
  }

  export async function readGoogleSheetMediaRows(params: {
    clientId: string;
    clientSecret: string;
    accessToken?: string | null;
    refreshToken?: string | null;
    spreadsheetId: string;
    range: string;
  }): Promise<GoogleSheetMediaRow[]> {
    const rows = await readGoogleSheetAsJson(params);
    return rows
      .map((row, index) => ({
        rowNumber: index + 2,
        appPostId: getCellValue(row, ['appPostId', 'app post id', 'postId', 'post id', 'id']),
        content: getCellValue(row, ['content', 'post', 'post content', 'text', 'caption', 'linkedin post']),
        hashtags: getCellValue(row, ['hashtags', 'tags', 'hash tags']),
        scheduledAt: getCellValue(row, ['scheduledAt', 'scheduled at', 'schedule', 'date', 'publish at']),
        mediaUrl: getCellValue(row, ['mediaUrl', 'media url', 'image', 'imageUrl', 'image url', 'media']),
        status: getCellValue(row, ['status', 'state']),
      }))
      .filter(
        (row) =>
          Boolean(row.content) && isSelectableGoogleSheetMediaRowStatus(row.status),
      );
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
        valueInputOption: "USER_ENTERED",
        requestBody: { values },
      })
      .catch(normalizeGoogleSheetsError);
  }

  export async function updateGoogleSheetMediaUrl(params: {
    clientId: string;
    clientSecret: string;
    accessToken?: string | null;
    refreshToken?: string | null;
    spreadsheetId: string;
    range: string;
    rowNumber: number;
    mediaUrl: string;
  }) {
    if (!Number.isInteger(params.rowNumber) || params.rowNumber < 2 || params.rowNumber > 1000) {
      throw new Error('Invalid Google Sheet row number.');
    }

    const sheetName = getSheetName(params.range);
    ensureRefreshToken(params.refreshToken);
    const oAuth2Client = getGoogleOAuthClient(params.clientId, params.clientSecret);
    oAuth2Client.setCredentials({
      access_token: params.accessToken || undefined,
      refresh_token: params.refreshToken || undefined,
    });
    const sheets = google.sheets({ version: 'v4', auth: oAuth2Client });
    const headerResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: params.spreadsheetId,
      range: `${sheetName}!1:1`,
    }).catch(normalizeGoogleSheetsError);
    const headers = (headerResponse.data.values?.[0] || []).map((value) =>
      String(value).trim().toLowerCase(),
    );
    const mediaColumnIndex = headers.findIndex((header) =>
      ['mediaurl', 'media url', 'image', 'imageurl', 'image url', 'media'].includes(header),
    );
    if (mediaColumnIndex < 0) {
      throw new Error('The connected Google Sheet does not have a mediaUrl column.');
    }

    const column = getGoogleSheetColumnName(mediaColumnIndex + 1);
    await sheets.spreadsheets.values.update({
      spreadsheetId: params.spreadsheetId,
      range: `${sheetName}!${column}${params.rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[params.mediaUrl]] },
    }).catch(normalizeGoogleSheetsError);
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
    const postsSheetId = response.data.sheets?.[0]?.properties?.sheetId;

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
              getPostTemplateExampleScheduledAt(),
              "",
              "DRAFT",
            ],
          ],
        },
      })
      .catch(normalizeGoogleSheetsError);

    if (typeof postsSheetId !== "number") {
      throw new Error("Google did not return the Posts sheet ID.");
    }
    await formatPostTemplateSheet(sheets, spreadsheetId, postsSheetId);

    return {
      spreadsheetId,
      spreadsheetUrl,
      range: "Posts!A1:Z1000",
    };
  }
