import cron from "node-cron";
import { prisma } from "../prismaClient";
import { postToLinkedInFromPostId } from "./linkedinService";
import { fetchPostsFromSheet } from "./sheetsService";
import { canPublish } from "./entitlementService";

import { TrendingBotService } from "./trendingBotService";

export function startScheduler() {
  // Run Trending Bot daily at 9:00 AM.
  // This should create drafts, not publish directly.
  cron.schedule("0 9 * * *", async () => {
    console.log("Running Daily Trending Bot...");

    try {
      const bot = new TrendingBotService();

      // false = not dry-run.
      // The updated flow expects the bot to create DRAFT posts only.
      await bot.runBot(false);
    } catch (err: any) {
      console.error("Daily Trending Bot failed:", err?.message || err);
    }
  });

  // Sync Google Sheets into draft/queued posts every 10 minutes.
  cron.schedule("* * * * *", async () => {
    console.log("Running Sheet Sync...");

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      console.error("Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET");
      return;
    }

    const configs = await prisma.sheetConfig.findMany({
      where: { active: true },
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

        const linkedInAccount = await prisma.linkedInAccount.findFirst({
          where: { userId: config.userId },
        });

        for (const row of rows) {
          if (!row.content) continue;

          const normalizedStatus = row.status?.toUpperCase();

          // Let users mark rows as SKIP in Google Sheets.
          if (normalizedStatus === "SKIP") {
            continue;
          }

          const finalStatus =
            normalizedStatus === "QUEUED" && row.scheduledAt
              ? "QUEUED"
              : "DRAFT";

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
                linkedinAccountId: linkedInAccount?.id || null,
                content: row.content,
                hashtags: row.hashtags,
                mediaUrl: row.mediaUrl,
                scheduledAt: finalStatus === "QUEUED" ? row.scheduledAt : null,
                source: "GOOGLE_SHEET",
                status: finalStatus,
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

  // Publisher: every minute, publish QUEUED posts whose scheduled time has arrived.
  cron.schedule("* * * * *", async () => {
    const now = new Date();

    console.log("Processing due posts");

    const duePosts = await prisma.post.findMany({
      where: {
        status: "QUEUED",
        scheduledAt: { lte: now },
      },
      take: 10,
    });

    for (const post of duePosts) {
      // Respect trial/subscription limits.
      // If blocked, leave the post QUEUED instead of marking it FAILED.
      const gate = await canPublish(post.userId);

      if (!gate.allowed) {
        console.log(`Skipping post ${post.id}: ${gate.reason}`);
        continue;
      }

      try {
        let linkedinAccountId = post.linkedinAccountId;

        if (!linkedinAccountId) {
          const linkedInAccount = await prisma.linkedInAccount.findFirst({
            where: { userId: post.userId },
          });

          if (!linkedInAccount) {
            throw new Error("No LinkedIn account connected");
          }

          linkedinAccountId = linkedInAccount.id;

          await prisma.post.update({
            where: { id: post.id },
            data: { linkedinAccountId },
          });
        }

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