import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { TrendingBotService } from '../services/trendingBotService';

const router = Router();
const botService = new TrendingBotService();

router.post('/generate', requireAuth, async (req, res) => {
    const { daysWindow } = req.body; // e.g., 7 or 30

    if (!daysWindow) return res.status(400).json({ error: 'Missing daysWindow' });

    // Trigger generation asynchronously to not block
    botService.generateNow(req.userId!, Number(daysWindow))
        .then(() => console.log(`Batch generation completed for user ${req.userId}`))
        .catch((err: any) => console.error(`Batch generation failed for user ${req.userId}`, err));

    res.json({ message: 'Batch generation started. Check activity feed shortly.' });
});

// GET /bot/trends/preview - Preview top trends for current config
router.get('/trends/preview', requireAuth, async (req, res) => {
    try {
        const trends = await botService.previewTrends(req.userId!);
        res.json(trends);
    } catch (error) {
        console.error('Error fetching trend preview:', error);
        res.status(500).json({ error: 'Failed to fetch trend preview' });
    }
});

export default router;
