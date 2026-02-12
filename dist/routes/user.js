"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const prismaClient_1 = require("../prismaClient");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
router.get('/me', auth_1.requireAuth, async (req, res) => {
    const user = await prismaClient_1.prisma.user.findUnique({ where: { id: req.userId } });
    if (!user)
        return res.status(404).json({ error: 'User not found' });
    // Return masked credentials status
    res.json({
        email: user.email,
        linkedinConfigured: !!(user.linkedinClientId && user.linkedinClientSecret),
        googleConfigured: !!(user.googleClientId && user.googleClientSecret)
    });
});
router.put('/config', auth_1.requireAuth, async (req, res) => {
    const { linkedinClientId, linkedinClientSecret, googleClientId, googleClientSecret } = req.body;
    const updateData = {};
    if (linkedinClientId && linkedinClientSecret) {
        updateData.linkedinClientId = linkedinClientId;
        updateData.linkedinClientSecret = linkedinClientSecret;
    }
    if (googleClientId && googleClientSecret) {
        updateData.googleClientId = googleClientId;
        updateData.googleClientSecret = googleClientSecret;
    }
    if (Object.keys(updateData).length === 0) {
        return res.status(400).json({ error: 'No configuration provided' });
    }
    await prismaClient_1.prisma.user.update({
        where: { id: req.userId },
        data: updateData
    });
    res.json({ success: true });
});
exports.default = router;
