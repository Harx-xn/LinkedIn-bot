import { TrendsService, Trend } from './trendsService';
import { ContentService } from './contentService';
import { ImageService } from './imageService';
import { prisma } from '../prismaClient';

export class TrendingBotService {
    private trendsService: TrendsService;
    private contentService: ContentService;
    private imageService: ImageService;

    constructor() {
        this.trendsService = new TrendsService();
        this.contentService = new ContentService();
        this.imageService = new ImageService();
    }

    async runBot(dryRun: boolean = false) {
        console.log('Starting Trending Bot...');

        // 1. Fetch all enabled specific configurations
        const configs = await prisma.botConfig.findMany({
            where: { isEnabled: true }
        });

        if (configs.length === 0) {
            console.log('No enabled bot configurations found.');
            return;
        }

        for (const config of configs) {
            console.log(`Processing config for user ${config.userId}`);

            let niches: string[] = [];
            try {
                if (config.niches) {
                    const parsed = JSON.parse(config.niches);
                    niches = Array.isArray(parsed) ? parsed : [config.niches];
                } else {
                    niches = ['Technology'];
                }
            } catch (e) {
                console.warn('Error parsing niches:', e);
                niches = ['Technology'];
            }

            console.log(`User Niches: ${niches.join(', ')}`);

            for (const niche of niches) {
                console.log(`--- Processing Niche: ${niche} ---`);
                try {
                    const sources = config.sources ? JSON.parse(config.sources) : ['google'];
                    let customRssFeeds: string[] = [];
                    try { customRssFeeds = config.customRssFeeds ? JSON.parse(config.customRssFeeds) : []; } catch { }
                    let customLinks: string[] = [];
                    try { customLinks = (config as any).customLinks ? JSON.parse((config as any).customLinks) : []; } catch { }
                    let customRedditFeeds: string[] = [];
                    try { customRedditFeeds = (config as any).customRedditFeeds ? JSON.parse((config as any).customRedditFeeds) : []; } catch { }

                    const trends = await this.trendsService.fetchTrends(niche, sources, customRssFeeds, customLinks, customRedditFeeds);
                    if (trends.length === 0) {
                        console.log(`No trends found for ${niche}`);
                        continue;
                    }

                    let selectedTrend = null;
                    for (const trend of trends) {
                        const exists = await prisma.post.findFirst({
                            where: { userId: config.userId, content: { contains: trend.title } }
                        });

                        if (!exists) {
                            selectedTrend = trend;
                            break;
                        }
                    }

                    if (!selectedTrend) {
                        console.log(`All top trends for ${niche} are already posted. Skipping.`);
                        continue;
                    }

                    console.log(`Selected Trend: ${selectedTrend.title} (${selectedTrend.source})`);

                    const provider = process.env.GEMINI_API_KEY ? 'GEMINI' : 'OPENAI';
                    const generatedContent = await this.contentService.generatePost(selectedTrend.title, selectedTrend.link, provider, config.tone || 'Professional');

                    const headline = generatedContent.headline || selectedTrend.title;
                    const subheadline = generatedContent.subheadline || '';
                    const bulletPoints = generatedContent.bulletPoints || [];
                    const body = generatedContent.body || JSON.stringify(generatedContent);
                    const hashtags = generatedContent.hashtags || '';

                    const imagePath = await this.imageService.createTopicImage(
                        headline,
                        config.backgroundImageUrl || undefined,
                        { headline, subheadline, bulletPoints }
                    );

                    const finalContent = `${body}\n\n${hashtags}`;

                    if (dryRun) {
                        console.log(`[DRY RUN] Generated for ${config.userId}:\n${finalContent}`);
                    } else {
                        await prisma.post.create({
                            data: {
                                userId: config.userId,
                                content: finalContent,
                                source: 'AI_TRENDING',
                                status: 'DRAFT',
                                hashtags: hashtags,
                                mediaUrl: imagePath
                            }
                        });
                        console.log(`Draft created for user ${config.userId}`);
                    }

                } catch (error) {
                    console.error(`Error processing niche ${niche}:`, error);
                }
            }
        }
    }

    private calculateTimeSlots(postsPerWeek: number, days: number, startDate: Date): Date[] {
        const slots: Date[] = [];
        const totalPosts = Math.ceil((postsPerWeek / 7) * days);
        const intervalMs = (days * 24 * 60 * 60 * 1000) / totalPosts;

        for (let i = 0; i < totalPosts; i++) {
            const time = new Date(startDate.getTime() + (i * intervalMs));
            time.setHours(9, 0, 0, 0);
            slots.push(time);
        }
        return slots;
    }

