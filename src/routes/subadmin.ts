// Sub-admin (REGIONAL_ADMIN) API: manage the clients, AI/LinkedIn credentials,
// payment configuration, plans (fees) and subscriptions for a single region.
// A SUPER_ADMIN may also call these endpoints, but must pass an explicit
// `regionId` to choose which region to act on (see getRegion / resolveRegionId).
import { Router } from "express";
import { UserRole } from "@prisma/client";
import bcrypt from "bcryptjs";
import { prisma } from "../prismaClient";
import { authMiddleware } from "../middleware/authMiddleware";
import { requireRole } from "../middleware/requireRole";
import { resolveRegionId, maskSecret } from "../services/tenancyService";
import {
  encryptSecret,
  decryptSecret,
  encryptSecretArray,
  decryptSecretArray,
} from "../services/secretCrypto";
const router = Router();

// Every route requires a valid token AND a privileged role.
router.use(authMiddleware);
router.use(requireRole(UserRole.REGIONAL_ADMIN, UserRole.SUPER_ADMIN));

function isValidUsername(username: string) {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.]{2,19}$/.test(username);
}

// Region a request targets: a regional admin is locked to their own region,
// while a super admin selects one via `regionId` in the body or query.
function getRegion(req: any): string {
  return resolveRegionId(req.user!, req.body?.regionId ?? req.query?.regionId);
}

// ---------------------------------------------------------------------------
// Clients (end users belonging to the sub-admin's region)
// ---------------------------------------------------------------------------

