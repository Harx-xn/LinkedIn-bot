  import { Router } from 'express';
  import { requireAuth } from '../middleware/auth';
  import { TrendingBotService } from '../services/trendingBotService';
  import { prisma } from '../prismaClient';
  import { canGenerate } from '../services/entitlementService';
  import {
    BatchScheduleError,
    BatchScheduleCapacityError,
    NormalizedPostingScheduleConfig,
    parseBatchPostingScheduleRequest,
  } from '../services/batchScheduleService';
  import { resolveBatchGenerationSlots } from '../services/batchScheduleCapacityService';
  import {
    PlanLimitError,
    canStartBatchGeneration,
  } from '../services/planEntitlementService';
  import {
    GHOSTWRITER_CONFIG_REQUIRED_CODE,
    GHOSTWRITER_CONFIG_REQUIRED_MESSAGE,
    GHOSTWRITER_NICHES_REQUIRED_MESSAGE,
    getSavedGhostwriterRequirements,
  } from '../services/ghostwriterConfigRequirementService';
  import {
    reconcileStaleBatchGenerationJob,
    startBatchGenerationHeartbeat,
  } from '../services/batchGenerationJobLifecycleService';
  import { withAiCostContext } from '../services/costIntelligence/aiCostTrackingService';

  export type BotGenerateRequestBody = {
    daysWindow: number;
    postsPerWeek: number;
    startDate: string;
    batchPostingSchedule: unknown;
    allowPartialSchedule?: boolean;
    selectedSlotKeys?: string[];
    previewId?: string;
  };

  function parsePositiveInteger(value: unknown): number | null {
    if (value === undefined || value === null || value === '') return null;
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(n) || n <= 0) return null;
    return n;
  }

  const router = Router();
  const botService = new TrendingBotService();

  router.get("/generate/status/:jobId", requireAuth, async (req, res) => {
    const jobId = req.params.jobId.trim();
    await reconcileStaleBatchGenerationJob({ jobId, userId: req.userId! });
    const job = await prisma.botGenerationJob.findFirst({
      where: { id: jobId, userId: req.userId! },
    });

    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json(job);
  });

  router.post("/generate", requireAuth, async (req, res) => {
    const {
      daysWindow,
      postsPerWeek,
      startDate,
      batchPostingSchedule,
      allowPartialSchedule,
      selectedSlotKeys,
    } =
      req.body as BotGenerateRequestBody;
    if (!daysWindow) return res.status(400).json({ error: "Missing daysWindow" });
    if (!startDate) return res.status(400).json({ error: "Missing startDate" });

    if (postsPerWeek === undefined || postsPerWeek === null) {
      return res.status(400).json({ error: "Missing postsPerWeek" });
    }

    const parsedPostsPerWeek = parsePositiveInteger(postsPerWeek);
    if (parsedPostsPerWeek === null) {
      return res.status(400).json({
        error: "Invalid postsPerWeek. Provide a positive integer.",
      });
    }

    if (batchPostingSchedule === undefined || batchPostingSchedule === null) {
      return res.status(400).json({ error: "Missing batchPostingSchedule" });
    }

    const [ghostwriterRequirements, gate] = await Promise.all([
      getSavedGhostwriterRequirements(req.userId!),
      canGenerate(req.userId!),
    ]);
    if (!ghostwriterRequirements.hasDescription) {
      return res.status(400).json({
        error: GHOSTWRITER_CONFIG_REQUIRED_MESSAGE,
        code: GHOSTWRITER_CONFIG_REQUIRED_CODE,
      });
    }
    if (ghostwriterRequirements.niches.length === 0) {
      return res.status(400).json({
        error: GHOSTWRITER_NICHES_REQUIRED_MESSAGE,
        code: GHOSTWRITER_CONFIG_REQUIRED_CODE,
      });
    }

    // Block generation once the free trial has ended (subscribers/admins pass).
    if (!gate.allowed) {
      return res.status(403).json({ error: gate.reason, entitlement: gate.entitlement });
    }

    // Per-plan daily batch generation limit.
    try {
      await canStartBatchGeneration(req.userId!);
    } catch (err) {
      if (err instanceof PlanLimitError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      throw err;
    }

    let schedule: NormalizedPostingScheduleConfig;
    try {
      schedule = parseBatchPostingScheduleRequest(batchPostingSchedule);
    } catch (err) {
      if (err instanceof BatchScheduleError) {
        return res.status(400).json({ error: `Invalid posting schedule: ${err.message}` });
      }
      throw err;
    }

    const parsedDaysWindow = Number(daysWindow);
    let resolvedSlots: Date[];
    let owner: { regionId: string | null } | null;
    try {
      const [resolved, resolvedOwner] = await Promise.all([
        resolveBatchGenerationSlots({
          userId: req.userId!,
          postsPerWeek: parsedPostsPerWeek,
          daysWindow: parsedDaysWindow,
          startDate,
          schedule,
          allowPartialSchedule: allowPartialSchedule === true,
          selectedSlotKeys: Array.isArray(selectedSlotKeys)
            ? selectedSlotKeys.filter((key): key is string => typeof key === 'string')
            : undefined,
        }),
        prisma.user.findUnique({
          where: { id: req.userId! },
          select: { regionId: true },
        }),
      ]);
      resolvedSlots = resolved.slots;
      owner = resolvedOwner;
    } catch (err) {
      if (err instanceof BatchScheduleError) {
        return res.status(400).json({ error: `Invalid starting date: ${err.message}` });
      }
      if (err instanceof BatchScheduleCapacityError) {
        return res.status(400).json({
          error: err.message,
          code: err.code,
          requestedCount: err.requestedCount,
          availableCount: err.availableCount,
          daysWindow: err.daysWindow,
        });
      }
      throw err;
    }

    const job = await prisma.botGenerationJob.create({
      data: {
        userId: req.userId!,
        regionId: owner?.regionId ?? null,
        daysWindow: parsedDaysWindow,
        status: "RUNNING",
        heartbeatAt: new Date(),
        totalSlots: resolvedSlots.length,
        completedSlots: 0,
      },
    });
    const generationId = `gen_${job.id}`;

    // Batch schedule/frequency are request-scoped only — not persisted to BotConfig.
    const previewId = typeof req.body.previewId === 'string' ? req.body.previewId : undefined;

    void (async () => {
      const stopHeartbeat = startBatchGenerationHeartbeat(job.id);
      try {
        await withAiCostContext({
          userId: req.userId!,
          regionId: owner?.regionId,
          feature: 'BATCH_POST',
          operation: 'BATCH_PLAN',
          agent: 'PLANNER',
          generationId,
          batchJobId: job.id,
        }, () => botService.generateNow(req.userId!, job.id, {
          previewId,
          slots: resolvedSlots,
        }));
        await prisma.botGenerationJob.updateMany({
          where: { id: job.id, status: "RUNNING" },
          data: { status: "DONE", completedAt: new Date(), heartbeatAt: new Date() },
        });
      } catch (err: any) {
        try {
          await prisma.botGenerationJob.updateMany({
            where: { id: job.id, status: "RUNNING" },
            data: {
              status: "FAILED",
              completedAt: new Date(),
              heartbeatAt: new Date(),
              error: String(err?.message || err),
            },
          });
        } catch (statusError) {
          console.error('[batch-job] failed to persist terminal status', {
            jobId: job.id,
            statusError,
          });
        }
      } finally {
        stopHeartbeat();
      }
    })();

    res.json({ jobId: job.id, generationId, status: "RUNNING" });
  });
  
  // GET /bot/trends/preview - Preview top trends for current config
  router.get('/trends/preview', requireAuth, async (req, res) => {
      try {
          const requirements = await getSavedGhostwriterRequirements(req.userId!);
          if (!requirements.hasDescription) {
            return res.status(400).json({
              error: GHOSTWRITER_CONFIG_REQUIRED_MESSAGE,
              code: GHOSTWRITER_CONFIG_REQUIRED_CODE,
            });
          }
          if (requirements.niches.length === 0) {
            return res.status(400).json({
              error: GHOSTWRITER_NICHES_REQUIRED_MESSAGE,
              code: GHOSTWRITER_CONFIG_REQUIRED_CODE,
            });
          }
          const debug = req.query.debug === 'true' || req.query.debug === '1';
          const enriched = req.query.enriched === 'true' || req.query.enriched === '1';
          const result = await botService.previewTrends(req.userId!, { debug, enriched: debug || enriched });
          res.json(result);
      } catch (error) {
          console.error('Error fetching trend preview:', error);
          res.status(500).json({ error: 'Failed to fetch trend preview' });
      }
  });

  export default router;
