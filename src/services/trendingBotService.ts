import { TrendsService, Trend, parseTrendSources } from "./trendsService";
import { ContentService } from "./contentService";
import { ImageService } from "./imageService";
import { prisma } from "../prismaClient";
import { decryptSecret, decryptSecretArray } from "./secretCrypto";
import { BATCH_GENERATION_SLOTS_REQUIRED_MESSAGE, BatchScheduleError } from "./batchScheduleService";
import {
  generateBatchPostMediaUrl,
  resolveBotImageMode,
} from "./botImageModeService";
import {
  generateSlotPostUntilSuccess,
  planBatchForGeneration,
  prepareBatchContextV2,
  type GhostwriterBotConfig,
} from "./ghostwriterPipeline";
import { evaluateTopicCombination } from "./ghostwriterQualityService";
import { buildDeterministicBatchPlan } from "./ghostwriterBatchPlanner";
import type { PreviewTrendsResponse, TopicFingerprint, TrendCandidate } from "./generationTypes";
import {
  rankedToLegacyTrends,
  rankedToPreviewItems,
  TrendOrchestrationService,
} from "./trendOrchestrationService";
import {
  buildTrendConfigHash,
  saveTrendPreviewPool,
} from "./trendPreviewPoolStore";
import { createGeneratedTopicHistory, loadRecentTopicHistory } from "./topicHistoryService";
import { fingerprintFromBody } from "./topicFingerprintService";
import {
  GHOSTWRITER_CONFIG_REQUIRED_MESSAGE,
  GHOSTWRITER_NICHES_REQUIRED_MESSAGE,
  hasGhostwriterDescription,
  parseSavedGhostwriterNiches,
} from "./ghostwriterConfigRequirementService";

