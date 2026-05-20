import { Router } from 'express';
import crypto from 'crypto';
import {
  getGoogleAuthUrl,
  exchangeGoogleCode,
  readGoogleSheetAsJson,
createLinkedInPostsSheet
} from '../services/sheetsService';
import { requireAuth } from '../middleware/auth';
import { prisma } from '../prismaClient';

const router = Router();

function getReqUserId(req: any) {
  return req.userId || req.user?.id;
}

function getGoogleCredentials() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set in environment variables.');
  }

  return { clientId, clientSecret };
}

router.get('/connect', requireAuth, async (req: any, res: any) => {
  try {
    const userId = getReqUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { clientId, clientSecret } = getGoogleCredentials();

    const statePayload = JSON.stringify({
      userId,
      nonce: crypto.randomBytes(8).toString('hex')
    });

    const state = Buffer.from(statePayload).toString('base64');

    const url = getGoogleAuthUrl(clientId, clientSecret, state);

    return res.json({ url, state });
  } catch (err: any) {
    console.error('Google Sheets connect error:', err);

    return res.status(500).json({
      error: err?.message || 'Failed to start Google Sheets connection'
    });
  }
});

router.get('/callback', async (req: any, res: any) => {
  const { code, state } = req.query;

  if (!code || !state) {
    return res.status(400).send('Missing code or state');
  }

  try {
    const { clientId, clientSecret } = getGoogleCredentials();

    const decodedState = JSON.parse(
      Buffer.from(String(state), 'base64').toString('utf-8')
    );

    const userId = decodedState.userId;

    if (!userId) {
      return res.status(400).send('Invalid state');
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        regionId: true
      }
    });

    if (!user) {
      return res.status(404).send('User not found');
    }

    const tokens = await exchangeGoogleCode(
      clientId,
      clientSecret,
      String(code)
    );

    await prisma.sheetConfig.upsert({
      where: { userId },
      update: {
        accessToken: tokens.access_token || undefined,
        refreshToken: tokens.refresh_token || undefined,
        active: true
      },
      create: {
        userId,
        regionId: user.regionId,
        spreadsheetId: '',
        range: '',
        accessToken: tokens.access_token || null,
        refreshToken: tokens.refresh_token || null,
        active: true
      }
    });

    res.setHeader('Content-Type', 'text/html');

    return res.send(`
<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Google Sheets Connected</title></head>
  <body>
    <p>Google Sheets connected. You can close this window.</p>
    <script>
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage({ type: 'GOOGLE_SHEETS_CONNECTED' }, '*');
        }
      } catch (e) {}
      window.close();
    </script>
  </body>
</html>
`);
  } catch (err: any) {
    console.error('Google Sheets callback error:', err);
    return res.status(500).send(err?.message || 'Failed to connect Google Sheets');
  }
});

router.post('/config', requireAuth, async (req: any, res: any) => {
  try {
    const userId = getReqUserId(req);
    const { spreadsheetId, range } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!spreadsheetId || !range) {
      return res.status(400).json({
        error: 'Missing spreadsheetId or range'
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        regionId: true
      }
    });

    const configRow = await prisma.sheetConfig.upsert({
      where: { userId },
      update: {
        spreadsheetId,
        range,
        regionId: user?.regionId || undefined,
        active: true
      },
      create: {
        userId,
        regionId: user?.regionId || null,
        spreadsheetId,
        range,
        active: true
      }
    });

    return res.json(configRow);
  } catch (err) {
    console.error('Google Sheets config error:', err);

    return res.status(500).json({
      error: 'Failed to save Google Sheets config'
    });
  }
});

router.get('/config', requireAuth, async (req: any, res: any) => {
  try {
    const userId = getReqUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const configRow = await prisma.sheetConfig.findUnique({
      where: { userId },
      select: {
        id: true,
        spreadsheetId: true,
        range: true,
        accessToken: true,
        refreshToken: true,
        active: true,
        createdAt: true,
        updatedAt: true
      }
    });

    return res.json({
      config: configRow
        ? {
            id: configRow.id,
            spreadsheetId: configRow.spreadsheetId,
            range: configRow.range,
            active: configRow.active,
            connected: Boolean(configRow.accessToken || configRow.refreshToken),
            createdAt: configRow.createdAt,
            updatedAt: configRow.updatedAt
          }
        : null
    });
  } catch (err) {
    console.error('Google Sheets get config error:', err);

    return res.status(500).json({
      error: 'Failed to get Google Sheets config'
    });
  }
});

router.get('/data', requireAuth, async (req: any, res: any) => {
  try {
    const userId = getReqUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { clientId, clientSecret } = getGoogleCredentials();

    const sheetConfig = await prisma.sheetConfig.findUnique({
      where: { userId }
    });

    if (!sheetConfig) {
      return res.status(400).json({
        error: 'Google Sheets config not found.'
      });
    }

    if (!sheetConfig.spreadsheetId || !sheetConfig.range) {
      return res.status(400).json({
        error: 'Spreadsheet ID and range are not configured.'
      });
    }

    if (!sheetConfig.accessToken && !sheetConfig.refreshToken) {
      return res.status(400).json({
        error: 'Google Sheets account is not connected.'
      });
    }

    const data = await readGoogleSheetAsJson({
      clientId,
      clientSecret,
      accessToken: sheetConfig.accessToken,
      refreshToken: sheetConfig.refreshToken,
      spreadsheetId: sheetConfig.spreadsheetId,
      range: sheetConfig.range
    });

    return res.json({ data });
  } catch (err: any) {
    console.error('Read Google Sheet error:', err);

    return res.status(500).json({
      error: err?.message || 'Failed to read Google Sheet'
    });
  }
});

router.post('/disconnect', requireAuth, async (req: any, res: any) => {
  try {
    const userId = getReqUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    await prisma.sheetConfig.updateMany({
      where: { userId },
      data: {
        accessToken: null,
        refreshToken: null,
        active: false
      }
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error('Google Sheets disconnect error:', err);

    return res.status(500).json({
      error: 'Failed to disconnect Google Sheets'
    });
  }
});

router.post('/create-template', requireAuth, async (req: any, res: any) => {
  try {
    const userId = getReqUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { clientId, clientSecret } = getGoogleCredentials();

    const sheetConfig = await prisma.sheetConfig.findUnique({
      where: { userId }
    });

    if (!sheetConfig || (!sheetConfig.accessToken && !sheetConfig.refreshToken)) {
      return res.status(400).json({
        error: 'Google Sheets account is not connected.'
      });
    }

    const createdSheet = await createLinkedInPostsSheet({
      clientId,
      clientSecret,
      accessToken: sheetConfig.accessToken,
      refreshToken: sheetConfig.refreshToken
    });

    const updatedConfig = await prisma.sheetConfig.update({
      where: { userId },
      data: {
        spreadsheetId: createdSheet.spreadsheetId,
        range: createdSheet.range,
        active: true
      }
    });

    return res.json({
      ok: true,
      sheet: createdSheet,
      config: updatedConfig
    });
  } catch (err: any) {
    console.error('Create Google Sheet template error:', err);

    return res.status(500).json({
      error: err?.message || 'Failed to create Google Sheet template'
    });
  }
});

export default router;