    async generateNow(userId: string, daysWindow: number) {
        const config = await prisma.botConfig.findUnique({ where: { userId } });
        if (!config || !config.isEnabled) return;

        console.log(`Generating batch for user ${userId}, window: ${daysWindow} days`);

        let niches: string[] = [];
        try { niches = JSON.parse(config.niches); } catch { niches = ['Technology']; }

        const sources = config.sources ? JSON.parse(config.sources) : ['google'];
        let customRssFeeds: string[] = [];
        try { customRssFeeds = config.customRssFeeds ? JSON.parse(config.customRssFeeds) : []; } catch { }
        let customLinks: string[] = [];
        try { customLinks = (config as any).customLinks ? JSON.parse((config as any).customLinks) : []; } catch { }
        let customRedditFeeds: string[] = [];
        try { customRedditFeeds = (config as any).customRedditFeeds ? JSON.parse((config as any).customRedditFeeds) : []; } catch { }

        const slots = this.calculateTimeSlots(config.postsPerWeek, daysWindow, new Date());
        const nicheTrendsMap: Record<string, Trend[]> = {};
      const totalNeeded = slots.length;
const buffer = Math.max(5, Math.ceil(totalNeeded * 0.3)); // extra for duplicates/AI failures
const perNicheNeeded = Math.max(5, Math.ceil((totalNeeded + buffer) / Math.max(1, niches.length)));

        for (const niche of niches) {
            try {
        
            nicheTrendsMap[niche] = await this.trendsService.fetchTrends(
             niche,
             sources,
             customRssFeeds,
             customLinks,
             customRedditFeeds,
             perNicheNeeded
        );
  await new Promise(r => setTimeout(r, 1000)); // Small pause between niche fetches
            } catch (e) { nicheTrendsMap[niche] = []; }
        }

        let slotIndex = 0;
        let nicheIndex = 0;
        let postsCreated = 0;

        while (slotIndex < slots.length) {
            const currentSlot = slots[slotIndex];
            const shouldMix = niches.length > 1 && (slotIndex + 1) % 4 === 0;
            let success = false;

            if (shouldMix) {
                const availableNiches = niches.filter(n => nicheTrendsMap[n].length > 0);
                if (availableNiches.length >= 2) {
                    const n1 = availableNiches[0];
                    const n2 = availableNiches[1];
                    const t1 = nicheTrendsMap[n1].shift();
                    const t2 = nicheTrendsMap[n2].shift();

                    if (t1 && t2) {
                        try {
                            const provider = process.env.GEMINI_API_KEY ? 'GEMINI' : 'OPENAI';
                            const generatedContent = await this.contentService.generateMixedPost(
                                [{ topic: t1.title, link: t1.link }, { topic: t2.title, link: t2.link }],
                                provider,
                                config.tone || 'Professional'
                            );
                            await this.createPostInDb(userId, generatedContent, currentSlot, [t1.title, t2.title].join(' + '));
                            success = true;
                        } catch (e) {
                            console.error('Mixed post generation failed', e);
                        }
                    }
                }
            }

            if (!success) {
                let attempts = 0;
                while (attempts < niches.length) {
                    const niche = niches[nicheIndex % niches.length];
                    nicheIndex++;
                    attempts++;

                    if (nicheTrendsMap[niche] && nicheTrendsMap[niche].length > 0) {
                        const trend = nicheTrendsMap[niche].shift();
                        if (!trend) continue;

                        try {
                            const provider = process.env.GEMINI_API_KEY ? 'GEMINI' : 'OPENAI';
                            const generatedContent = await this.contentService.generatePost(trend.title, trend.link, provider, config.tone || 'Professional');
                            await this.createPostInDb(userId, generatedContent, currentSlot, trend.title);
                            success = true;
                            break;
                        } catch (e) {
                            console.error(`Post generation failed for ${niche}`, e);
                        }
                    }
                }
            }

            if (success) {
                postsCreated++;
                if (process.env.GEMINI_API_KEY) await new Promise(r => setTimeout(r, 6000));
            } else {
                console.log(`Could not fill slot ${slotIndex + 1}. No trends or AI failure.`);
                await new Promise(r => setTimeout(r, 2000));
            }

            slotIndex++;
        }

        console.log(`Batch complete. Created ${postsCreated} posts.`);
    }

 private async createPostInDb(
  userId: string,
  generatedContent: any,
  scheduledAt: Date,
  sourceTitle: string
) {
  const headline = generatedContent.headline || sourceTitle;
  const subheadline = generatedContent.subheadline || '';
  const bulletPoints = generatedContent.bulletPoints || [];
  const body = generatedContent.body || JSON.stringify(generatedContent);
  const hashtags = generatedContent.hashtags || '';

  // ✅ pull user's background image from BotConfig
  const botConfig = await prisma.botConfig.findUnique({
    where: { userId },
    select: { backgroundImageUrl: true },
  });

  let mediaUrl: string | null = null;
  try {
    mediaUrl = await this.imageService.createTopicImage(
      headline,
      botConfig?.backgroundImageUrl ?? undefined, // ✅ use uploaded bg
      { headline, subheadline, bulletPoints }
    );
  } catch (e) {
    console.error('Image generation failed:', e);
  }
const linkedInAccount = await prisma.linkedInAccount.findFirst({
  where: { userId },
  select: { id: true }
});
  await prisma.post.create({
  data: {
    userId,
    content: `${body}\n\n${hashtags}`,
    status: 'QUEUED',
    scheduledAt,
    source: 'AI',
    mediaUrl,
    hashtags,
    linkedinAccountId: linkedInAccount?.id ?? null,
  },
});


  console.log(`Scheduled for ${scheduledAt.toISOString()}`);
}


    async previewTrends(userId: string) {
        const config = await prisma.botConfig.findUnique({ where: { userId } });
        if (!config) return [];

        let niches: string[] = [];
        try { niches = JSON.parse(config.niches); } catch { niches = ['Technology']; }

        const sources = config.sources ? JSON.parse(config.sources) : ['google'];
        let customRssFeeds: string[] = [];
        try { customRssFeeds = config.customRssFeeds ? JSON.parse(config.customRssFeeds) : []; } catch { }
        let customLinks: string[] = [];
        try { customLinks = (config as any).customLinks ? JSON.parse((config as any).customLinks) : []; } catch { }
        let customRedditFeeds: string[] = [];
        try { customRedditFeeds = (config as any).customRedditFeeds ? JSON.parse((config as any).customRedditFeeds) : []; } catch { }

        let allTrends: Trend[] = [];
        for (const niche of niches) {
            try {
                allTrends.push(...await this.trendsService.fetchTrends(niche, sources, customRssFeeds, customLinks, customRedditFeeds));
            } catch (e) { }
        }

        return Array.from(new Map(allTrends.map(item => [item.title, item])).values()).slice(0, 20);
    }
}
