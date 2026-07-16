import { Router, Request } from "express";
import { prisma } from "../prismaClient";
import { requireAuth } from "../middleware/auth";
import { getEntitlement, publishedThisMonth } from "../services/entitlementService";
import { isLinkedInAccountUsable } from "../services/linkedinService";

type ThemePreference = "LIGHT" | "DARK";

function normalizeThemePreference(value: unknown): ThemePreference | null {
  if (typeof value !== "string") return null;

  const normalized = value.trim().toUpperCase();

  if (normalized === "LIGHT") return "LIGHT";
  if (normalized === "DARK") return "DARK";

  return null;
}

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
      themePreference: true,
      hasCompletedOnboardingTour: true,
      isBillingExempt: true,

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
    orderBy: { updatedAt: "desc" },
    select: {
      accessToken: true,
      expiresAt: true,
      profileName: true,
      profileEmail: true,
      profileImageUrl: true,
      linkedInMemberId: true,
    },
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
  const usedThisMonth =
    entitlement.status === "TRIAL" ? await publishedThisMonth(userId) : 0;

  res.json({
    id: user.id,
    email: user.email,
    username: user.username,
    role: user.role,
    isBillingExempt: user.isBillingExempt,
    effectiveAccess: {
      hasAccess: entitlement.hasAccess,
      unlimited: entitlement.unlimited,
      billingExempt: entitlement.billingExempt,
      accessSource: entitlement.accessSource,
    },
    themePreference: user.themePreference || "LIGHT",
    hasCompletedOnboardingTour: user.hasCompletedOnboardingTour,

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

    // Safe LinkedIn connection state and display identity. Never expose tokens.
    linkedinConnected: isLinkedInAccountUsable(linkedinAccount),
    linkedinAccount: linkedinAccount
      ? {
          name: linkedinAccount.profileName,
          email: linkedinAccount.profileEmail,
          avatarUrl: linkedinAccount.profileImageUrl,
          memberId: linkedinAccount.linkedInMemberId,
        }
      : null,

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
      usagePeriod: "MONTHLY",
      monthlyPublishLimit: entitlement.monthlyPublishLimit,
      publishedThisMonth: usedThisMonth,
    },
  });
});

router.post("/onboarding-tour/complete", requireAuth, async (req: Request, res: any) => {
  const userId = req.userId;

  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const updated = await prisma.user.update({
      where: { id: userId },
      data: { hasCompletedOnboardingTour: true },
      select: {
        id: true,
        hasCompletedOnboardingTour: true,
      },
    });

    return res.json({
      hasCompletedOnboardingTour: updated.hasCompletedOnboardingTour,
    });
  } catch (err) {
    console.error("Error completing onboarding tour:", err);
    return res.status(500).json({ error: "Failed to complete onboarding tour" });
  }
});

router.patch("/me/theme", requireAuth, async (req: Request, res: any) => {
  const userId = req.userId;

  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const themePreference = normalizeThemePreference(req.body?.themePreference);

  if (!themePreference) {
    return res.status(400).json({
      error: "Invalid theme preference. Use LIGHT or DARK.",
    });
  }

  try {
    const updated = await prisma.user.update({
      where: { id: userId },
      data: { themePreference },
      select: {
        id: true,
        email: true,
        username: true,
        themePreference: true,
      },
    });

    return res.json(updated);
  } catch (err) {
    console.error("Error updating theme preference:", err);
    return res.status(500).json({ error: "Failed to update theme preference" });
  }
});

// Alias for settings-style clients.
router.patch("/preferences", requireAuth, async (req: Request, res: any) => {
  const userId = req.userId;

  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const themePreference = normalizeThemePreference(req.body?.themePreference);

  if (!themePreference) {
    return res.status(400).json({
      error: "Invalid theme preference. Use LIGHT or DARK.",
    });
  }

  try {
    const updated = await prisma.user.update({
      where: { id: userId },
      data: { themePreference },
      select: {
        id: true,
        email: true,
        username: true,
        themePreference: true,
      },
    });

    return res.json(updated);
  } catch (err) {
    console.error("Error updating preferences:", err);
    return res.status(500).json({ error: "Failed to update preferences" });
  }
});

router.put("/config", requireAuth, async (_req: Request, res: any) => {
  return res.status(410).json({
    error:
      "API keys are now platform-managed. Configure Google in .env and LinkedIn in the regional admin credentials page.",
  });
});

export default router;
