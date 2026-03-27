  import { Router } from 'express';
  import { requireAuth } from '../middleware/auth';
  import { TrendingBotService } from '../services/trendingBotService';
  import { prisma } from '../prismaClient';

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

    const job = await prisma.botGenerationJob.create({
      data: {
        userId: req.userId!,
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
