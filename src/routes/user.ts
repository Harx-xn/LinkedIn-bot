import { Router, Request } from "express";
import { prisma } from "../prismaClient";
import { requireAuth } from "../middleware/auth";
import { getEntitlement, publishedToday } from "../services/entitlementService";

const router = Router();
router.get("/me", requireAuth, async (req: Request, res: any) => {
  const userId = req.userId;

  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
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
          linkedinClientId: true,
          linkedinClientSecret: true,
        },
      },
    },
  });

  if (!user) return res.status(404).json({ error: "User not found" });

  const linkedinAccount = await prisma.linkedInAccount.findFirst({
    where: { userId },
    select: { id: true },
  });

  const activeSubscription = await prisma.subscription.findFirst({
    where: {
      userId,
      status: "ACTIVE",
    },
    orderBy: {
      createdAt: "desc",
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
  const usedToday =
    entitlement.status === "TRIAL" ? await publishedToday(userId) : 0;

  res.json({
    id: user.id,
    email: user.email,
    username: user.username,
    role: user.role,

    regionId: user.regionId,
    region: user.region
      ? {
          id: user.region.id,
          name: user.region.name,
          slug: user.region.slug,
          code: user.region.code,
        }
      : null,

    // platform-managed app credentials. Users connect accounts via OAuth;
    // they should not provide their own Google/LinkedIn developer keys.
    linkedinConfigured: !!(
      (user.region?.linkedinClientId && user.region?.linkedinClientSecret) ||
      (process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET)
    ),
    googleConfigured: !!(
      process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ),

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

router.put("/config", requireAuth, async (_req: Request, res: any) => {
  return res.status(410).json({
    error:
      "API keys are now platform-managed. Configure Google in .env and LinkedIn in the regional admin credentials page.",
  });
});

export default router;
