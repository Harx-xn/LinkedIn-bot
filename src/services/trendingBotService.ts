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
import { jaccardSimilarity } from "./ghostwriterTextUtils";
import {
  GHOSTWRITER_CONFIG_REQUIRED_MESSAGE,
  GHOSTWRITER_NICHES_REQUIRED_MESSAGE,
} from "./ghostwriterConfigRequirementService";
import { buildEffectiveBotStrategy } from "./botStrategyService";
import {
  getStrategyNiches,
  hasStrategyGenerationContext,
} from "./botStrategyTrendService";

function resolveBrandNameFromWebsite(websiteUrl?: string | null): string | undefined {
  if (!websiteUrl?.trim()) return undefined;
  try {
    return new URL(websiteUrl).hostname.replace(/^www\./i, "");
  } catch {
    return undefined;
  }
}

const BATCH_GENERATION_CONCURRENCY = Math.min(
  4,
  Math.max(1, Number(process.env.BATCH_GENERATION_CONCURRENCY ?? 2) || 2),
);

type BatchPersistenceContext = {
  linkedinAccountId: string | null;
  regionId: string | null;
};

export class TrendingBotService {
  private trendsService: TrendsService;
  private imageService: ImageService;

  constructor() {
    this.trendsService = new TrendsService();
    this.imageService = new ImageService();
  }

