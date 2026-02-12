"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const prismaClient_1 = require("../prismaClient");
const router = (0, express_1.Router)();
router.post('/', auth_1.requireAuth, async (req, res) => {
    const { content, hashtags, scheduledAt, source, linkedinAccountId } = req.body;
    if (!content)
        return res.status(400).json({ error: 'Missing content' });
    const post = await prismaClient_1.prisma.post.create({
        data: {
            userId: req.userId,
            content,
            hashtags: hashtags || null,
            status: scheduledAt ? 'QUEUED' : 'DRAFT',
            scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
            source: (source === 'GOOGLE_SHEET' || source === 'AI' || source === 'MANUAL') ? source : 'MANUAL',
            linkedinAccountId: linkedinAccountId || null
        }
    });
    res.json(post);
});
router.get('/queue', auth_1.requireAuth, async (req, res) => {
    const posts = await prismaClient_1.prisma.post.findMany({
        where: { userId: req.userId, status: 'QUEUED' },
        orderBy: { scheduledAt: 'asc' }
    });
    res.json(posts);
});
router.get('/', auth_1.requireAuth, async (req, res) => {
    const posts = await prismaClient_1.prisma.post.findMany({
        where: { userId: req.userId },
        orderBy: { createdAt: 'desc' },
        take: 20
    });
    res.json(posts);
});
exports.default = router;
