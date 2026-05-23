import { TrendsService, Trend } from "./trendsService";
import { ContentService } from "./contentService";
import { ImageService } from "./imageService";
import { prisma } from "../prismaClient";
import { decryptSecret, decryptSecretArray } from "./secretCrypto";

export class TrendingBotService {
  private trendsService: TrendsService;
  private imageService: ImageService;

  constructor() {
    this.trendsService = new TrendsService();
    this.imageService = new ImageService();
  }

  // Resolve the region a user belongs to (used to stamp generated posts).
  private async getUserRegionId(userId: string): Promise<string | null> {
    const u = await prisma.user.findUnique({
      where: { id: userId },
      select: { regionId: true },
    });
    return u?.regionId ?? null;
  }

  // Build a ContentService using the user's region AI keys (env fallback).
  private async getContentService(userId: string): Promise<ContentService> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { region: { select: { openaiApiKey: true, geminiApiKeys: true } } },
    });

    const geminiApiKeys = decryptSecretArray(user?.region?.geminiApiKeys);
    const openaiApiKey = decryptSecret(user?.region?.openaiApiKey);

    return new ContentService({
      openaiApiKey,
      geminiApiKeys,
    });
  }

  async runBot(dryRun: boolean = false) {
    console.log("Starting Trending Bot...");

    // 1. Fetch all enabled specific configurations
    const configs = await prisma.botConfig.findMany({
      where: { isEnabled: true },
    });

    if (configs.length === 0) {
      console.log("No enabled bot configurations found.");
      return;
    }

    for (const config of configs) {
      console.log(`Processing config for user ${config.userId}`);

      const contentService = await this.getContentService(config.userId);
      const regionId = config.regionId ?? (await this.getUserRegionId(config.userId));

      let niches: string[] = [];
      try {
        if (config.niches) {
          const parsed = JSON.parse(config.niches);
          niches = Array.isArray(parsed) ? parsed : [config.niches];
        } else {
          niches = ["Technology"];
        }
      } catch (e) {
        console.warn("Error parsing niches:", e);
        niches = ["Technology"];
      }

      console.log(`User Niches: ${niches.join(", ")}`);

      for (const niche of niches) {
        console.log(`--- Processing Niche: ${niche} ---`);
        try {
          const sources = config.sources
            ? JSON.parse(config.sources)
            : ["google"];
          let customRssFeeds: string[] = [];
          try {
            customRssFeeds = config.customRssFeeds
              ? JSON.parse(config.customRssFeeds)
              : [];
          } catch {}
          let customLinks: string[] = [];
          try {
            customLinks = (config as any).customLinks
              ? JSON.parse((config as any).customLinks)
              : [];
          } catch {}
          let customRedditFeeds: string[] = [];
          try {
            customRedditFeeds = (config as any).customRedditFeeds
              ? JSON.parse((config as any).customRedditFeeds)
              : [];
          } catch {}

          const trends = await this.trendsService.fetchTrends(
            niche,
            sources,
            customRssFeeds,
            customLinks,
            customRedditFeeds,
          );
          if (trends.length === 0) {
            console.log(`No trends found for ${niche}`);
            continue;
          }

          let selectedTrend: Trend | null = null;
          for (const trend of trends) {
            const exists = await prisma.post.findFirst({
              where: {
                userId: config.userId,
                content: { contains: trend.title },
              },
            });

            if (!exists) {
              selectedTrend = trend;
              break;
            }
          }

          if (!selectedTrend) {
            console.log(
              `All top trends for ${niche} are already posted. Skipping.`,
            );
            continue;
          }

          console.log(
            `Selected Trend: ${selectedTrend.title} (${selectedTrend.source})`,
          );

          // ✅ FORCE OPENAI
          const provider: "OPENAI" = "OPENAI";

          const generatedContent = await contentService.generatePost(
            selectedTrend.title,
            selectedTrend.link,
            provider,
            config.tone || "Professional",
            config.description || "",
          );

          const headline = generatedContent.headline || selectedTrend.title;
          const subheadline = generatedContent.subheadline || "";
          const bulletPoints = generatedContent.bulletPoints || [];
          const body =
            generatedContent.body || JSON.stringify(generatedContent);
          const hashtags = generatedContent.hashtags || "";

          const imagePath = await this.imageService.createTopicImage(
            headline,
            config.backgroundImageUrl || undefined,
            { headline, subheadline, bulletPoints },
          );

          const finalContent = `${body}\n\n${hashtags}`;

          if (dryRun) {
            console.log(
              `[DRY RUN] Generated for ${config.userId}:\n${finalContent}`,
            );
          } else {
            await prisma.post.create({
              data: {
                userId: config.userId,
                regionId,
                content: finalContent,
                source: "AI_TRENDING",
                status: "REVIEW",
                hashtags: hashtags,
                mediaUrl: imagePath,
              },
            });
            console.log(`Draft created for user ${config.userId}`);
          }
        } catch (error) {
          console.error(`Error processing niche ${niche}:`, error);
        }
      }
    }
  }

  // Build the schedule of publish times for a batch. Posts are spread across
  // `days`, and when a day holds more than one post they are spaced across a
  // daytime window so they don't all collide at the same timestamp.
  private calculateTimeSlots(
    postsPerWeek: number,
    days: number,
    startDate: Date,
  ): Date[] {
    const slots: Date[] = [];
    const totalPosts = Math.max(1, Math.ceil((postsPerWeek / 7) * days));

    // Daily posting window (local time): 09:00 - 18:00.
    const startHour = 9;
    const endHour = 18;

    const perDay = Math.max(1, Math.round(totalPosts / days));
    let created = 0;

    for (let day = 0; day < days && created < totalPosts; day++) {
      const todays = Math.min(perDay, totalPosts - created);

      for (let i = 0; i < todays; i++) {
        const date = new Date(startDate.getTime());
        date.setDate(startDate.getDate() + day);

        // Single post -> window start; multiple -> evenly spaced across window.
        const frac = todays === 1 ? 0 : i / (todays - 1);
        const hour = startHour + frac * (endHour - startHour);
        const h = Math.floor(hour);
        const m = Math.round((hour - h) * 60);
        date.setHours(h, m, 0, 0);

        slots.push(date);
        created++;
      }
    }

    return slots;
  }

  async generateNow(userId: string, daysWindow: number, jobId?: string) {
    const config = await prisma.botConfig.findUnique({ where: { userId } });
    if (!config || !config.isEnabled) return;

    console.log(
      `Generating batch for user ${userId}, window: ${daysWindow} days`,
    );

    const contentService = await this.getContentService(userId);

    let niches: string[] = [];
    try {
      niches = JSON.parse(config.niches);
    } catch {
      niches = ["Technology"];
    }

    const sources = config.sources ? JSON.parse(config.sources) : ["google"];
    let customRssFeeds: string[] = [];
    try {
      customRssFeeds = config.customRssFeeds
        ? JSON.parse(config.customRssFeeds)
        : [];
    } catch {}
    let customLinks: string[] = [];
    try {
      customLinks = (config as any).customLinks
        ? JSON.parse((config as any).customLinks)
        : [];
    } catch {}
    let customRedditFeeds: string[] = [];
    try {
      customRedditFeeds = (config as any).customRedditFeeds
        ? JSON.parse((config as any).customRedditFeeds)
        : [];
    } catch {}

    const slots = this.calculateTimeSlots(
      config.postsPerWeek,
      daysWindow,
      new Date(),
    );
    if (jobId) {
      await prisma.botGenerationJob.update({
        where: { id: jobId },
        data: { totalSlots: slots.length, completedSlots: 0 },
      });
    }
    const nicheTrendsMap: Record<string, Trend[]> = {};
    const totalNeeded = slots.length;
    const buffer = Math.max(5, Math.ceil(totalNeeded * 0.3));
    const perNicheNeeded = Math.max(
      5,
      Math.ceil((totalNeeded + buffer) / Math.max(1, niches.length)),
    );

    for (const niche of niches) {
      try {
        nicheTrendsMap[niche] = await this.trendsService.fetchTrends(
          niche,
          sources,
          customRssFeeds,
          customLinks,
          customRedditFeeds,
          perNicheNeeded,
        );
        await new Promise((r) => setTimeout(r, 1000));
      } catch (e) {
        nicheTrendsMap[niche] = [];
      }
    }

    let slotIndex = 0;
    let nicheIndex = 0;
    let postsCreated = 0;

    while (slotIndex < slots.length) {
      const currentSlot = slots[slotIndex];
      const shouldMix = niches.length > 1 && (slotIndex + 1) % 4 === 0;
      let success = false;

      if (shouldMix) {
        const availableNiches = niches.filter(
          (n) => nicheTrendsMap[n].length > 0,
        );
        if (availableNiches.length >= 2) {
          const n1 = availableNiches[0];
          const n2 = availableNiches[1];
          const t1 = nicheTrendsMap[n1].shift();
          const t2 = nicheTrendsMap[n2].shift();

          if (t1 && t2) {
            try {
              // ✅ FORCE OPENAI
              const provider: "OPENAI" = "OPENAI";

              const generatedContent =
                await contentService.generateMixedPost(
                  [
                    { topic: t1.title, link: t1.link },
                    { topic: t2.title, link: t2.link },
                  ],
                  provider,
                  config.tone || "Professional",
                  config.description || "",
                );

              await this.createPostInDb(
                userId,
                generatedContent,
                currentSlot,
                [t1.title, t2.title].join(" + "),
              );
              success = true;
            } catch (e) {
              console.error("Mixed post generation failed", e);
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
              // ✅ FORCE OPENAI
              const provider: "OPENAI" = "OPENAI";

              const generatedContent = await contentService.generatePost(
                trend.title,
                trend.link,
                provider,
                config.tone || "Professional",
                config.description || "",
              );

              await this.createPostInDb(
                userId,
                generatedContent,
                currentSlot,
                trend.title,
              );
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
      } else {
        console.log(
          `Could not fill slot ${slotIndex + 1}. No trends or AI failure.`,
        );
        await new Promise((r) => setTimeout(r, 2000));
      }

      slotIndex++;

      if (jobId) {
        await prisma.botGenerationJob.update({
          where: { id: jobId },
          data: { completedSlots: { increment: 1 } },
        });
      }
    }

    console.log(`Batch complete. Created ${postsCreated} posts.`);
  }

  private async createPostInDb(
    userId: string,
    generatedContent: any,
    scheduledAt: Date,
    sourceTitle: string,
  ) {
    const headline = generatedContent.headline || sourceTitle;
    const subheadline = generatedContent.subheadline || "";
    const bulletPoints = generatedContent.bulletPoints || [];
    const body = generatedContent.body || JSON.stringify(generatedContent);
    const hashtags = generatedContent.hashtags || "";

    const botConfig = await prisma.botConfig.findUnique({
      where: { userId },
      select: { backgroundImageUrl: true },
    });

    let mediaUrl: string | null = null;
    try {
      mediaUrl = await this.imageService.createTopicImage(
        headline,
        botConfig?.backgroundImageUrl ?? undefined,
        { headline, subheadline, bulletPoints },
      );
    } catch (e) {
      console.error("Image generation failed:", e);
    }

    const linkedInAccount = await prisma.linkedInAccount.findFirst({
      where: { userId },
      select: { id: true },
    });

    const regionId = await this.getUserRegionId(userId);

    await prisma.post.create({
      data: {
        userId,
        regionId,
        content: `${body}\n\n${hashtags}`,
        status: "REVIEW",
        scheduledAt,
        source: "AI",
        mediaUrl,
        hashtags,
        linkedinAccountId: linkedInAccount?.id ?? null,
      },
    });

    console.log(`Created review post with proposed slot ${scheduledAt.toISOString()}`);
  }

  async previewTrends(userId: string) {
    const config = await prisma.botConfig.findUnique({ where: { userId } });
    if (!config) return [];

    let niches: string[] = [];
    try {
      niches = JSON.parse(config.niches);
    } catch {
      niches = ["Technology"];
    }

    const sources = config.sources ? JSON.parse(config.sources) : ["google"];
    let customRssFeeds: string[] = [];
    try {
      customRssFeeds = config.customRssFeeds
        ? JSON.parse(config.customRssFeeds)
        : [];
    } catch {}
    let customLinks: string[] = [];
    try {
      customLinks = (config as any).customLinks
        ? JSON.parse((config as any).customLinks)
        : [];
    } catch {}
    let customRedditFeeds: string[] = [];
    try {
      customRedditFeeds = (config as any).customRedditFeeds
        ? JSON.parse((config as any).customRedditFeeds)
        : [];
    } catch {}

    let allTrends: Trend[] = [];
    for (const niche of niches) {
      try {
        allTrends.push(
          ...(await this.trendsService.fetchTrends(
            niche,
            sources,
            customRssFeeds,
            customLinks,
            customRedditFeeds,
          )),
        );
      } catch (e) {}
    }

    return Array.from(
      new Map(allTrends.map((item) => [item.title, item])).values(),
    ).slice(0, 20);
  }
}
