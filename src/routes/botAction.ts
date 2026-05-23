  import { Router } from 'express';
  import { requireAuth } from '../middleware/auth';
  import { TrendingBotService } from '../services/trendingBotService';
  import { prisma } from '../prismaClient';
  import { canGenerate } from '../services/entitlementService';

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
    const { daysWindow } = req.body;
    if (!daysWindow) return res.status(400).json({ error: "Missing daysWindow" });

    // Block generation once the free trial has ended (subscribers/admins pass).
    const gate = await canGenerate(req.userId!);
    if (!gate.allowed) {
      return res.status(403).json({ error: gate.reason, entitlement: gate.entitlement });
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
        daysWindow: Number(daysWindow),
        status: "RUNNING",
      },
    });

    botService
      .generateNow(req.userId!, Number(daysWindow), job.id)
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
          const trends = await botService.previewTrends(req.userId!);
          res.json(trends);
      } catch (error) {
          console.error('Error fetching trend preview:', error);
          res.status(500).json({ error: 'Failed to fetch trend preview' });
      }
  });

  export default router;
