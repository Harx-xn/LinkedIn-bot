import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import { config } from './config';
import authRouter from './routes/auth';
import linkedinRouter from './routes/linkedin';
import linkedinPagesRouter from './routes/linkedinPages';
import linkedinGrowthRoutes from './routes/linkedinGrowth';
import manualPostsRouter from './routes/manualPosts';
import sheetsRouter from './routes/sheets';
import postsRouter from './routes/posts';
import postCarouselsRouter from './routes/postCarousels';
import userRouter from './routes/user';
import botConfigRouter from './routes/botConfig';
import uploadRouter from './routes/upload';
import botActionRouter from './routes/botAction';
import adminRoutes from './routes/admin';
import costIntelligenceRoutes from './routes/costIntelligence';
import regionRoutes from './routes/region';
import subAdminRoutes from './routes/subadmin';
import analyticsRoutes from './routes/analytics';
import linkedinContentAnalyticsRoutes from './routes/linkedinContentAnalytics';
import publicRoutes from './routes/public';
import paymentsRouter from './routes/payments';
import billingRouter from './routes/billing';
import notificationsRouter from './routes/notifications';
import entitlementsRouter from './routes/entitlements';
import supportRouter from './routes/support';
import dashboardRouter from './routes/dashboard';
import onboardingRouter from './routes/onboarding';
import carouselsRouter from './routes/carousels';
import { handleStripeWebhook } from './routes/stripeWebhook';
import { handleSafepayWebhook } from './routes/safepayWebhook';
import path from 'path';
import { startScheduler } from './services/schedulerService';
import { reconcileStaleBatchGenerationJobs } from './services/batchGenerationJobLifecycleService';

const app = express();

const allowedOrigins = [
  "http://localhost:5173",
  // add your deployed frontend domain too:
  "https://frontend-bx09.onrender.com",
  "https://veyrais.innovariatech.space"
];

app.post(
  '/api/payments/webhook/stripe/:regionId',
  express.raw({ type: 'application/json' }),
  handleStripeWebhook
);
app.post(
  '/api/payments/webhook/safepay/:regionId',
  express.raw({ type: 'application/json' }),
  handleSafepayWebhook,
);
app.use(
  cors({
    origin: (origin, cb) => {
      // allow tools like curl/postman (no origin)
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true, // set true only if you use cookies/auth sessions
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);


app.use(express.json({ limit: '8mb' }));
// Lightweight request logger.
app.use((req, _res, next) => {
  console.log(`[REQ] ${req.method} ${req.path}`);
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/api/auth', authRouter);
app.use('/api/linkedin', linkedinRouter);
app.use('/api/linkedin', linkedinPagesRouter); // For /linkedin/pages
app.use('/api/linkedin-growth', linkedinGrowthRoutes);
app.use('/api/sheets', sheetsRouter);
app.use('/api/posts', postCarouselsRouter);
app.use('/api/posts', postsRouter);
app.use('/api/manual-posts', manualPostsRouter);
app.use('/api/user', userRouter);
app.use('/api/users', userRouter);
app.use('/api/bot', botConfigRouter);
app.use('/api/bot', botActionRouter); // Used for /bot/generate
app.use('/api/upload', uploadRouter);
app.use('/api/admin', adminRoutes);
app.use('/api/admin/cost-intelligence', costIntelligenceRoutes);
app.use('/api/regional-admin', regionRoutes);
app.use('/api/sub-admin', subAdminRoutes);
app.use('/api/analytics/linkedin', linkedinContentAnalyticsRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/payments', paymentsRouter);
app.use('/api/billing', billingRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/entitlements', entitlementsRouter);
app.use('/api/support', supportRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/onboarding', onboardingRouter);
app.use('/api/carousels', carouselsRouter);
// Backwards-compatible aliases (pre-/api mounts)
app.use('/admin', adminRoutes);
app.use('/admin/cost-intelligence', costIntelligenceRoutes);
app.use('/regional-admin', regionRoutes);

// Serve static files (uploaded images)
// app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));
app.use(express.static(path.join(process.cwd(), 'dist', 'public')));
app.use((req, res) => {
  console.log(`[404] ${req.method} ${req.path}`);
  res.status(404).json({ error: 'Not found' });
});

app.use((err: any, _req: any, res: any, _next: any) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(config.port, async () => {
  console.log(`Backend running on http://localhost:${config.port}`);
  try {
    const recovered = await reconcileStaleBatchGenerationJobs();
    if (recovered > 0) {
      console.warn('[batch-job] marked interrupted jobs as failed on startup', { recovered });
    }
  } catch (err) {
    console.error('[batch-job] startup reconciliation failed', err);
  }
  startScheduler();
});
