import { Router, Request } from 'express';
import { prisma } from '../prismaClient';
import { requireAuth } from '../middleware/auth';
import { getEntitlement, publishedToday } from '../services/entitlementService';
import { encryptSecret } from '../services/secretCrypto';

const router = Router();
router.get('/me', requireAuth, async (req: Request, res: any) => {
  const userId = req.userId;

  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      username: true,
      role: true,

      regionId: true,
      region: {
        select: {
          id: true,
          name: true,
          slug: true,
          code: true,
        },
      },

      linkedinClientId: true,
      linkedinClientSecret: true,
      googleClientId: true,
      googleClientSecret: true,
    },
  });

  if (!user) return res.status(404).json({ error: 'User not found' });

  const linkedinAccount = await prisma.linkedInAccount.findFirst({
    where: { userId },
    select: { id: true },
  });

  const activeSubscription = await prisma.subscription.findFirst({
    where: {
      userId,
      status: 'ACTIVE',
    },
    orderBy: {
      createdAt: 'desc',
    },
    select: {
      id: true,
      status: true,
      startsAt: true,
      endsAt: true,
      autoRenew: true,
      plan: {
        select: {
          id: true,
          name: true,
          code: true,
          price: true,
          currency: true,
          billingCycle: true,
        },
      },
    },
  });

  // Trial / subscription entitlement so the UI can show a banner and limits.
  const entitlement = await getEntitlement(userId);
  const usedToday = entitlement.status === 'TRIAL' ? await publishedToday(userId) : 0;

  res.json({
    id: user.id,
    email: user.email,
    username: user.username,
    role: user.role,

    regionId: user.regionId,
    region: user.region,

    // configuration keys saved
    linkedinConfigured: !!(user.linkedinClientId && user.linkedinClientSecret),
    googleConfigured: !!(user.googleClientId && user.googleClientSecret),

    // connection token exists
    linkedinConnected: !!linkedinAccount,

    subscription: activeSubscription
      ? {
          id: activeSubscription.id,
          status: activeSubscription.status,
          startsAt: activeSubscription.startsAt,
          endsAt: activeSubscription.endsAt,
          autoRenew: activeSubscription.autoRenew,
          plan: activeSubscription.plan,
        }
      : null,

    trial: {
      status: entitlement.status, // ADMIN | SUBSCRIBED | TRIAL | EXPIRED
      trialEndsAt: entitlement.trialEndsAt,
      daysLeft: entitlement.daysLeft,
      dailyPublishLimit: entitlement.dailyPublishLimit,
      publishedToday: usedToday,
    },
  });
});

router.put('/config', requireAuth, async (req: Request, res: any) => {
    const { linkedinClientId, linkedinClientSecret, googleClientId, googleClientSecret } = req.body;

    const updateData: any = {};
    if (linkedinClientId && linkedinClientSecret) {
        updateData.linkedinClientId = linkedinClientId;
        updateData.linkedinClientSecret = encryptSecret(linkedinClientSecret);
    }
    if (googleClientId && googleClientSecret) {
        updateData.googleClientId = googleClientId;
        updateData.googleClientSecret = encryptSecret(googleClientSecret);
    }

    if (Object.keys(updateData).length === 0) {
        return res.status(400).json({ error: 'No configuration provided' });
    }

    await prisma.user.update({
        where: { id: req.userId },
        data: updateData
    });

    res.json({ success: true });
});

export default router;
