import { Router, Request } from 'express';
import { prisma } from '../prismaClient';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.get('/me', requireAuth, async (req: Request, res: any) => {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Return masked credentials status
    res.json({
        email: user.email,
        linkedinConfigured: !!(user.linkedinClientId && user.linkedinClientSecret),
        googleConfigured: !!(user.googleClientId && user.googleClientSecret)
    });
});

router.put('/config', requireAuth, async (req: Request, res: any) => {
    const { linkedinClientId, linkedinClientSecret, googleClientId, googleClientSecret } = req.body;

    const updateData: any = {};
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

    await prisma.user.update({
        where: { id: req.userId },
        data: updateData
    });

    res.json({ success: true });
});

export default router;
