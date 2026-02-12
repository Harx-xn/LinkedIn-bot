import { Router, Request } from 'express';
import crypto from 'crypto';
import { getLinkedInAuthUrl, exchangeCodeForToken, saveLinkedInAccountForUser } from '../services/linkedinService';
import { requireAuth } from '../middleware/auth';
import { prisma } from '../prismaClient';

const router = Router();

router.get('/connect', requireAuth, async (req: Request, res: any) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user || !user.linkedinClientId) {
    return res.status(400).json({ error: 'Please configure LinkedIn Client ID in settings first.' });
  }

  // Pass userId in state so we can retrieve it in callback
  const statePayload = JSON.stringify({ userId: req.userId, nonce: crypto.randomBytes(8).toString('hex') });
  const state = Buffer.from(statePayload).toString('base64');

  const url = getLinkedInAuthUrl(user.linkedinClientId, state);
  res.json({ url, state });
});

// NOTE: In production, you'd decode state to find userId.
// For this skeleton, we accept userId as query param.
router.get('/callback', async (req, res: any) => {
  const { code, state } = req.query as { code?: string; state?: string };
  if (!code || !state) return res.status(400).send('Missing code or state');

  try {
    const decodedState = JSON.parse(Buffer.from(state, 'base64').toString('utf-8'));
    const userId = decodedState.userId;

    if (!userId) return res.status(400).send('Invalid state');

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.linkedinClientId || !user.linkedinClientSecret) {
      return res.status(400).send('User credentials not configured');
    }

    const { accessToken, expiresIn } = await exchangeCodeForToken(user.linkedinClientId, user.linkedinClientSecret, code);
    await saveLinkedInAccountForUser(userId, accessToken, expiresIn);

    res.send('LinkedIn account connected. You can close this window.');
  } catch (err) {
    console.error('LinkedIn callback error:', err);
    res.status(500).send('Failed to connect LinkedIn account');
  }
});

export default router;
