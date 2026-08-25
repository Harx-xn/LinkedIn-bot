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
  buildReplacementPlan,
  generateSlotPostWithIdeaRecovery,
  generateSlotPostUntilSuccess,
  planBatchForGeneration,
  prepareBatchContextV2,
  type GhostwriterBotConfig,
} from "./ghostwriterPipeline";
import { candidateTraceId, selectReplacementIdea, type SlotIdeaPool } from './ideaRecoveryService';
import { safeRecommendMediaForPost, type MediaRecommendationResult } from './mediaRecommendationService';
import {
  inferActualShareabilityPresentation,
  type ShareabilityProfile,
} from './shareabilityIntelligenceService';
import { evaluateTopicCombination } from "./ghostwriterQualityService";
import { buildDeterministicBatchPlan } from "./ghostwriterBatchPlanner";
import type { PreviewTrendsResponse, TopicFingerprint, TrendCandidate } from "./generationTypes";
import { RECENT_STYLE_POST_LIMIT } from './expressionModeService';
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
import { classifyFinalPostFingerprint } from './finalPostFingerprintClassifier';
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
import { consumeInventoryTopic, releaseInventoryTopic, availableInventoryByNiche, INVENTORY_LOW_WATERMARK, enqueueLowInventoryReplenishment } from './topicInventoryService';
import { persistGeneratedPostWithMemory } from './generatedPostPersistenceService';
import {
  BatchGenerationTraceRecorder,
  createBatchTraceId,
  clearExpiredGenerationTracesSafe,
  diagnosticFingerprint,
  diagnosticTraceId,
  persistGenerationTraceSafe,
} from './batchGenerationTraceService';
import { classifyPostDepthWithTrace } from './postDepth';

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
            tone: strategy.writingStyle.tone[0] || config.tone || 'Conversational',
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
    const batchTraceId = createBatchTraceId(jobId);
    const traceRecorder = new BatchGenerationTraceRecorder({
      batchTraceId,
      strategyFingerprint: diagnosticFingerprint({
        profilePositioning: strategy.profilePositioning,
        targetAudience: strategy.targetAudience,
        contentGoals: strategy.contentGoals,
        contentPillars: strategy.contentPillars,
        topicRules: strategy.topicRules,
        writingStyle: strategy.writingStyle,
      }),
      requestedPostCount: slots.length,
    });
    await persistGenerationTraceSafe(jobId, traceRecorder);

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

    const inventoryJobId = jobId ?? `batch-${userId}-${Date.now()}`;
    const { author, eligible, ranked, editorialMemory, performanceProfile, slotIdeaPools, ideaRecoveryMemory } = await prepareBatchContextV2({
      userId,
      niches,
      config: botConfig,
      slotCount: slots.length,
      sources,
      openaiApiKey: openaiKey,
      previewId: options?.previewId,
      configHash,
      generationJobId: inventoryJobId,
      traceRecorder,
    });

    const provider: "OPENAI" = "OPENAI";
    const batchPlan = await planBatchForGeneration(
      contentService,
      eligible,
      author,
      slots.length,
      provider,
      ranked,
      editorialMemory,
      performanceProfile,
    );
    batchPlan.forEach((plan, slotIndex) => {
      const slotTraceId = diagnosticTraceId('slot', batchTraceId, slotIndex);
      const depth = classifyPostDepthWithTrace(plan, eligible[slotIndex]);
      traceRecorder.recordSlot({
        slotTraceId,
        slotIndex,
        candidateTraceId: ranked[slotIndex] ? candidateTraceId(ranked[slotIndex]) : null,
        selectedCentralClaim: plan.selectedCentralClaim ?? plan.centralClaim ?? plan.coreClaim ?? null,
        claimSource: plan.claimSource ?? null,
        depth: {
          depthClass: plan.depthClass ?? depth.depthClass,
          targetLengthRange: plan.targetLengthRange ?? depth.targetLengthRange,
          depthScore: depth.depthScore,
          rawDepthSignals: depth.rawDepthSignals,
          independentSubstanceUnits: depth.independentSubstanceUnits,
          discountedRedundantSignals: depth.discountedRedundantSignals,
          signalsContributing: depth.signalsContributing,
        },
        editorial: {
          shareabilityPotential: plan.editorialDecision?.shareabilityProfile?.overallPotential ?? null,
          valueType: plan.editorialDecision?.shareabilityProfile?.valueType ?? null,
          recommendedPresentation: plan.editorialDecision?.shareabilityProfile?.recommendedPresentation ?? null,
          contentObjective: plan.editorialDecision?.contentObjective ?? null,
          conversionObjective: plan.editorialDecision?.conversionObjective ?? null,
          hookFamily: plan.editorialDecision?.hookFamily ?? null,
          rhetoricalStructure: plan.editorialDecision?.rhetoricalStructure ?? null,
          endingIntent: plan.editorialDecision?.endingIntent ?? null,
        },
        alternateCandidateTraceIds: slotIdeaPools[slotIndex]?.alternates.map((candidate) => candidate.id) ?? [],
      });
    });
    await persistGenerationTraceSafe(jobId, traceRecorder);

    const acceptedBodies: string[] = [];
    const acceptedCandidateTraceIds: string[] = [];
    const batchFingerprints: TopicFingerprint[] = [];
    const acceptedPlans: import('./generationTypes').BatchPostPlan[] = [];
    const [history, linkedInAccount, recentVoicePosts] = await Promise.all([
      loadRecentTopicHistory(userId),
      prisma.linkedInAccount.findFirst({
        where: { userId },
        select: { id: true },
      }),
      prisma.post.findMany({
        where: { userId, source: { in: ['AI', 'AI_TRENDING', 'MANUAL'] }, status: { in: ['REVIEW', 'SCHEDULED', 'PUBLISHED'] } },
        orderBy: { createdAt: 'desc' },
        take: RECENT_STYLE_POST_LIMIT,
        select: { content: true },
      }),
    ]);
    const recentPosts = recentVoicePosts.map((post) => post.content);
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
      const contextPlans = [...acceptedPlans];
      const waveResults = await Promise.all(waveIndexes.map(async (slotIndex) => {
        const slotTraceId = diagnosticTraceId('slot', batchTraceId, slotIndex);
        const plan = batchPlan[slotIndex];
        const trend: TrendCandidate | null = eligible[slotIndex] ?? null;
        const ideaPool: SlotIdeaPool = slotIdeaPools[slotIndex] ?? {
          selected: { id: candidateTraceId(ranked[slotIndex]), ranked: ranked[slotIndex] },
          alternates: [],
        };
        try {
          const recovery = await generateSlotPostWithIdeaRecovery(
            contentService,
            { candidateId: ideaPool.selected.id, plan, trend, origin: trend?.ideaOrigin ?? trend?.sourceType },
            author,
            botConfig,
            contextBodies,
            provider,
            {
              batchFingerprints: contextFingerprints,
              recentTopicHistory: history,
              recentPosts: [...contextBodies, ...recentPosts].slice(0, RECENT_STYLE_POST_LIMIT),
              traceRecorder,
              slotTraceId,
            },
            (_failure, attemptedCandidateIds) => {
              const replacement = selectReplacementIdea({
                pool: ideaPool,
                attemptedCandidateIds,
                acceptedBatchFingerprints: contextFingerprints,
                recentMemory: ideaRecoveryMemory,
                performanceProfile,
              });
              if (!replacement) {
                traceRecorder.recordIdeaReplacement(slotTraceId, {
                  exhaustionReason: _failure.exhaustionReason,
                  replacementCandidateTraceId: null,
                  replacementSelectionReason: 'no_safe_alternate',
                });
                return null;
              }
              const replacementPlan = buildReplacementPlan({
                candidate: replacement,
                slotIndex,
                author,
                config: botConfig,
                editorialMemory,
                performanceProfile,
                acceptedPlans: contextPlans,
              });
              const replacementDepth = classifyPostDepthWithTrace(replacementPlan, replacement.ranked.trend);
              traceRecorder.recordIdeaReplacement(slotTraceId, {
                exhaustionReason: _failure.exhaustionReason,
                replacementCandidateTraceId: replacement.id,
                replacementSelectionReason: 'highest_ranked_safe_current_batch_alternate',
                replacementDepth: {
                  depthClass: replacementDepth.depthClass,
                  targetLengthRange: replacementDepth.targetLengthRange,
                  depthScore: replacementDepth.depthScore,
                  rawDepthSignals: replacementDepth.rawDepthSignals,
                  independentSubstanceUnits: replacementDepth.independentSubstanceUnits,
                  discountedRedundantSignals: replacementDepth.discountedRedundantSignals,
                  signalsContributing: replacementDepth.signalsContributing,
                },
              });
              return {
                candidateId: replacement.id,
                trend: replacement.ranked.trend,
                plan: replacementPlan,
                origin: replacement.ranked.trend.ideaOrigin ?? replacement.ranked.trend.sourceType,
              };
            },
          );
          traceRecorder.recordFinal(
            slotTraceId,
            recovery.finalIdea.candidateId,
            recovery.result.fallbackProvenance ?? ['NORMAL_ACCEPTANCE'],
          );
          if (trend?.inventoryId && trend.inventoryId !== recovery.finalIdea.trend?.inventoryId) {
            await releaseInventoryTopic(trend.inventoryId, inventoryJobId);
          }
          return {
            slotIndex,
            plan: recovery.finalIdea.plan,
            trend: recovery.finalIdea.trend,
            initialTrend: trend,
            ideaPool,
            slotTraceId,
            result: recovery.result,
          };
        } catch (error) {
          if (trend?.inventoryId) await releaseInventoryTopic(trend.inventoryId, inventoryJobId);
          throw error;
        }
      }));

      for (const item of waveResults) {
        const sourceTitle = item.trend?.topic ?? item.plan.sourceTopic ?? undefined;
        const candidateFingerprint = fingerprintFromBody(
          item.result.finalized.body,
          sourceTitle,
          item.plan.angle,
        );
        const bodyCollisionIndex = acceptedBodies.findIndex(
          (body) => jaccardSimilarity(item.result.finalized.body, body) > 0.55,
        );
        const fingerprintCollisionIndex = batchFingerprints.findIndex(
          (fingerprint) =>
            fingerprint.normalizedTopic === candidateFingerprint.normalizedTopic
            || (
              fingerprint.topicCluster === candidateFingerprint.topicCluster
              && jaccardSimilarity(fingerprint.coreClaim, candidateFingerprint.coreClaim) > 0.55
            ),
        );
        const conflictsWithAccepted = bodyCollisionIndex >= 0;
        const conflictsByFingerprint = fingerprintCollisionIndex >= 0;
        if (conflictsWithAccepted || conflictsByFingerprint) {
          const collisionIndex = bodyCollisionIndex >= 0 ? bodyCollisionIndex : fingerprintCollisionIndex;
          traceRecorder.recordCollision(
            item.result.finalIdeaUsed ?? item.ideaPool.selected.id,
            acceptedCandidateTraceIds[collisionIndex] ?? null,
          );
          console.info('[ghostwriter] regenerating concurrent batch collision', {
            slotIndex: item.slotIndex,
            sourceTitle,
          });
          const collisionRecovery = await generateSlotPostWithIdeaRecovery(
            contentService,
            {
              candidateId: item.result.finalIdeaUsed ?? candidateTraceId(item.ideaPool.selected.ranked),
              plan: item.plan,
              trend: item.trend,
              origin: item.trend?.ideaOrigin ?? item.trend?.sourceType,
            },
            author,
            botConfig,
            acceptedBodies,
            provider,
            {
              batchFingerprints,
              recentTopicHistory: history,
              recentPosts: [...acceptedBodies, ...recentPosts].slice(0, RECENT_STYLE_POST_LIMIT),
              retainedCollisionCandidate: item.result,
              originOverride: 'collision_regeneration',
              traceRecorder,
              slotTraceId: item.slotTraceId,
            },
            (_failure, attemptedCandidateIds) => {
              const replacement = selectReplacementIdea({
                pool: item.ideaPool,
                attemptedCandidateIds,
                acceptedBatchFingerprints: batchFingerprints,
                recentMemory: ideaRecoveryMemory,
                performanceProfile,
              });
              if (!replacement) {
                traceRecorder.recordIdeaReplacement(item.slotTraceId, {
                  exhaustionReason: _failure.exhaustionReason,
                  replacementCandidateTraceId: null,
                  replacementSelectionReason: 'no_safe_alternate',
                });
                return null;
              }
              const replacementPlan = buildReplacementPlan({
                candidate: replacement,
                slotIndex: item.slotIndex,
                author,
                config: botConfig,
                editorialMemory,
                performanceProfile,
                acceptedPlans,
              });
              const replacementDepth = classifyPostDepthWithTrace(replacementPlan, replacement.ranked.trend);
              traceRecorder.recordIdeaReplacement(item.slotTraceId, {
                exhaustionReason: _failure.exhaustionReason,
                replacementCandidateTraceId: replacement.id,
                replacementSelectionReason: 'highest_ranked_safe_current_batch_alternate',
                replacementDepth: {
                  depthClass: replacementDepth.depthClass,
                  targetLengthRange: replacementDepth.targetLengthRange,
                  depthScore: replacementDepth.depthScore,
                  rawDepthSignals: replacementDepth.rawDepthSignals,
                  independentSubstanceUnits: replacementDepth.independentSubstanceUnits,
                  discountedRedundantSignals: replacementDepth.discountedRedundantSignals,
                  signalsContributing: replacementDepth.signalsContributing,
                },
              });
              return {
                candidateId: replacement.id,
                trend: replacement.ranked.trend,
                plan: replacementPlan,
                origin: replacement.ranked.trend.ideaOrigin ?? replacement.ranked.trend.sourceType,
              };
            },
          );
          if (item.trend?.inventoryId && item.trend.inventoryId !== collisionRecovery.finalIdea.trend?.inventoryId) {
            await releaseInventoryTopic(item.trend.inventoryId, inventoryJobId);
          }
          item.result = collisionRecovery.result;
          item.plan = collisionRecovery.finalIdea.plan;
          item.trend = collisionRecovery.finalIdea.trend;
          traceRecorder.recordFinal(
            item.slotTraceId,
            collisionRecovery.finalIdea.candidateId,
            collisionRecovery.result.fallbackProvenance ?? ['COLLISION_REGENERATION', 'NORMAL_ACCEPTANCE'],
          );
        }
        acceptedBodies.push(item.result.finalized.body);
        acceptedPlans.push(item.plan);
        acceptedCandidateTraceIds.push(item.result.finalIdeaUsed ?? item.ideaPool.selected.id);
        const finalSourceTitle = item.trend?.topic ?? item.plan.sourceTopic ?? undefined;
        batchFingerprints.push(fingerprintFromBody(
          item.result.finalized.body,
          finalSourceTitle,
          item.plan.angle,
        ));
      }

      const persistResult = async ({ slotIndex, plan, trend, result }: (typeof waveResults)[number]) => {
        try {
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
            sourceGrounded: !!trend?.link && trend?.sourceType !== 'strategy_derived',
            fingerprint: fingerprintFromBody(result.finalized.body, trend?.topic ?? plan.sourceTopic ?? undefined, plan.angle),
            angle: plan.angle,
            pillar: trend?.matchedPillar ?? trend?.originNiche ?? trend?.niche,
            territory: trend?.territory,
            mechanism: trend?.fingerprint?.mechanisms?.[0],
            perspective: trend?.audienceRelevance,
            argumentPattern: plan.layout,
            authorityMode: trend?.authorityMode,
            contentIntent: trend?.ideaFamily ?? plan.angle,
            plannedConceptualMotif: trend?.conceptualMotif,
            plannedReasoningArchetype: trend?.reasoningArchetype,
            contentObjective: plan.editorialDecision?.contentObjective,
            conversionObjective: plan.editorialDecision?.conversionObjective,
            hookFamily: plan.editorialDecision?.hookFamily,
            rhetoricalStructure: plan.editorialDecision?.rhetoricalStructure,
            endingIntent: plan.editorialDecision?.endingIntent,
            depthBand: plan.depthClass,
            shareabilityProfile: plan.editorialDecision?.shareabilityProfile,
          },
          );
          if (trend?.inventoryId) await consumeInventoryTopic(trend.inventoryId, inventoryJobId);
        } catch (error) {
          if (trend?.inventoryId) await releaseInventoryTopic(trend.inventoryId, inventoryJobId);
          throw error;
        }
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
      await persistGenerationTraceSafe(jobId, traceRecorder);
    }

    console.log(`Batch complete. Created ${postsCreated} posts.`);
    const inventoryAvailableAfterBatch = await availableInventoryByNiche(userId, niches);
    console.info('[topic-inventory] post-batch levels', {
      userId, inventoryAvailableAfterBatch,
      lowNiches: niches.filter((niche) => (inventoryAvailableAfterBatch[niche] ?? 0) < INVENTORY_LOW_WATERMARK),
    });
    enqueueLowInventoryReplenishment({
      userId, niches: niches.filter((niche) => (inventoryAvailableAfterBatch[niche] ?? 0) < INVENTORY_LOW_WATERMARK),
      author, strategy, sources, openaiApiKey: openaiKey,
    });
    await persistGenerationTraceSafe(jobId, traceRecorder, { completed: true });
    void clearExpiredGenerationTracesSafe();
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
      sourceGrounded?: boolean;
      fingerprint: TopicFingerprint;
      angle?: import('./generationTypes').PostAngle;
      pillar?: string;
      territory?: string;
      mechanism?: string;
      perspective?: string;
      argumentPattern?: string;
      authorityMode?: string;
      contentIntent?: string;
      plannedConceptualMotif?: string | null;
      plannedReasoningArchetype?: string | null;
      contentObjective?: string;
      conversionObjective?: string;
      hookFamily?: string;
      rhetoricalStructure?: string;
      endingIntent?: string;
      depthBand?: string;
      mediaRecommendation?: MediaRecommendationResult;
      shareabilityProfile?: ShareabilityProfile;
    },
  ) {
    const mediaRecommendation = topicMeta?.mediaRecommendation ?? safeRecommendMediaForPost(finalized.body, {
      rhetoricalStructure: topicMeta?.rhetoricalStructure,
      contentObjective: topicMeta?.contentObjective,
      shareabilityProfile: topicMeta?.shareabilityProfile,
    });
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
      mediaRecommendation,
      uploadKeyPrefix: `generated/ai-batch-${userId}`,
    });

    const topicFingerprint = topicMeta?.fingerprint;
    const finalClassification = topicFingerprint ? classifyFinalPostFingerprint(finalized.body, {
        plannedMechanism: topicMeta?.mechanism ?? topicFingerprint.mechanisms[0],
        plannedIdeaFamily: topicMeta.contentIntent,
        sourcePresent: !!topicMeta.sourceGrounded,
      }) : null;
    const created = await persistGeneratedPostWithMemory(prisma, async (tx) => {
      const post = await tx.post.create({
        data: {
          userId,
          regionId: persistenceContext.regionId,
          content: finalized.content,
          status: "REVIEW",
          scheduledAt,
          source: "AI",
          mediaUrl,
          attachmentType: mediaUrl ? 'IMAGE' : 'NONE',
          hashtags: finalized.hashtags,
          linkedinAccountId: persistenceContext.linkedinAccountId,
        },
      });
      if (!topicMeta || !topicFingerprint || !finalClassification) return post;
      await Promise.all([
        createGeneratedTopicHistory({
          userId,
          postId: post.id,
          batchId: topicMeta.batchId,
          sourceTitle: topicMeta.sourceTitle,
          fingerprint: topicFingerprint,
          angle: topicMeta.angle,
          knownNewPost: true,
          transaction: tx,
        }),
        tx.postContentFingerprint.create({ data: {
          userId, postId: post.id,
          primaryTopic: topicFingerprint.normalizedTopic,
          subtopic: topicMeta.sourceTitle,
          pillar: topicMeta.pillar,
          territory: topicMeta.territory,
          coreClaim: topicFingerprint.coreClaim,
          mechanism: finalClassification.mechanism ?? topicMeta.mechanism ?? topicFingerprint.mechanisms[0],
          perspective: finalClassification.perspective,
          argumentPattern: finalClassification.argumentPattern,
          structure: finalClassification.structure,
          hookType: finalClassification.hookType,
          evidenceType: topicMeta.sourceGrounded ? 'SOURCE_GROUNDED' : 'REASONED_ARGUMENT',
          ctaType: finalClassification.ctaType,
          authorityMode: finalClassification.authorityMode,
          contentIntent: finalClassification.contentIntent,
          keywords: {
            entities: topicFingerprint.entities,
            endingType: finalClassification.endingIntent,
            endingClassifierDetail: finalClassification.endingType,
            ideaFamily: finalClassification.ideaFamily,
            plannedConceptualMotif: topicMeta.plannedConceptualMotif,
            finalConceptualMotif: finalClassification.conceptualMotif,
            plannedReasoningArchetype: topicMeta.plannedReasoningArchetype,
            finalReasoningArchetype: finalClassification.reasoningArchetype,
            contentObjective: finalClassification.contentIntent ?? topicMeta.contentObjective,
            plannedContentObjective: topicMeta.contentObjective,
            conversionObjective: topicMeta.conversionObjective,
            hookFamily: finalClassification.hookType ?? topicMeta.hookFamily,
            plannedHookFamily: topicMeta.hookFamily,
            rhetoricalStructure: finalClassification.structure ?? topicMeta.rhetoricalStructure,
            plannedRhetoricalStructure: topicMeta.rhetoricalStructure,
            plannedEndingIntent: topicMeta.endingIntent,
            depthBand: topicMeta.depthBand,
            visualType: mediaUrl ? 'IMAGE' : 'NONE',
            recommendedMediaType: mediaRecommendation.recommendation,
            recommendationConfidence: mediaRecommendation.confidence,
            shareabilityPotential: topicMeta.shareabilityProfile?.overallPotential,
            shareabilityValueType: topicMeta.shareabilityProfile?.valueType,
            recommendedPresentation: topicMeta.shareabilityProfile?.recommendedPresentation,
            actualPresentationUsed: inferActualShareabilityPresentation({
              content: finalized.body,
              structure: finalClassification.structure,
              visualType: mediaUrl ? 'IMAGE' : 'NONE',
            }),
          },
        } }),
      ]);
      return post;
    }, { userId, scheduledAt });

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
        tone: strategy.writingStyle.tone[0] || config.tone || "Conversational",
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
