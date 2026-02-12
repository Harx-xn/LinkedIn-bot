import { google } from 'googleapis';
import { config } from '../config';

const sheetsApi = google.sheets('v4');

export function getGoogleOAuthClient(clientId: string, clientSecret: string) {
  return new google.auth.OAuth2(
    clientId,
    clientSecret,
    config.google.redirectUri
  );
}

export function getGoogleAuthUrl(clientId: string, clientSecret: string, state: string) {
  const oAuth2Client = getGoogleOAuthClient(clientId, clientSecret);
  const scopes = [
    'https://www.googleapis.com/auth/spreadsheets.readonly',
    'https://www.googleapis.com/auth/userinfo.email'
  ];

  return oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    state
  });
}

export async function exchangeGoogleCode(clientId: string, clientSecret: string, code: string) {
  const oAuth2Client = getGoogleOAuthClient(clientId, clientSecret);
  const { tokens } = await oAuth2Client.getToken(code);
  return tokens;
}

export async function fetchPostsFromSheet(clientId: string, clientSecret: string, spreadsheetId: string, range: string, accessToken: string) {
  const auth = getGoogleOAuthClient(clientId, clientSecret);
  auth.setCredentials({ access_token: accessToken });

  const res = await sheetsApi.spreadsheets.values.get({
    auth,
    spreadsheetId,
    range
  });

  const rows = res.data.values || [];
  return rows.map(row => ({
    date: row[0],
    time: row[1],
    content: row[2],
    hashtags: row[3]
  }));
}
