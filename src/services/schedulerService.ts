import cron from "node-cron";
import { prisma } from "../prismaClient";
import {
  getUsableLinkedInAccountForUser,
  postToLinkedInFromPostId,
} from "./linkedinService";
import {
  handleSheetSyncError,
  isGoogleInvalidGrantError,
  syncGoogleSheetPosts,
} from "./sheetsSyncService";
import { canPublish } from "./entitlementService";
import { canPublishToLinkedIn } from "./planEntitlementService";

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
      where: { active: true, authStatus: { not: "REAUTH_REQUIRED" } },
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
        const result = await syncGoogleSheetPosts({
          clientId,
          clientSecret,
          config,
        });

        if (result.created || result.updated || result.invalid) {
          console.log("[sheets] sync complete", {
            userId: config.userId,
            created: result.created,
            updated: result.updated,
            skipped: result.skipped,
            invalid: result.invalid,
          });
        }
      } catch (err: unknown) {
        const outcome = await handleSheetSyncError(config.id, config.userId, err);
        if (outcome === "reauth") {
          console.warn("[sheets] sync disabled until reconnect", { configId: config.id, userId: config.userId });
        } else if (!isGoogleInvalidGrantError(err)) {
          console.error("Sheet sync failed for config", config.id, err instanceof Error ? err.message : err);
        }
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
        await canPublishToLinkedIn(post.userId, 1);
      } catch (err: any) {
        console.log(`Skipping post ${post.id}: ${err?.message || "Daily post limit reached"}`);
        continue;
      }

      try {
        const linkedInAccount = await getUsableLinkedInAccountForUser(post.userId);
        if (!linkedInAccount) {
          throw new Error("LinkedIn account not connected or connection expired");
        }

        if (post.linkedinAccountId !== linkedInAccount.id) {
          await prisma.post.update({
            where: { id: post.id },
            data: { linkedinAccountId: linkedInAccount.id },
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