router.get("/clients", async (req, res) => {
  try {
    const regionId = getRegion(req);
    const clients = await prisma.user.findMany({
      where: { regionId, role: UserRole.USER },
      select: {
        id: true,
        email: true,
        username: true,
        isActive: true,
        createdAt: true,
        subscriptions: {
          where: { status: "ACTIVE" },
          include: { plan: true },
        },
        _count: { select: { posts: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return res.json(clients);
  } catch (error: any) {
    return res.status(403).json({ message: error.message });
  }
});

router.post("/clients", async (req, res) => {
  try {
    const regionId = getRegion(req);
    const { email, username, password } = req.body as {
      email?: string;
      username?: string;
      password?: string;
    };

    if (!email || !username || !password) {
      return res
        .status(400)
        .json({ message: "Missing email, username, or password" });
    }
    if (!email.includes("@"))
      return res.status(400).json({ message: "Invalid email format" });
    if (password.length < 6) {
      return res
        .status(400)
        .json({ message: "Password must be at least 6 characters" });
    }
    if (!isValidUsername(username)) {
      return res.status(400).json({ message: "Invalid username" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const client = await prisma.user.create({
      data: { email, username, passwordHash, role: UserRole.USER, regionId },
      select: {
        id: true,
        email: true,
        username: true,
        isActive: true,
        createdAt: true,
      },
    });
    return res.status(201).json(client);
  } catch (error: any) {
    if (error?.code === "P2002") {
      const target = error?.meta?.target?.join?.(", ") || "field";
      return res.status(400).json({ message: `Duplicate ${target}` });
    }
    return res
      .status(400)
      .json({ message: error.message || "Failed to create client" });
  }
});

router.patch("/clients/:userId", async (req, res) => {
  try {
    const regionId = getRegion(req);
    const { userId } = req.params;
    const { isActive } = req.body as { isActive?: boolean };

    const target = await prisma.user.findUnique({
      where: { id: userId },
      select: { regionId: true },
    });
    if (!target || target.regionId !== regionId) {
      return res
        .status(404)
        .json({ message: "Client not found in your region" });
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: { isActive: typeof isActive === "boolean" ? isActive : undefined },
      select: { id: true, email: true, username: true, isActive: true },
    });
    return res.json(updated);
  } catch (error: any) {
    return res.status(400).json({ message: error.message });
  }
});

router.delete("/clients/:userId", async (req, res) => {
  try {
    const regionId = getRegion(req);
    const { userId } = req.params;

    const target = await prisma.user.findUnique({
      where: { id: userId },
      select: { regionId: true, role: true },
    });
    if (
      !target ||
      target.regionId !== regionId ||
      target.role !== UserRole.USER
    ) {
      return res
        .status(404)
        .json({ message: "Client not found in your region" });
    }

    await prisma.user.delete({ where: { id: userId } });
    return res.json({ ok: true });
  } catch (error: any) {
    return res.status(400).json({ message: error.message });
  }
});

// ---------------------------------------------------------------------------
// Region credentials: AI keys + LinkedIn app secrets
// ---------------------------------------------------------------------------

router.get("/credentials", async (req, res) => {
  try {
    const regionId = getRegion(req);
    const region = await prisma.region.findUnique({
      where: { id: regionId },
      select: {
        openaiApiKey: true,
        geminiApiKeys: true,
        linkedinClientId: true,
        linkedinClientSecret: true,
        linkedinRedirectUri: true,
        linkedinApiVersion: true,
      },
    });
    if (!region) return res.status(404).json({ message: "Region not found" });

    const openaiApiKey = decryptSecret(region.openaiApiKey);
    const geminiKeys = decryptSecretArray(region.geminiApiKeys);
    const linkedinClientSecret = decryptSecret(region.linkedinClientSecret);

    return res.json({
      openai: {
        configured: !!openaiApiKey,
        masked: maskSecret(openaiApiKey),
      },
      gemini: {
        count: geminiKeys.length,
        masked: geminiKeys.map(maskSecret),
      },
      linkedin: {
        clientId: region.linkedinClientId || "",
        clientSecretConfigured: !!linkedinClientSecret,
        clientSecretMasked: maskSecret(linkedinClientSecret),
        redirectUri: region.linkedinRedirectUri || "",
        apiVersion: region.linkedinApiVersion || "202511",
      },
    });
  } catch (error: any) {
    return res.status(403).json({ message: error.message });
  }
});

router.put("/credentials", async (req, res) => {
  try {
    const regionId = getRegion(req);
    const {
      openaiApiKey,
      geminiApiKeys,
      linkedinClientId,
      linkedinClientSecret,
      linkedinRedirectUri,
      linkedinApiVersion,
    } = req.body as {
      openaiApiKey?: string;
      geminiApiKeys?: string[] | string;
      linkedinClientId?: string;
      linkedinClientSecret?: string;
      linkedinRedirectUri?: string;
      linkedinApiVersion?: string;
    };

    const data: any = {};
    if (openaiApiKey !== undefined) {
      data.openaiApiKey = encryptSecret(openaiApiKey || null);
    }
    if (geminiApiKeys !== undefined) {
      const arr = Array.isArray(geminiApiKeys)
        ? geminiApiKeys.filter(Boolean)
        : typeof geminiApiKeys === "string" && geminiApiKeys.trim()
          ? [geminiApiKeys.trim()]
          : [];
      data.geminiApiKeys = encryptSecretArray(arr);
    }
    if (linkedinClientId !== undefined)
      data.linkedinClientId = linkedinClientId || null;
    if (linkedinClientSecret !== undefined) {
      data.linkedinClientSecret = encryptSecret(linkedinClientSecret || null);
    }
    if (linkedinRedirectUri !== undefined)
      data.linkedinRedirectUri = linkedinRedirectUri || null;
    if (linkedinApiVersion !== undefined) {
      data.linkedinApiVersion = linkedinApiVersion || "202511";
    }

    await prisma.region.update({ where: { id: regionId }, data });
    return res.json({ ok: true });
  } catch (error: any) {
    return res.status(400).json({ message: error.message });
  }
});

// ---------------------------------------------------------------------------
// Payment configuration (Stripe / PayPal / manual)
// ---------------------------------------------------------------------------

router.get("/payment-config", async (req, res) => {
  try {
    const regionId = getRegion(req);
    const cfg = await prisma.paymentConfig.findUnique({ where: { regionId } });

    if (!cfg) {
      return res.json({
        provider: "MANUAL",
        isActive: true,
        configured: false,
      });
    }

    const stripeSecretKey = decryptSecret(cfg.stripeSecretKey);
    const stripeWebhookSecret = decryptSecret(cfg.stripeWebhookSecret);
    const paypalClientSecret = decryptSecret(cfg.paypalClientSecret);

    return res.json({
      provider: cfg.provider,
      isActive: cfg.isActive,
      configured: true,
      stripe: {
        publishableKey: cfg.stripePublishableKey || '',
        secretConfigured: !!stripeSecretKey,
        secretMasked: maskSecret(stripeSecretKey),
        webhookConfigured: !!stripeWebhookSecret,
      },
      paypal: {
        clientId: cfg.paypalClientId || '',
        secretConfigured: !!paypalClientSecret,
        secretMasked: maskSecret(paypalClientSecret),
        mode: cfg.paypalMode || 'sandbox',
      },
    });
  } catch (error: any) {
    return res.status(403).json({ message: error.message });
  }
});

router.put("/payment-config", async (req, res) => {
  try {
    const regionId = getRegion(req);
    const {
      provider,
      isActive,
      stripePublishableKey,
      stripeSecretKey,
      stripeWebhookSecret,
      paypalClientId,
      paypalClientSecret,
      paypalMode,
    } = req.body as Record<string, any>;

    const allowed = ["STRIPE", "PAYPAL", "MANUAL"];
    if (provider !== undefined && !allowed.includes(provider)) {
      return res.status(400).json({ message: "Invalid provider" });
    }

    const writable: any = {};
    if (provider !== undefined) writable.provider = provider;
    if (typeof isActive === "boolean") writable.isActive = isActive;
    if (stripePublishableKey !== undefined)
      writable.stripePublishableKey = stripePublishableKey || null;
    if (stripeSecretKey !== undefined) {
      writable.stripeSecretKey = encryptSecret(stripeSecretKey || null);
    }

    if (stripeWebhookSecret !== undefined) {
      writable.stripeWebhookSecret = encryptSecret(stripeWebhookSecret || null);
    }

    if (paypalClientSecret !== undefined) {
      writable.paypalClientSecret = encryptSecret(paypalClientSecret || null);
    }
    if (paypalMode !== undefined) writable.paypalMode = paypalMode || "sandbox";

    const cfg = await prisma.paymentConfig.upsert({
      where: { regionId },
      create: { regionId, ...writable },
      update: writable,
    });

    return res.json({
      ok: true,
      provider: cfg.provider,
      isActive: cfg.isActive,
    });
  } catch (error: any) {
    return res.status(400).json({ message: error.message });
  }
});

// ---------------------------------------------------------------------------
// Plans (subscription fees)
// ---------------------------------------------------------------------------

router.get("/plans", async (req, res) => {
  try {
    const regionId = getRegion(req);
    const plans = await prisma.plan.findMany({
      where: { regionId },
      include: { _count: { select: { subscriptions: true } } },
      orderBy: { createdAt: "desc" },
    });
    return res.json(plans);
  } catch (error: any) {
    return res.status(403).json({ message: error.message });
  }
});

router.post("/plans", async (req, res) => {
  try {
    const regionId = getRegion(req);
    const { name, code, price, currency, billingCycle } = req.body as {
      name?: string;
      code?: string;
      price?: number;
      currency?: string;
      billingCycle?: string;
    };

    if (!name || !code || price === undefined) {
      return res.status(400).json({ message: "Missing name, code, or price" });
    }

    const plan = await prisma.plan.create({
      data: {
        name,
        code,
        price: Number(price),
        currency: currency || "USD",
        billingCycle: billingCycle || "monthly",
        regionId,
      },
    });
    return res.status(201).json(plan);
  } catch (error: any) {
    if (error?.code === "P2002") {
      return res
        .status(400)
        .json({
          message: "A plan with this code already exists in your region",
        });
    }
    return res.status(400).json({ message: error.message });
  }
});

router.patch("/plans/:planId", async (req, res) => {
  try {
    const regionId = getRegion(req);
    const { planId } = req.params;

    const existing = await prisma.plan.findUnique({ where: { id: planId } });
    if (!existing || existing.regionId !== regionId) {
      return res.status(404).json({ message: "Plan not found in your region" });
    }

    const { name, price, currency, billingCycle, isActive } =
      req.body as Record<string, any>;
    const data: any = {};
    if (name !== undefined) data.name = name;
    if (price !== undefined) data.price = Number(price);
    if (currency !== undefined) data.currency = currency;
    if (billingCycle !== undefined) data.billingCycle = billingCycle;
    if (typeof isActive === "boolean") data.isActive = isActive;

    const plan = await prisma.plan.update({ where: { id: planId }, data });
    return res.json(plan);
  } catch (error: any) {
    return res.status(400).json({ message: error.message });
  }
});

router.delete("/plans/:planId", async (req, res) => {
  try {
    const regionId = getRegion(req);
    const { planId } = req.params;

    const existing = await prisma.plan.findUnique({
      where: { id: planId },
      include: { _count: { select: { subscriptions: true } } },
    });
    if (!existing || existing.regionId !== regionId) {
      return res.status(404).json({ message: "Plan not found in your region" });
    }

    // Soft-deactivate if it has subscriptions (FK is Restrict), else delete
    if (existing._count.subscriptions > 0) {
      await prisma.plan.update({
        where: { id: planId },
        data: { isActive: false },
      });
      return res.json({ ok: true, deactivated: true });
    }

    await prisma.plan.delete({ where: { id: planId } });
    return res.json({ ok: true, deleted: true });
  } catch (error: any) {
    return res.status(400).json({ message: error.message });
  }
});

// ---------------------------------------------------------------------------
// Subscriptions (assign plans to clients)
// ---------------------------------------------------------------------------

router.get("/subscriptions", async (req, res) => {
  try {
    const regionId = getRegion(req);
    const subs = await prisma.subscription.findMany({
      where: { regionId },
      include: {
        plan: true,
        user: { select: { id: true, email: true, username: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return res.json(subs);
  } catch (error: any) {
    return res.status(403).json({ message: error.message });
  }
});

router.post("/subscriptions", async (req, res) => {
  try {
    const regionId = getRegion(req);
    const { userId, planId, endsAt, autoRenew } = req.body as {
      userId?: string;
      planId?: string;
      endsAt?: string;
      autoRenew?: boolean;
    };

    if (!userId || !planId) {
      return res.status(400).json({ message: "Missing userId or planId" });
    }

    const [client, plan] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { regionId: true },
      }),
      prisma.plan.findUnique({
        where: { id: planId },
        select: { regionId: true },
      }),
    ]);

    if (!client || client.regionId !== regionId) {
      return res
        .status(404)
        .json({ message: "Client not found in your region" });
    }
    if (!plan || plan.regionId !== regionId) {
      return res.status(404).json({ message: "Plan not found in your region" });
    }

    const sub = await prisma.subscription.create({
      data: {
        userId,
        planId,
        regionId,
        endsAt: endsAt ? new Date(endsAt) : null,
        autoRenew: autoRenew ?? true,
      },
      include: {
        plan: true,
        user: { select: { id: true, email: true, username: true } },
      },
    });
    return res.status(201).json(sub);
  } catch (error: any) {
    return res.status(400).json({ message: error.message });
  }
});

router.patch("/subscriptions/:id", async (req, res) => {
  try {
    const regionId = getRegion(req);
    const { id } = req.params;
    const { status, autoRenew, endsAt } = req.body as {
      status?: string;
      autoRenew?: boolean;
      endsAt?: string;
    };

    const existing = await prisma.subscription.findUnique({
      where: { id },
      select: { regionId: true },
    });
    if (!existing || existing.regionId !== regionId) {
      return res
        .status(404)
        .json({ message: "Subscription not found in your region" });
    }

    const data: any = {};
    if (status !== undefined) data.status = status;
    if (typeof autoRenew === "boolean") data.autoRenew = autoRenew;
    if (endsAt !== undefined) data.endsAt = endsAt ? new Date(endsAt) : null;

    const sub = await prisma.subscription.update({
      where: { id },
      data,
      include: {
        plan: true,
        user: { select: { id: true, email: true, username: true } },
      },
    });
    return res.json(sub);
  } catch (error: any) {
    return res.status(400).json({ message: error.message });
  }
});

export default router;
