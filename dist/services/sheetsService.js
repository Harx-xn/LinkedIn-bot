"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getGoogleOAuthClient = getGoogleOAuthClient;
exports.getGoogleAuthUrl = getGoogleAuthUrl;
exports.exchangeGoogleCode = exchangeGoogleCode;
exports.fetchPostsFromSheet = fetchPostsFromSheet;
const googleapis_1 = require("googleapis");
const config_1 = require("../config");
const sheetsApi = googleapis_1.google.sheets('v4');
function getGoogleOAuthClient(clientId, clientSecret) {
    return new googleapis_1.google.auth.OAuth2(clientId, clientSecret, config_1.config.google.redirectUri);
}
function getGoogleAuthUrl(clientId, clientSecret, state) {
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
async function exchangeGoogleCode(clientId, clientSecret, code) {
    const oAuth2Client = getGoogleOAuthClient(clientId, clientSecret);
    const { tokens } = await oAuth2Client.getToken(code);
    return tokens;
}
async function fetchPostsFromSheet(clientId, clientSecret, spreadsheetId, range, accessToken) {
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
