"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const crypto_1 = __importDefault(require("crypto"));
const sheetsService_1 = require("../services/sheetsService");
const auth_1 = require("../middleware/auth");
const prismaClient_1 = require("../prismaClient");
const router = (0, express_1.Router)();
router.get('/connect', auth_1.requireAuth, async (req, res) => {
    const user = await prismaClient_1.prisma.user.findUnique({ where: { id: req.userId } });
    if (!user || !user.googleClientId || !user.googleClientSecret) {
        return res.status(400).json({ error: 'Please configure Google Client ID and Secret in settings first.' });
    }
    const state = crypto_1.default.randomBytes(16).toString('hex');
    const url = (0, sheetsService_1.getGoogleAuthUrl)(user.googleClientId, user.googleClientSecret, state);
    res.json({ url, state });
});
router.get('/callback', auth_1.requireAuth, async (req, res) => {
    const { code } = req.query;
    if (!code)
        return res.status(400).send('Missing code');
    const user = await prismaClient_1.prisma.user.findUnique({ where: { id: req.userId } });
    if (!user || !user.googleClientId || !user.googleClientSecret) {
        return res.status(400).json({ error: 'User credentials not configured' });
    }
    const tokens = await (0, sheetsService_1.exchangeGoogleCode)(user.googleClientId, user.googleClientSecret, String(code));
    res.json({ tokens, note: 'Store tokens tied to user and allow them to configure spreadsheetId / range.' });
});
router.post('/config', auth_1.requireAuth, async (req, res) => {
    const { spreadsheetId, range, accessToken, refreshToken } = req.body;
    if (!spreadsheetId || !range)
        return res.status(400).json({ error: 'Missing spreadsheetId or range' });
    const configRow = await prismaClient_1.prisma.sheetConfig.create({
        data: {
            userId: req.userId,
            spreadsheetId,
            range,
            accessToken,
            refreshToken
        }
    });
    res.json(configRow);
});
exports.default = router;
