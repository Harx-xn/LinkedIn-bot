import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import { config } from './config';
import authRouter from './routes/auth';
import linkedinRouter from './routes/linkedin';
import linkedinPagesRouter from './routes/linkedinPages';
import sheetsRouter from './routes/sheets';
import postsRouter from './routes/posts';
import userRouter from './routes/user';
import botConfigRouter from './routes/botConfig';
import uploadRouter from './routes/upload';
import botActionRouter from './routes/botAction';
import path from 'path';
import { startScheduler } from './services/schedulerService';

const app = express();
app.use(cors());
app.use(express.json());
app.use((req, _res, next) => {
  console.log(`[REQ] ${req.method} ${req.path}`);
  next();
});
console.log("check")
app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/api/auth', authRouter);
app.use('/api/linkedin', linkedinRouter);
app.use('/api/linkedin', linkedinPagesRouter); // For /linkedin/pages
app.use('/api/sheets', sheetsRouter);
app.use('/api/posts', postsRouter);
app.use('/api/user', userRouter);
app.use('/api/bot', botConfigRouter);
app.use('/api/bot', botActionRouter); // Used for /bot/generate
app.use('/api/upload', uploadRouter);

// Serve static files (uploaded images)
app.use('/uploads', express.static(path.join(process.cwd(), 'dist', 'public', 'uploads')));
app.use(express.static(path.join(process.cwd(), 'dist', 'public')));
app.use((req, res) => {
  console.log(`[404] ${req.method} ${req.path}`);
  res.status(404).json({ error: 'Not found' });
});

app.use((err: any, _req: any, res: any, _next: any) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(config.port, () => {
  console.log(`Backend running on http://localhost:${config.port}`);
  startScheduler();
});
