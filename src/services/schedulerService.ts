import cron from "node-cron";
import { prisma } from "../prismaClient";
import { postToLinkedInFromPostId } from "./linkedinService";
import { fetchPostsFromSheet } from "./sheetsService";

import { TrendingBotService } from "./trendingBotService";

export function startScheduler() {
  // Run Trending Bot daily at 9:00 AM
  cron.schedule("0 9 * * *", async () => {
    console.log("Running Daily Trending Bot...");
    const bot = new TrendingBotService();
    // For now, we just dry run or we need to find a user to post on behalf of.
    // In a real multi-user app, we'd iterate users who enabled this feature.
    await bot.runBot(true); // Default to dry run for safety until configured
  });

  // Sync Sheets every 10 minutes
  // Sync Sheets every 10 minutes
  cron.schedule("*/10 * * * *", async () => {
    console.log("Running Sheet Sync...");

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      console.error("Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET");
      return;
    }

    const configs = await prisma.sheetConfig.findMany({
      where: { active: true }
    });

    for (const config of configs) {
      if (
        (!config.accessToken && !config.refreshToken) ||
        !config.spreadsheetId ||
        !config.range
      ) {
        continue;
      }

      try {
        const rows = await fetchPostsFromSheet({
          clientId,
          clientSecret,
          accessToken: config.accessToken,
          refreshToken: config.refreshToken,
          spreadsheetId: config.spreadsheetId,
          range: config.range,
        });

        for (const row of rows) {
          if (!row.content) continue;

          const duplicate = await prisma.post.findFirst({
            where: {
              userId: config.userId,
              content: row.content,
              source: "GOOGLE_SHEET",
            },
          });

          if (!duplicate) {
            await prisma.post.create({
              data: {
                userId: config.userId,
                regionId: config.regionId,
                content: row.content,
                hashtags: row.hashtags,
                mediaUrl: row.mediaUrl,
                scheduledAt: row.scheduledAt,
                source: "GOOGLE_SHEET",
                status: row.scheduledAt ? "QUEUED" : "DRAFT",
              },
            });

            console.log("Imported post from sheet for user", config.userId);
          }
        }
      } catch (err: any) {
        console.error("Sheet sync failed for config", config.id, err?.message);
      }
    }
  });
  cron.schedule("* * * * *", async () => {
    const now = new Date();

    const duePosts = await prisma.post.findMany({
      where: {
        status: "QUEUED",
        scheduledAt: { lte: now },
      },
      take: 10,
    });

    for (const post of duePosts) {
      try {
        await postToLinkedInFromPostId(post.id);
        console.log("Published post", post.id);
      } catch (err: any) {
        console.error("Failed to publish post", post.id, err?.message || err);
        await prisma.post.update({
          where: { id: post.id },
          data: {
            status: "FAILED",
            errorMessage: err?.message || "Unknown error",
          },
        });
      }
    }
  });
}
