import { Router, Request } from 'express';
import { prisma } from '../prismaClient';
import { requireAuth } from '../middleware/auth';

const router = Router();

// GET /bot/config - Get current user's bot config
router.get('/config', requireAuth, async (req: Request, res: any) => {
  try {
    const config = await prisma.botConfig.findUnique({
      where: { userId: req.userId }
    });

    // add description default too
    res.json(
      config || {
        userId: req.userId,
        niches: '[]',
        sources: '[]',
        backgroundImageUrl: '',
        isEnabled: false,
        description: '' // ✅
      }
    );
  } catch (error) {
    console.error('Error fetching bot config:', error);
    res.status(500).json({ error: 'Failed to fetch config' });
  }
});

// PUT /bot/config - Update or Create bot config
router.put('/config', requireAuth, async (req: Request, res: any) => {


  const {
    niches,
    sources,
    customRssFeeds,
    customLinks,
    customRedditFeeds,
    backgroundImageUrl,
    isEnabled,
    tone,
    postsPerWeek,
    description // ✅
  } = req.body;

  try {
    const nichesStr = typeof niches === 'string' ? niches : JSON.stringify(niches || []);
    const sourcesStr = typeof sources === 'string' ? sources : JSON.stringify(sources || []);
    const customRssFeedsStr = typeof customRssFeeds === 'string' ? customRssFeeds : JSON.stringify(customRssFeeds || []);
    const customLinksStr = typeof customLinks === 'string' ? customLinks : JSON.stringify(customLinks || []);
    const customRedditFeedsStr = typeof customRedditFeeds === 'string' ? customRedditFeeds : JSON.stringify(customRedditFeeds || []);

    const config = await prisma.botConfig.upsert({
      where: { userId: req.userId! },
      create: {
        userId: req.userId!,
        niches: nichesStr,
        sources: sourcesStr,
        customRssFeeds: customRssFeedsStr,
        customLinks: customLinksStr,
        customRedditFeeds: customRedditFeedsStr,
        backgroundImageUrl: backgroundImageUrl || undefined,
        tone: tone || 'Professional',
        postsPerWeek: postsPerWeek || 7,
        isEnabled: !!isEnabled,
        postingSchedule: '0 9 * * *',
        description: description || '' // ✅
      },
      update: {
        niches: nichesStr,
        sources: sourcesStr,
        customRssFeeds: customRssFeedsStr,
        customLinks: customLinksStr,
        customRedditFeeds: customRedditFeedsStr,
        backgroundImageUrl: backgroundImageUrl || null,
        tone: tone || 'Professional',
        postsPerWeek: postsPerWeek || 7,
        isEnabled: !!isEnabled,
        description: description || '' // ✅
      }
    });

    res.json(config);
  } catch (error) {
    console.error('Error saving bot config:', error);
    res.status(500).json({ error: 'Failed to save config' });
  }
});

export default router;
