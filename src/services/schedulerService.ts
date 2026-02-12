import cron from 'node-cron';
import { prisma } from '../prismaClient';
import { postToLinkedInFromPostId } from './linkedinService';
import { fetchPostsFromSheet } from './sheetsService';

import { TrendingBotService } from './trendingBotService';

export function startScheduler() {
  // Run Trending Bot daily at 9:00 AM
  cron.schedule('0 9 * * *', async () => {
    console.log('Running Daily Trending Bot...');
    const bot = new TrendingBotService();
    // For now, we just dry run or we need to find a user to post on behalf of.
    // In a real multi-user app, we'd iterate users who enabled this feature.
    await bot.runBot(true); // Default to dry run for safety until configured
  });

  // Sync Sheets every 10 minutes
  cron.schedule('*/10 * * * *', async () => {
    console.log('Running Sheet Sync...');
    const configs = await prisma.sheetConfig.findMany({
      where: { active: true },
      include: { user: true }
    });

    for (const config of configs) {
      if (!config.accessToken || !config.user.googleClientId || !config.user.googleClientSecret) continue;
      try {
        // NOTE: In production, handle token refresh if expired using refreshToken
        const rows = await fetchPostsFromSheet(
          config.user.googleClientId,
          config.user.googleClientSecret,
          config.spreadsheetId,
          config.range,
          config.accessToken
        );

        for (const row of rows) {
          // Basic duplicplication check: if content exists for user, skip
          // Ideally, add a specific ID column in Sheet
          if (!row.content) continue;

          const duplicate = await prisma.post.findFirst({
            where: {
              userId: config.userId,
              content: row.content,
              source: 'GOOGLE_SHEET'
            }
          });

          if (!duplicate) {
            await prisma.post.create({
              data: {
                userId: config.userId,
                content: row.content,
                hashtags: row.hashtags,
                source: 'GOOGLE_SHEET',
                status: 'DRAFT', // or QUEUED if date/time is parsed
                // Parsing date/time is complex, skipping for this basic version
              }
            });
            console.log('Imported post from sheet for user', config.userId);
          }
        }
      } catch (err: any) {
        console.error('Sheet sync failed for config', config.id, err?.message);
      }
    }
  });

  cron.schedule('* * * * *', async () => {
    const now = new Date();

    const duePosts = await prisma.post.findMany({
      where: {
        status: 'QUEUED',
        scheduledAt: { lte: now }
      },
      take: 10
    });

    for (const post of duePosts) {
      try {
        await postToLinkedInFromPostId(post.id);
        console.log('Published post', post.id);
      } catch (err: any) {
        console.error('Failed to publish post', post.id, err?.message || err);
        await prisma.post.update({
          where: { id: post.id },
          data: {
            status: 'FAILED',
            errorMessage: err?.message || 'Unknown error'
          }
        });
      }
    }
  });
}