function resolveBrandNameFromWebsite(websiteUrl?: string | null): string | undefined {
  if (!websiteUrl?.trim()) return undefined;
  try {
    return new URL(websiteUrl).hostname.replace(/^www\./i, "");
  } catch {
    return undefined;
  }
}

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

      if (!hasGhostwriterDescription(config.description)) {
        console.warn("Skipping trend fetch: ghostwriter description is missing", {
          userId: config.userId,
        });
        continue;
      }

      const niches = parseSavedGhostwriterNiches(config.niches);
      if (niches.length === 0) {
        console.warn("Skipping trend fetch: no saved niches", {
          userId: config.userId,
        });
        continue;
      }

      const contentService = await this.getContentService(config.userId);
      const regionId = config.regionId ?? (await this.getUserRegionId(config.userId));

      console.log(`User Niches: ${niches.join(", ")}`);

      for (const niche of niches) {
        console.log(`--- Processing Niche: ${niche} ---`);
        try {
          const sources = parseTrendSources(config.sources);
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

          const botConfig: GhostwriterBotConfig = {
            tone: config.tone,
            description: config.description,
            niches: [niche],
            imageMode: resolveBotImageMode(config),
            backgroundImageUrl: config.backgroundImageUrl,
            imageInstructions: config.imageInstructions,
            imageStyle: config.imageStyle,
            imageAspectRatio: config.imageAspectRatio,
            customLinks: config.customLinks,
            contactInfo: config.contactInfo,
            websiteUrl: config.websiteUrl,
            includeContactInfo: config.includeContactInfo,
            includeWebsiteLink: config.includeWebsiteLink,
          };

          const author = {
            description: config.description || '',
            tone: config.tone || 'Professional',
            niches: [niche],
          };

          const openaiKey = decryptSecret(
            (await prisma.user.findUnique({
              where: { id: config.userId },
              select: { region: { select: { openaiApiKey: true } } },
            }))?.region?.openaiApiKey,
          );
          const orchestrator = new TrendOrchestrationService(openaiKey);
          const pool = await orchestrator.buildTrendPoolForBatch({
            userId: config.userId,
            niches: [niche],
            author,
            sources,
            customFeeds: customRssFeeds,
            customLinks,
            customRedditFeeds,
            slotCount: 1,
          });
          const selectedRanked = pool.ranked[0];
          const selectedTrend: Trend | null = selectedRanked
            ? {
                title: selectedRanked.trend.topic,
                link: selectedRanked.trend.link ?? '',
                pubDate: String(selectedRanked.trend.publishedAt ?? ''),
                source: selectedRanked.trend.source ?? '',
                niche,
              }
            : null;

          if (!selectedTrend) {
            console.log(`No eligible trends for ${niche}. Skipping.`);
            continue;
          }

          const provider: "OPENAI" = "OPENAI";
          const plan = buildDeterministicBatchPlan(
            [{ topic: selectedTrend.title, link: selectedTrend.link, source: selectedTrend.source, fingerprint: selectedRanked?.fingerprint }],
            1,
          )[0];
          if (selectedRanked?.fingerprint) {
            plan.topicCluster = selectedRanked.fingerprint.topicCluster;
            plan.normalizedTopic = selectedRanked.fingerprint.normalizedTopic;
            plan.coreClaim = selectedRanked.fingerprint.coreClaim;
            plan.mechanismFocus = selectedRanked.fingerprint.mechanisms;
          }

          const history = await loadRecentTopicHistory(config.userId);
          const result = await generateSlotPostUntilSuccess(
            contentService,
            plan,
            { topic: selectedTrend.title, link: selectedTrend.link, source: selectedTrend.source, fingerprint: selectedRanked?.fingerprint },
            author,
            botConfig,
            [],
            provider,
            { batchFingerprints: [], recentTopicHistory: history },
          );

          if (dryRun) {
            console.log(`[DRY RUN] Generated for ${config.userId}:\n${result.finalized.content}`);
            continue;
          }

          const imagePath = await generateBatchPostMediaUrl({
            userId: config.userId,
            imageMode: botConfig.imageMode ?? resolveBotImageMode(config),
            backgroundImageUrl: config.backgroundImageUrl,
            imageInstructions: botConfig.imageInstructions,
            imageStyle: botConfig.imageStyle,
            imageAspectRatio: botConfig.imageAspectRatio,
            brandLogoUrl: botConfig.brandLogoUrl,
            brandLogoEnabled: botConfig.brandLogoEnabled,
            brandLogoPosition: botConfig.brandLogoPosition,
            profileDescription: botConfig.description,
            brandName: resolveBrandNameFromWebsite(botConfig.websiteUrl),
            postContent: result.finalized.content,
            imageService: this.imageService,
            finalized: result.finalized,
            imageContent: result.imageContent,
            uploadKeyPrefix: `generated/ai-trending-${config.userId}`,
          });

          const created = await prisma.post.create({
            data: {
              userId: config.userId,
              regionId,
              content: result.finalized.content,
              source: "AI_TRENDING",
              status: "REVIEW",
              hashtags: result.finalized.hashtags,
              mediaUrl: imagePath,
            },
          });
          const fp = selectedRanked?.fingerprint
            ?? fingerprintFromBody(result.finalized.body, selectedTrend.title, plan.angle);
          await createGeneratedTopicHistory({
            userId: config.userId,
            postId: created.id,
            sourceTitle: selectedTrend.title,
            fingerprint: fp,
            angle: plan.angle,
          });
          console.log(`Draft created for user ${config.userId}`);
        } catch (error) {
          console.error(`Error processing niche ${niche}:`, error);
        }
      }
    }
  }

  async generateNow(
    userId: string,
    jobId: string | undefined,
    options: { slots: Date[]; previewId?: string },
  ) {
    const config = await prisma.botConfig.findUnique({ where: { userId } });
    if (!config) {
      throw new BatchScheduleError(GHOSTWRITER_CONFIG_REQUIRED_MESSAGE);
    }
    if (!hasGhostwriterDescription(config.description)) {
      throw new BatchScheduleError(GHOSTWRITER_CONFIG_REQUIRED_MESSAGE);
    }

    const slots = options.slots;
    if (!slots.length) {
      throw new BatchScheduleError(BATCH_GENERATION_SLOTS_REQUIRED_MESSAGE);
    }

    console.log(`Generating batch for user ${userId}, slots: ${slots.length}`);

    const contentService = await this.getContentService(userId);

    const niches = parseSavedGhostwriterNiches(config.niches);
    if (niches.length === 0) {
      throw new BatchScheduleError(GHOSTWRITER_NICHES_REQUIRED_MESSAGE);
    }

    const sources = parseTrendSources(config.sources);
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

    if (jobId) {
      await prisma.botGenerationJob.update({
        where: { id: jobId },
        data: { totalSlots: slots.length, completedSlots: 0 },
      });
    }
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { region: { select: { openaiApiKey: true } } },
    });
    const openaiKey = decryptSecret(user?.region?.openaiApiKey);

    const botConfig: GhostwriterBotConfig = {
      tone: config.tone,
      description: config.description,
      niches,
      imageMode: resolveBotImageMode(config),
      backgroundImageUrl: config.backgroundImageUrl,
      imageInstructions: config.imageInstructions,
      imageStyle: config.imageStyle,
      imageAspectRatio: config.imageAspectRatio,
      brandLogoUrl: config.brandLogoUrl,
      brandLogoEnabled: config.brandLogoEnabled,
      brandLogoPosition: config.brandLogoPosition,
      customLinks: config.customLinks,
      contactInfo: config.contactInfo,
      websiteUrl: config.websiteUrl,
      includeContactInfo: config.includeContactInfo,
      includeWebsiteLink: config.includeWebsiteLink,
    };

    const configHash = buildTrendConfigHash({
      niches,
      sources,
      customFeeds: customRssFeeds,
      customLinks,
      customRedditFeeds,
    });

    const { author, eligible, ranked } = await prepareBatchContextV2({
      userId,
      niches,
      config: botConfig,
      slotCount: slots.length,
      sources,
      customFeeds: customRssFeeds,
      customLinks,
      customRedditFeeds,
      openaiApiKey: openaiKey,
      previewId: options?.previewId,
      configHash,
    });

    const provider: "OPENAI" = "OPENAI";
    const batchPlan = await planBatchForGeneration(
      contentService,
      eligible,
      author,
      slots.length,
      provider,
      ranked,
    );

    const acceptedBodies: string[] = [];
    const batchFingerprints: TopicFingerprint[] = [];
    const history = await loadRecentTopicHistory(userId);
    let postsCreated = 0;

    for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
      const currentSlot = slots[slotIndex];
      const plan = batchPlan[slotIndex];
      const trend: TrendCandidate | null = eligible[slotIndex] ?? null;

      const shouldMix = niches.length > 1 && (slotIndex + 1) % 4 === 0;
      if (shouldMix && eligible.length >= 2) {
        const t1 = eligible[slotIndex];
        const t2 = eligible[(slotIndex + 1) % eligible.length];
        const combine = evaluateTopicCombination(t1.topic, t2.topic, author);
        if (!combine.canCombine) {
          console.warn('[ghostwriter] skipping weak mixed slot', { reason: combine.reason });
        }
      }

      const result = await generateSlotPostUntilSuccess(
        contentService,
        plan,
        trend,
        author,
        botConfig,
        acceptedBodies,
        provider,
        { batchFingerprints, recentTopicHistory: history },
      );

      await this.saveReviewPost(
        userId,
        result.finalized,
        result.imageContent,
        currentSlot,
        botConfig,
        {
          batchId: jobId,
          sourceTitle: trend?.topic ?? plan.sourceTopic ?? undefined,
          fingerprint: trend?.fingerprint
            ?? (plan.normalizedTopic
              ? {
                  normalizedTopic: plan.normalizedTopic,
                  topicCluster: plan.topicCluster ?? 'other',
                  coreClaim: plan.coreClaim ?? plan.normalizedTopic,
                  entities: [],
                  mechanisms: plan.mechanismFocus ?? [],
                }
              : fingerprintFromBody(result.finalized.body, trend?.topic, plan.angle)),
          angle: plan.angle,
        },
      );
      acceptedBodies.push(result.finalized.body);
      const postFp = fingerprintFromBody(result.finalized.body, trend?.topic ?? plan.sourceTopic ?? undefined, plan.angle);
      batchFingerprints.push(postFp);
      postsCreated++;

      if (jobId) {
        await prisma.botGenerationJob.update({
          where: { id: jobId },
          data: { completedSlots: { increment: 1 } },
        });
      }
    }

    console.log(`Batch complete. Created ${postsCreated} posts.`);
  }

  private async saveReviewPost(
    userId: string,
    finalized: {
      content: string;
      hashtags: string;
      headline: string;
      subheadline: string;
      bulletPoints: string[];
      body: string;
    },
    imageContent: { mode: string; headline: string; supportingText?: string; bulletPoints?: string[] } | null,
    scheduledAt: Date,
    config: GhostwriterBotConfig,
    topicMeta?: {
      batchId?: string;
      sourceTitle?: string;
      fingerprint: TopicFingerprint;
      angle?: import('./generationTypes').PostAngle;
    },
  ) {
    const mediaUrl = await generateBatchPostMediaUrl({
      userId,
      imageMode: config.imageMode ?? resolveBotImageMode(config),
      backgroundImageUrl: config.backgroundImageUrl,
      imageInstructions: config.imageInstructions,
      imageStyle: config.imageStyle,
      imageAspectRatio: config.imageAspectRatio,
      brandLogoUrl: config.brandLogoUrl,
      brandLogoEnabled: config.brandLogoEnabled,
      brandLogoPosition: config.brandLogoPosition,
      profileDescription: config.description,
      brandName: resolveBrandNameFromWebsite(config.websiteUrl),
      postContent: finalized.content,
      imageService: this.imageService,
      finalized,
      imageContent,
      uploadKeyPrefix: `generated/ai-batch-${userId}`,
    });

    const linkedInAccount = await prisma.linkedInAccount.findFirst({
      where: { userId },
      select: { id: true },
    });

    const regionId = await this.getUserRegionId(userId);

    const created = await prisma.post.create({
      data: {
        userId,
        regionId,
        content: finalized.content,
        status: "REVIEW",
        scheduledAt,
        source: "AI",
        mediaUrl,
        hashtags: finalized.hashtags,
        linkedinAccountId: linkedInAccount?.id ?? null,
      },
    });

    if (topicMeta?.fingerprint) {
      await createGeneratedTopicHistory({
        userId,
        postId: created.id,
        batchId: topicMeta.batchId,
        sourceTitle: topicMeta.sourceTitle,
        fingerprint: topicMeta.fingerprint,
        angle: topicMeta.angle,
      });
    }

    console.log(`Created review post with proposed slot ${scheduledAt.toISOString()}`);
    return created;
  }

  private parseStringArrayConfig(
    rawValue: string | null | undefined,
    fieldName: string,
    userId: string,
  ): string[] {
    if (!rawValue) return [];
    try {
      const parsed = JSON.parse(rawValue);
      if (!Array.isArray(parsed)) {
        console.warn(`[previewTrends] ${fieldName} is not an array`, { userId });
        return [];
      }
      return parsed.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      );
    } catch (error) {
      console.error(`[previewTrends] Failed to parse ${fieldName}`, {
        userId,
        message: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  async previewTrends(
    userId: string,
    options?: { debug?: boolean; enriched?: boolean; limit?: number },
  ): Promise<Trend[] | PreviewTrendsResponse> {
    const config = await prisma.botConfig.findUnique({ where: { userId } });
    if (!config) {
      console.warn("[previewTrends] Bot config not found", { userId });
      return options?.debug ? { trends: [] } : [];
    }

    if (!hasGhostwriterDescription(config.description)) {
      throw new BatchScheduleError(GHOSTWRITER_CONFIG_REQUIRED_MESSAGE);
    }

    const niches = parseSavedGhostwriterNiches(config.niches);
    if (niches.length === 0) {
      throw new BatchScheduleError(GHOSTWRITER_NICHES_REQUIRED_MESSAGE);
    }

    const sources = parseTrendSources(config.sources);
    if (config.sources?.trim() === "[]") {
      console.warn("[previewTrends] No trend sources configured; defaulting to Google News", { userId });
    }

    const customRssFeeds = this.parseStringArrayConfig(config.customRssFeeds, "customRssFeeds", userId);
    const customLinks = this.parseStringArrayConfig(config.customLinks, "customLinks", userId);
    const customRedditFeeds = this.parseStringArrayConfig(config.customRedditFeeds, "customRedditFeeds", userId);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { region: { select: { openaiApiKey: true } } },
    });
    const openaiKey = decryptSecret(user?.region?.openaiApiKey);

    const limit = options?.limit ?? 20;
    const configHash = buildTrendConfigHash({
      niches,
      sources,
      customFeeds: customRssFeeds,
      customLinks,
      customRedditFeeds,
    });

    const orchestrator = new TrendOrchestrationService(openaiKey);
    const pool = await orchestrator.getRankedTrendPool({
      userId,
      niches,
      author: {
        description: config.description || "",
        tone: config.tone || "Professional",
        niches,
      },
      sources,
      customFeeds: customRssFeeds,
      customLinks,
      customRedditFeeds,
      limit,
      mode: "preview",
    });

    const stored = saveTrendPreviewPool({
      userId,
      configHash,
      candidates: pool.ranked,
    });

    if (options?.debug || options?.enriched) {
      return {
        trends: rankedToPreviewItems(pool.ranked),
        previewId: stored.id,
        stats: pool.stats,
        timingMs: pool.timingMs,
      };
    }

    return rankedToLegacyTrends(pool.ranked);
  }
}