  /** Internal diagnostics only: real discovery/scoring with no posts, usage, scheduling, or history writes. */
  async dryRunTopics(userId: string, requestedTopics = 7) {
    const config = await prisma.botConfig.findUnique({ where: { userId } });
    if (!config) throw new BatchScheduleError(GHOSTWRITER_CONFIG_REQUIRED_MESSAGE);
    const strategy = buildEffectiveBotStrategy(config);
    const niches = getStrategyNiches(strategy);
    if (!niches.length) throw new BatchScheduleError(GHOSTWRITER_NICHES_REQUIRED_MESSAGE);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { region: { select: { openaiApiKey: true } } },
    });
    const botConfig: GhostwriterBotConfig = {
      tone: config.tone,
      description: config.description,
      niches,
      strategy,
    };
    const pool = await prepareBatchContextV2({
      userId,
      niches,
      config: botConfig,
      slotCount: Math.max(1, requestedTopics),
      sources: parseTrendSources(config.sources),
      openaiApiKey: decryptSecret(user?.region?.openaiApiKey),
      allowPartial: true,
    });
    const selected = pool.ranked.slice(0, requestedTopics).map((item) => ({
      title: item.trend.topic,
      sourceUrl: item.trend.link ?? null,
      publisher: item.trend.publisher ?? item.trend.source ?? null,
      relevanceScore: item.relevanceScore,
      category: item.fingerprint.topicCluster,
      matchedPillar: item.matchedPillar ?? null,
      totalScore: item.totalScore,
      rejectionCodes: item.trend.strategyRiskFlags ?? [],
    }));
    console.info('[trend-dry-run] completed', { userId, requestedTopics, selectedCount: selected.length, selected });
    return { dryRun: true, requestedTopics, selectedCount: selected.length, selected, stats: pool.stats };
  }

  /** Internal acceptance runner for explicit niches; uses automatic discovery without persisting generated content. */
  async dryRunNiches(userId: string, niches: string[], requestedTopics = 7) {
    const config = await prisma.botConfig.findUnique({ where: { userId } });
    if (!config) throw new BatchScheduleError(GHOSTWRITER_CONFIG_REQUIRED_MESSAGE);
    const baseStrategy = buildEffectiveBotStrategy(config);
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { region: { select: { openaiApiKey: true } } } });
    const results = [];
    for (const niche of niches) {
      const strategy = {
        ...baseStrategy,
        contentPillars: {
          ...baseStrategy.contentPillars,
          primaryPillars: [{ name: niche, description: niche, audienceRelevance: '', exampleAngles: [], trendKeywords: [] }],
          secondaryPillars: [], experimentalPillars: [],
        },
      };
      const pool = await prepareBatchContextV2({
        userId, niches: [niche], config: { tone: config.tone, description: config.description, niches: [niche], strategy },
        slotCount: requestedTopics, sources: ['automatic'], openaiApiKey: decryptSecret(user?.region?.openaiApiKey), allowPartial: true,
      });
      results.push({
        niche, requestedTopics, selectedCount: pool.ranked.length, stats: pool.stats,
        topics: pool.ranked.map((item) => ({
          title: item.trend.topic, intent: item.trend.discoveryIntent ?? null, evidenceRole: item.trend.evidenceRole ?? 'idea_only',
          discoverySource: item.trend.discoverySource ?? item.trend.source ?? null,
          supportingSources: item.trend.supportingSources ?? [], sourceType: item.trend.sourceType ?? 'searched',
          angleType: item.trend.angleType ?? null, relevanceScore: item.relevanceScore, totalScore: item.totalScore,
        })),
      });
    }
    console.info('[trend-dry-run] multi-niche completed', { userId, results });
    return { dryRun: true, results };
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

      const strategy = buildEffectiveBotStrategy(config);
      if (!hasStrategyGenerationContext(strategy)) {
        console.warn("Skipping trend fetch: ghostwriter description is missing", {
          userId: config.userId,
        });
        continue;
      }

      const niches = getStrategyNiches(strategy);
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
    
          const botConfig: GhostwriterBotConfig = {
            tone: config.tone,
            description: config.description,
            niches: [niche],
            imageMode: resolveBotImageMode(config),
            backgroundImageUrl: config.backgroundImageUrl,
            imageInstructions: config.imageInstructions,
            imageStyle: config.imageStyle,
            imageAspectRatio: config.imageAspectRatio,
            contactInfo: config.contactInfo,
            websiteUrl: config.websiteUrl,
            includeContactInfo: config.includeContactInfo,
            includeWebsiteLink: config.includeWebsiteLink,
            strategy,
          };

          const author = {
            description: strategy.profilePositioning.positioningStatement || config.description || '',
            tone: strategy.writingStyle.tone[0] || config.tone || 'Professional',
            niches: [niche],
            targetAudience: [
              strategy.targetAudience.primaryAudience,
              ...(strategy.targetAudience.secondaryAudiences ?? []),
            ].filter(Boolean),
            strategy,
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
            slotCount: 1,
            strategy,
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
    const strategy = buildEffectiveBotStrategy(config);
    if (!hasStrategyGenerationContext(strategy)) {
      throw new BatchScheduleError(GHOSTWRITER_CONFIG_REQUIRED_MESSAGE);
    }

    const slots = options.slots;
    if (!slots.length) {
      throw new BatchScheduleError(BATCH_GENERATION_SLOTS_REQUIRED_MESSAGE);
    }

    console.log(`Generating batch for user ${userId}, slots: ${slots.length}`);

    const niches = getStrategyNiches(strategy);
    if (niches.length === 0) {
      throw new BatchScheduleError(GHOSTWRITER_NICHES_REQUIRED_MESSAGE);
    }

    const sources = parseTrendSources(config.sources);
  
    const [user] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          regionId: true,
          region: { select: { openaiApiKey: true, geminiApiKeys: true } },
        },
      }),
      jobId
        ? prisma.botGenerationJob.update({
            where: { id: jobId },
            data: { totalSlots: slots.length, completedSlots: 0 },
          })
        : Promise.resolve(null),
    ]);
    const openaiKey = decryptSecret(user?.region?.openaiApiKey);
    const contentService = new ContentService({
      openaiApiKey: openaiKey,
      geminiApiKeys: decryptSecretArray(user?.region?.geminiApiKeys),
    });

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
      contactInfo: config.contactInfo,
      websiteUrl: config.websiteUrl,
      includeContactInfo: config.includeContactInfo,
      includeWebsiteLink: config.includeWebsiteLink,
      strategy,
    };

    const configHash = buildTrendConfigHash({
      niches,
      sources,
     });

    const { author, eligible, ranked } = await prepareBatchContextV2({
      userId,
      niches,
      config: botConfig,
      slotCount: slots.length,
      sources,
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
    const [history, linkedInAccount] = await Promise.all([
      loadRecentTopicHistory(userId),
      prisma.linkedInAccount.findFirst({
        where: { userId },
        select: { id: true },
      }),
    ]);
    const persistenceContext: BatchPersistenceContext = {
      linkedinAccountId: linkedInAccount?.id ?? null,
      regionId: user?.regionId ?? null,
    };
    let postsCreated = 0;

    for (let waveStart = 0; waveStart < slots.length; waveStart += BATCH_GENERATION_CONCURRENCY) {
      const waveIndexes = Array.from(
        { length: Math.min(BATCH_GENERATION_CONCURRENCY, slots.length - waveStart) },
        (_, offset) => waveStart + offset,
      );
      const contextBodies = [...acceptedBodies];
      const contextFingerprints = [...batchFingerprints];
      const waveResults = await Promise.all(waveIndexes.map(async (slotIndex) => {
        const plan = batchPlan[slotIndex];
        const trend: TrendCandidate | null = eligible[slotIndex] ?? null;
        const result = await generateSlotPostUntilSuccess(
          contentService,
          plan,
          trend,
          author,
          botConfig,
          contextBodies,
          provider,
          { batchFingerprints: contextFingerprints, recentTopicHistory: history },
        );
        return { slotIndex, plan, trend, result };
      }));

      for (const item of waveResults) {
        const sourceTitle = item.trend?.topic ?? item.plan.sourceTopic ?? undefined;
        const candidateFingerprint = fingerprintFromBody(
          item.result.finalized.body,
          sourceTitle,
          item.plan.angle,
        );
        const conflictsWithAccepted = acceptedBodies.some(
          (body) => jaccardSimilarity(item.result.finalized.body, body) > 0.55,
        );
        const conflictsByFingerprint = batchFingerprints.some(
          (fingerprint) =>
            fingerprint.normalizedTopic === candidateFingerprint.normalizedTopic
            || (
              fingerprint.topicCluster === candidateFingerprint.topicCluster
              && jaccardSimilarity(fingerprint.coreClaim, candidateFingerprint.coreClaim) > 0.55
            ),
        );
        if (conflictsWithAccepted || conflictsByFingerprint) {
          console.info('[ghostwriter] regenerating concurrent batch collision', {
            slotIndex: item.slotIndex,
            sourceTitle,
          });
          item.result = await generateSlotPostUntilSuccess(
            contentService,
            item.plan,
            item.trend,
            author,
            botConfig,
            acceptedBodies,
            provider,
            { batchFingerprints, recentTopicHistory: history },
          );
        }
        acceptedBodies.push(item.result.finalized.body);
        batchFingerprints.push(fingerprintFromBody(
          item.result.finalized.body,
          sourceTitle,
          item.plan.angle,
        ));
      }

      const persistResult = async ({ slotIndex, plan, trend, result }: (typeof waveResults)[number]) => {
        await this.saveReviewPost(
          userId,
          result.finalized,
          result.imageContent,
          slots[slotIndex],
          botConfig,
          persistenceContext,
          {
            batchId: jobId,
            sourceTitle: trend?.topic ?? plan.sourceTopic ?? undefined,
            fingerprint: fingerprintFromBody(result.finalized.body, trend?.topic ?? plan.sourceTopic ?? undefined, plan.angle),
            angle: plan.angle,
          },
        );
        if (jobId) {
          await prisma.botGenerationJob.update({
            where: { id: jobId },
            data: { completedSlots: { increment: 1 } },
          });
        }
      };
      if (botConfig.imageMode === 'none') {
        await Promise.all(waveResults.map(persistResult));
      } else {
        // Image usage checks are not reservational; keep image-bearing saves
        // ordered so concurrent slots cannot overrun a user's plan allowance.
        for (const result of waveResults) await persistResult(result);
      }
      postsCreated += waveResults.length;
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
    persistenceContext: BatchPersistenceContext,
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

    const created = await prisma.post.create({
      data: {
        userId,
        regionId: persistenceContext.regionId,
        content: finalized.content,
        status: "REVIEW",
        scheduledAt,
        source: "AI",
        mediaUrl,
        hashtags: finalized.hashtags,
        linkedinAccountId: persistenceContext.linkedinAccountId,
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
        knownNewPost: true,
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

    const strategy = buildEffectiveBotStrategy(config);
    if (!hasStrategyGenerationContext(strategy)) {
      throw new BatchScheduleError(GHOSTWRITER_CONFIG_REQUIRED_MESSAGE);
    }

    const niches = getStrategyNiches(strategy);
    if (niches.length === 0) {
      throw new BatchScheduleError(GHOSTWRITER_NICHES_REQUIRED_MESSAGE);
    }

    const sources = parseTrendSources(config.sources);
    if (config.sources?.trim() === "[]") {
      console.warn("[previewTrends] No trend sources configured; defaulting to Google News", { userId });
    }

     const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { region: { select: { openaiApiKey: true } } },
    });
    const openaiKey = decryptSecret(user?.region?.openaiApiKey);

    const limit = options?.limit ?? 20;
    const configHash = buildTrendConfigHash({
      niches,
      sources
     });

    const orchestrator = new TrendOrchestrationService(openaiKey);
    const pool = await orchestrator.getRankedTrendPool({
      userId,
      niches,
      author: {
        description: strategy.profilePositioning.positioningStatement || config.description || "",
        tone: strategy.writingStyle.tone[0] || config.tone || "Professional",
        niches,
        targetAudience: [
          strategy.targetAudience.primaryAudience,
          ...(strategy.targetAudience.secondaryAudiences ?? []),
        ].filter(Boolean),
        strategy,
      },
      sources,
      limit,
      mode: "preview",
      strategy,
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
