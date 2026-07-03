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

  export type BotGenerateRequestBody = {
    daysWindow: number;
    postsPerWeek: number;
    startDate: string;
    batchPostingSchedule: unknown;
    allowPartialSchedule?: boolean;
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
    const job = await prisma.botGenerationJob.findFirst({
      where: { id: req.params.jobId, userId: req.userId! },
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

    const ghostwriterRequirements = await getSavedGhostwriterRequirements(
      req.userId!,
    );
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
    const gate = await canGenerate(req.userId!);
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
    try {
      const resolved = await resolveBatchGenerationSlots({
        userId: req.userId!,
        postsPerWeek: parsedPostsPerWeek,
        daysWindow: parsedDaysWindow,
        startDate,
        schedule,
        allowPartialSchedule: allowPartialSchedule === true,
      });
      resolvedSlots = resolved.slots;
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

    // Attach the region so generation jobs show up in region-scoped analytics.
    const owner = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: { regionId: true },
    });

    const job = await prisma.botGenerationJob.create({
      data: {
        userId: req.userId!,
        regionId: owner?.regionId ?? null,
        daysWindow: parsedDaysWindow,
        status: "RUNNING",
        totalSlots: resolvedSlots.length,
        completedSlots: 0,
      },
    });

    // Batch schedule/frequency are request-scoped only — not persisted to BotConfig.
    const previewId = typeof req.body.previewId === 'string' ? req.body.previewId : undefined;

    botService
      .generateNow(req.userId!, job.id, {
        previewId,
        slots: resolvedSlots,
      })
      .then(async () => {
        await prisma.botGenerationJob.update({
          where: { id: job.id },
          data: { status: "DONE", completedAt: new Date() },
        });
      })
      .catch(async (err: any) => {
        await prisma.botGenerationJob.update({
          where: { id: job.id },
          data: { status: "FAILED", completedAt: new Date(), error: String(err?.message || err) },
        });
      });

    res.json({ jobId: job.id, status: "RUNNING" });
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
