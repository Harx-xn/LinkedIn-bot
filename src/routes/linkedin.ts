import { Router, Request } from 'express';
import crypto from 'crypto';
import { prisma } from '../prismaClient'; 
import {
  getLinkedInAuthUrl,
  exchangeCodeForToken,
  saveLinkedInAccountForUser
} from '../services/linkedinService';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.get('/connect', requireAuth, async (req, res: any) => {
  console.log("meow")
  const clientId = process.env.LINKEDIN_CLIENT_ID;

  if (!clientId) {
    return res.status(500).json({
      error: 'LINKEDIN_CLIENT_ID is not set in environment variables.'
    });
  }

  // Pass userId in state so we can retrieve it in callback
  const statePayload = JSON.stringify({
    userId: req.userId,
    nonce: crypto.randomBytes(8).toString('hex')
  });
  const state = Buffer.from(statePayload).toString('base64');

  const url = getLinkedInAuthUrl(clientId, state);
  res.json({ url, state });
});

router.get('/callback', async (req, res: any) => {
  const { code, state } = req.query as { code?: string; state?: string };
  if (!code || !state) return res.status(400).send('Missing code or state');

  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return res.status(500).send(
      'LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET are not set in environment variables.'
    );
  }

  try {
    const decodedState = JSON.parse(Buffer.from(state, 'base64').toString('utf-8'));
    const userId = decodedState.userId;

    if (!userId) return res.status(400).send('Invalid state');

    const { accessToken, expiresIn } = await exchangeCodeForToken(
      clientId,
      clientSecret,
      code
    );

    await saveLinkedInAccountForUser(userId, accessToken, expiresIn);

   res.setHeader('Content-Type', 'text/html');
res.send(`
<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>LinkedIn Connected</title></head>
  <body>
    <p>LinkedIn account connected. You can close this window.</p>
    <script>
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage({ type: 'LINKEDIN_CONNECTED' }, '*');
        }
      } catch (e) {}
      window.close();
    </script>
  </body>
</html>
`);
  } catch (err) {
    console.error('LinkedIn callback error:', err);
    res.status(500).send('Failed to connect LinkedIn account');
  }
});

router.post('/disconnect', requireAuth, async (req, res: any) => {
  try {
    const userId = req.userId;

    // Find all linkedInAccount ids for the user (supports 1 or many)
    const accounts = await prisma.linkedInAccount.findMany({
      where: { userId },
      select: { id: true }
    });

    const accountIds = accounts.map(a => a.id);

    await prisma.$transaction([
      // ✅ IMPORTANT: detach posts first so FK constraints don't block deletion
      prisma.post.updateMany({
        where: { linkedinAccountId: { in: accountIds } },
        data: {
          linkedinAccountId: null,
          // optional: also clear publishing info if you want
          // linkedinPostUrn: null,
          // status: 'DRAFT'
        }
      }),

      // ✅ delete the linkedin accounts for that user
      prisma.linkedInAccount.deleteMany({
        where: { userId }
      })
    ]);

    return res.json({ ok: true });
  } catch (err) {
    console.error('LinkedIn disconnect error:', err);
    return res.status(500).json({ error: 'Failed to disconnect LinkedIn account' });
  }
});

export default router;