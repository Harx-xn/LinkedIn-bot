import { Router } from 'express';
import crypto from 'crypto';
import { getGoogleAuthUrl, exchangeGoogleCode } from '../services/sheetsService';
import { requireAuth } from '../middleware/auth';
import { prisma } from '../prismaClient';

const router = Router();

router.get('/connect', requireAuth, async (req: any, res: any) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user || !user.googleClientId || !user.googleClientSecret) {
    return res.status(400).json({ error: 'Please configure Google Client ID and Secret in settings first.' });
  }

  const state = crypto.randomBytes(16).toString('hex');
  const url = getGoogleAuthUrl(user.googleClientId, user.googleClientSecret, state);
  res.json({ url, state });
});

router.get('/callback', requireAuth, async (req: any, res: any) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code');

  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user || !user.googleClientId || !user.googleClientSecret) {
    return res.status(400).json({ error: 'User credentials not configured' });
  }

  const tokens = await exchangeGoogleCode(user.googleClientId, user.googleClientSecret, String(code));
  res.json({ tokens, note: 'Store tokens tied to user and allow them to configure spreadsheetId / range.' });
});

router.post('/config', requireAuth, async (req: any, res: any) => {
  const { spreadsheetId, range, accessToken, refreshToken } = req.body;
  if (!spreadsheetId || !range) return res.status(400).json({ error: 'Missing spreadsheetId or range' });

  const configRow = await prisma.sheetConfig.create({
    data: {
      userId: req.userId!,
      spreadsheetId,
      range,
      accessToken,
      refreshToken
    }
  });

  res.json(configRow);
});

export default router;
