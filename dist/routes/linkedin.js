"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const crypto_1 = __importDefault(require("crypto"));
const linkedinService_1 = require("../services/linkedinService");
const auth_1 = require("../middleware/auth");
const prismaClient_1 = require("../prismaClient");
const router = (0, express_1.Router)();
router.get('/connect', auth_1.requireAuth, async (req, res) => {
    const user = await prismaClient_1.prisma.user.findUnique({ where: { id: req.userId } });
    if (!user || !user.linkedinClientId) {
        return res.status(400).json({ error: 'Please configure LinkedIn Client ID in settings first.' });
    }
    // Pass userId in state so we can retrieve it in callback
    const statePayload = JSON.stringify({ userId: req.userId, nonce: crypto_1.default.randomBytes(8).toString('hex') });
    const state = Buffer.from(statePayload).toString('base64');
    const url = (0, linkedinService_1.getLinkedInAuthUrl)(user.linkedinClientId, state);
    res.json({ url, state });
});
// NOTE: In production, you'd decode state to find userId.
// For this skeleton, we accept userId as query param.
router.get('/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state)
        return res.status(400).send('Missing code or state');
    try {
        const decodedState = JSON.parse(Buffer.from(state, 'base64').toString('utf-8'));
        const userId = decodedState.userId;
        if (!userId)
            return res.status(400).send('Invalid state');
        const user = await prismaClient_1.prisma.user.findUnique({ where: { id: userId } });
        if (!user || !user.linkedinClientId || !user.linkedinClientSecret) {
            return res.status(400).send('User credentials not configured');
        }
        const { accessToken, expiresIn } = await (0, linkedinService_1.exchangeCodeForToken)(user.linkedinClientId, user.linkedinClientSecret, code);
        await (0, linkedinService_1.saveLinkedInAccountForUser)(userId, accessToken, expiresIn);
        res.send('LinkedIn account connected. You can close this window.');
    }
    catch (err) {
        console.error('LinkedIn callback error:', err);
        res.status(500).send('Failed to connect LinkedIn account');
    }
});
exports.default = router;
