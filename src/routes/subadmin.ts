// Sub-admin (REGIONAL_ADMIN) API: manage the clients, AI/LinkedIn credentials,
// payment configuration, plans (fees) and subscriptions for a single region.
// A SUPER_ADMIN may also call these endpoints, but must pass an explicit
// `regionId` to choose which region to act on (see getRegion / resolveRegionId).
import { Router } from "express";
import { Prisma, SupportRequestStatus, UserRole } from "@prisma/client";
import bcrypt from "bcryptjs";
import { prisma } from "../prismaClient";
import { authMiddleware } from "../middleware/authMiddleware";
import { requireRole } from "../middleware/requireRole";
import { resolveRegionId, maskSecret } from "../services/tenancyService";
import { generateInviteCode } from "../services/inviteService";
import {
  encryptSecret,
  decryptSecret,
  encryptSecretArray,
  decryptSecretArray,
} from "../services/secretCrypto";
import {
  SubscriptionAdminError,
  updateAdminSubscription,
} from "../services/subscriptionAdminService";
import { isValidUsername } from "../services/auth/authHelpers";

const router = Router();

// Every route requires a valid token AND a privileged role.
router.use(authMiddleware);
router.use(requireRole(UserRole.REGIONAL_ADMIN, UserRole.SUPER_ADMIN));

// Region a request targets: a regional admin is locked to their own region,
// while a super admin selects one via `regionId` in the body or query.
function getRegion(req: any): string {
  return resolveRegionId(req.user!, req.body?.regionId ?? req.query?.regionId);
}

type SettingKind = "boolean" | "integer" | "string";

type SettingRule = {
  kind: SettingKind;
  min?: number;
  max?: number;
  pattern?: RegExp;
};

const ALLOWED_PLATFORM_SETTINGS: Record<string, SettingRule> = {
  "auth.inviteOnly": { kind: "boolean" },
  "billing.promoCodesEnabled": { kind: "boolean" },
  "trial.days": { kind: "integer", min: 0, max: 365 },
  "trial.dailyPublishLimit": { kind: "integer", min: 0, max: 100 },
  "ui.supportEmail": { kind: "string", pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
};

const SUPPORT_REQUEST_SELECT = {
  id: true,
  subject: true,
  message: true,
  status: true,
  adminNote: true,
  createdAt: true,
  updatedAt: true,
  resolvedAt: true,
  user: {
    select: {
      id: true,
      email: true,
      username: true,
      isActive: true,
      createdAt: true,
    },
  },
} satisfies Prisma.SupportRequestSelect;

const SUPPORT_REQUEST_STATUSES = new Set<SupportRequestStatus>([
  SupportRequestStatus.OPEN,
  SupportRequestStatus.IN_PROGRESS,
  SupportRequestStatus.RESOLVED,
  SupportRequestStatus.CLOSED,
]);

function normalizePlatformSetting(key: string, rawValue: any) {
  const rule = ALLOWED_PLATFORM_SETTINGS[key];
  if (!rule) {
    throw new Error(`Unsupported setting key: ${key}`);
  }

  if (rule.kind === "boolean") {
    if (typeof rawValue === "boolean") return rawValue;
    if (typeof rawValue === "string") {
      const value = rawValue.trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(value)) return true;
      if (["false", "0", "no", "off"].includes(value)) return false;
    }
    if (typeof rawValue === "number") {
      if (rawValue === 1) return true;
      if (rawValue === 0) return false;
    }
    throw new Error(`${key} must be a boolean value`);
  }

  if (rule.kind === "integer") {
    const value = typeof rawValue === "number" ? rawValue : Number(rawValue);
    if (!Number.isInteger(value)) {
      throw new Error(`${key} must be an integer`);
    }
    if (rule.min !== undefined && value < rule.min) {
      throw new Error(`${key} must be at least ${rule.min}`);
    }
    if (rule.max !== undefined && value > rule.max) {
      throw new Error(`${key} must be at most ${rule.max}`);
    }
    return value;
  }

  const value = String(rawValue).trim();
  if (!value) throw new Error(`${key} cannot be empty`);
  if (rule.pattern && !rule.pattern.test(value)) {
    throw new Error(`${key} is not valid`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Support requests (region-scoped user support inbox)
// ---------------------------------------------------------------------------

router.get("/support-requests", async (req, res) => {
  try {
    const regionId = getRegion(req);
    const rawStatus = typeof req.query.status === "string" ? req.query.status : "ALL";
    const status = rawStatus.trim().toUpperCase();
    if (status !== "ALL" && !SUPPORT_REQUEST_STATUSES.has(status as SupportRequestStatus)) {
      return res.status(400).json({ message: "Invalid support request status" });
    }

    const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : 50;
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100)
      : 50;
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";

    const where: Prisma.SupportRequestWhereInput = {
      regionId,
      ...(status !== "ALL" ? { status: status as SupportRequestStatus } : {}),
      ...(search
        ? {
            OR: [
              { subject: { contains: search, mode: "insensitive" } },
              { message: { contains: search, mode: "insensitive" } },
              { user: { email: { contains: search, mode: "insensitive" } } },
              { user: { username: { contains: search, mode: "insensitive" } } },
            ],
          }
        : {}),
    };

    const supportRequests = await prisma.supportRequest.findMany({
      where,
      take: limit,
      orderBy: { createdAt: "desc" },
      select: SUPPORT_REQUEST_SELECT,
    });

    return res.json(supportRequests);
  } catch (error: any) {
    return res.status(403).json({ message: error.message });
  }
});

router.patch("/support-requests/:requestId", async (req, res) => {
  try {
    const regionId = getRegion(req);
    const { requestId } = req.params;
    const { status, adminNote } = req.body as {
      status?: string;
      adminNote?: unknown;
    };

    const existing = await prisma.supportRequest.findUnique({
      where: { id: requestId },
      select: { id: true, regionId: true, resolvedAt: true },
    });

    if (!existing || existing.regionId !== regionId) {
      return res.status(404).json({ message: "Support request not found" });
    }

    const data: Prisma.SupportRequestUpdateInput = {};
    if (status !== undefined) {
      if (!SUPPORT_REQUEST_STATUSES.has(status as SupportRequestStatus)) {
        return res.status(400).json({ message: "Invalid support request status" });
      }
      const nextStatus = status as SupportRequestStatus;
      data.status = nextStatus;
      data.resolvedAt =
        nextStatus === SupportRequestStatus.RESOLVED || nextStatus === SupportRequestStatus.CLOSED
          ? existing.resolvedAt ?? new Date()
          : null;
    }

    if (adminNote !== undefined) {
      if (typeof adminNote !== "string") {
        return res.status(400).json({ message: "adminNote must be a string" });
      }
      const trimmedAdminNote = adminNote.trim();
      if (trimmedAdminNote.length > 2000) {
        return res.status(400).json({ message: "adminNote must be at most 2000 characters" });
      }
      data.adminNote = trimmedAdminNote || null;
    }

    const supportRequest = await prisma.supportRequest.update({
      where: { id: requestId },
      data,
      select: SUPPORT_REQUEST_SELECT,
    });

    return res.json(supportRequest);
  } catch (error: any) {
    return res.status(400).json({ message: error.message });
  }
});

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
        publishableKey: cfg.stripePublishableKey || "",
        secretConfigured: !!stripeSecretKey,
        secretMasked: maskSecret(stripeSecretKey),
        webhookConfigured: !!stripeWebhookSecret,
      },
      paypal: {
        clientId: cfg.paypalClientId || "",
        secretConfigured: !!paypalClientSecret,
        secretMasked: maskSecret(paypalClientSecret),
        mode: cfg.paypalMode || "sandbox",
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

    if (paypalClientId !== undefined) {
      writable.paypalClientId = paypalClientId || null;
    }
    if (paypalClientSecret !== undefined) {
      writable.paypalClientSecret = encryptSecret(paypalClientSecret || null);
    }
    if (paypalMode !== undefined) {
      if (!["sandbox", "live"].includes(paypalMode)) {
        return res.status(400).json({ message: "Invalid PayPal mode" });
      }
      writable.paypalMode = paypalMode;
    }

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

const STRIPE_PLAN_SYNC_FAILED_RESPONSE = {
  error: "Could not sync plan to Stripe. Check payment settings.",
  code: "STRIPE_PLAN_SYNC_FAILED",
} as const;

router.get("/plans", async (req, res) => {
  try {
    const regionId = getRegion(req);
    const { formatSubAdminPlanResponse } = await import(
      "../services/billing/stripePlanService"
    );
    const plans = await prisma.plan.findMany({
      where: { regionId },
      include: { _count: { select: { subscriptions: true } } },
      orderBy: { createdAt: "desc" },
    });
    return res.json(plans.map((plan) => formatSubAdminPlanResponse(plan)));
  } catch (error: any) {
    return res.status(403).json({ message: error.message });
  }
});

// Validate the plan feature-toggle / usage-limit fields. `partial` mode (PATCH)
// only validates the keys that are present; create mode requires the core fields.
function validatePlanFeatureFields(body: Record<string, any>, partial: boolean) {
  const data: any = {};

  const boolFields = ["fullDashboardUnlock", "imageGenerationEnabled"] as const;
  const intFields = [
    "maxRewritesPerPost",
    "dailyPostLimit",
    "dailyBatchGenerationLimit",
    "dailyImageGenerationLimit",
  ] as const;

  for (const key of boolFields) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "boolean") {
      throw new Error(`${key} must be a boolean`);
    }
    data[key] = body[key];
  }

  for (const key of intFields) {
    if (body[key] === undefined) continue;
    const value =
      typeof body[key] === "number" ? body[key] : Number(body[key]);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${key} must be an integer >= 0`);
    }
    data[key] = value;
  }

  return data;
}

router.post("/plans", async (req, res) => {
  try {
    const regionId = getRegion(req);
    const body = req.body as Record<string, any>;
    const { name, code, price, currency, billingCycle } = body;
    const { validateManualStripePriceId, syncPlanToStripe, formatSubAdminPlanResponse } =
      await import("../services/billing/stripePlanService");

    // Core required fields.
    if (!name || typeof name !== "string") {
      return res.status(400).json({ message: "name is required" });
    }
    if (!code || typeof code !== "string") {
      return res.status(400).json({ message: "code is required" });
    }
    const priceNum = price === undefined ? NaN : Number(price);
    if (!Number.isFinite(priceNum) || priceNum < 0) {
      return res.status(400).json({ message: "price must be a number >= 0" });
    }
    if (!currency || typeof currency !== "string") {
      return res.status(400).json({ message: "currency is required" });
    }
    if (!billingCycle || typeof billingCycle !== "string") {
      return res.status(400).json({ message: "billingCycle is required" });
    }

    let featureData: any;
    try {
      featureData = validatePlanFeatureFields(body, false);
    } catch (err: any) {
      return res.status(400).json({ message: err.message });
    }

    let manualStripePriceId: string | undefined;
    try {
      manualStripePriceId = validateManualStripePriceId(body.stripePriceId);
    } catch (err: any) {
      return res.status(400).json({ error: err.message, code: "PLAN_NOT_CONFIGURED_IN_STRIPE" });
    }

    const plan = await prisma.plan.create({
      data: {
        name,
        code,
        price: priceNum,
        currency,
        billingCycle,
        regionId,
        stripePriceId: manualStripePriceId,
        ...featureData,
      },
    });

    if (body.syncStripe === true && !manualStripePriceId) {
      try {
        await syncPlanToStripe({
          regionId,
          planId: plan.id,
          name,
          code,
          price: priceNum,
          currency,
          billingCycle,
        });
        const synced = await prisma.plan.findUnique({ where: { id: plan.id } });
        return res.status(201).json(formatSubAdminPlanResponse(synced!));
      } catch {
        await prisma.plan.delete({ where: { id: plan.id } });
        return res.status(400).json(STRIPE_PLAN_SYNC_FAILED_RESPONSE);
      }
    }

    return res.status(201).json(formatSubAdminPlanResponse(plan));
  } catch (error: any) {
    if (error?.code === "P2002") {
      return res.status(400).json({
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
    const { validateManualStripePriceId, syncPlanToStripe, formatSubAdminPlanResponse } =
      await import("../services/billing/stripePlanService");

    const existing = await prisma.plan.findUnique({ where: { id: planId } });
    if (!existing || existing.regionId !== regionId) {
      return res.status(404).json({ message: "Plan not found in your region" });
    }

    const body = req.body as Record<string, any>;
    const { name, code, price, currency, billingCycle, isActive } = body;
    const data: any = {};

    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) {
        return res.status(400).json({ message: "name is required" });
      }
      data.name = name;
    }
    if (code !== undefined) {
      if (typeof code !== "string" || !code.trim()) {
        return res.status(400).json({ message: "code is required" });
      }
      data.code = code;
    }
    if (price !== undefined) {
      const priceNum = Number(price);
      if (!Number.isFinite(priceNum) || priceNum < 0) {
        return res.status(400).json({ message: "price must be a number >= 0" });
      }
      data.price = priceNum;
    }
    if (currency !== undefined) {
      if (typeof currency !== "string" || !currency.trim()) {
        return res.status(400).json({ message: "currency is required" });
      }
      data.currency = currency;
    }
    if (billingCycle !== undefined) {
      if (typeof billingCycle !== "string" || !billingCycle.trim()) {
        return res.status(400).json({ message: "billingCycle is required" });
      }
      data.billingCycle = billingCycle;
    }
    if (typeof isActive === "boolean") data.isActive = isActive;

    let featureData: any;
    try {
      featureData = validatePlanFeatureFields(body, true);
    } catch (err: any) {
      return res.status(400).json({ message: err.message });
    }

    let manualStripePriceId: string | undefined;
    try {
      manualStripePriceId = validateManualStripePriceId(body.stripePriceId);
    } catch (err: any) {
      return res.status(400).json({ error: err.message, code: "PLAN_NOT_CONFIGURED_IN_STRIPE" });
    }
    if (manualStripePriceId) {
      data.stripePriceId = manualStripePriceId;
    }

    Object.assign(data, featureData);

    const plan = await prisma.plan.update({ where: { id: planId }, data });

    if (body.syncStripe === true && !manualStripePriceId) {
      try {
        await syncPlanToStripe({
          regionId,
          planId,
          name: plan.name,
          code: plan.code,
          price: plan.price,
          currency: plan.currency,
          billingCycle: plan.billingCycle,
          previousStripePriceId: existing.stripePriceId,
        });
        const refreshed = await prisma.plan.findUnique({
          where: { id: planId },
          include: { _count: { select: { subscriptions: true } } },
        });
        return res.json(formatSubAdminPlanResponse(refreshed!));
      } catch {
        return res.status(400).json(STRIPE_PLAN_SYNC_FAILED_RESPONSE);
      }
    }

    const withCount = await prisma.plan.findUnique({
      where: { id: planId },
      include: { _count: { select: { subscriptions: true } } },
    });
    return res.json(formatSubAdminPlanResponse(withCount!));
  } catch (error: any) {
    if (error?.code === "P2002") {
      return res.status(400).json({
        message: "A plan with this code already exists in your region",
      });
    }
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

router.post("/billing/reconcile", async (req, res) => {
  try {
    const regionId = getRegion(req);
    const { reconcileOpenSubscriptions } = await import(
      "../services/billing/billingReconciliationService"
    );
    const results = await reconcileOpenSubscriptions(regionId);
    return res.json({ results });
  } catch (error: any) {
    return res.status(400).json({ message: error.message });
  }
});

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

    const sub = await updateAdminSubscription({
      regionId,
      subscriptionId: id,
      body: req.body,
    });
    return res.json(sub);
  } catch (error: unknown) {
    if (error instanceof SubscriptionAdminError) {
      return res.status(error.status).json({ message: error.message });
    }
    const message = error instanceof Error ? error.message : "Update failed";
    return res.status(400).json({ message });
  }
});

// ---------------------------------------------------------------------------
// Platform settings for this region
// ---------------------------------------------------------------------------

router.get("/settings", async (req, res) => {
  try {
    const regionId = getRegion(req);
    const allowedKeys = Object.keys(ALLOWED_PLATFORM_SETTINGS);
    const settings = await prisma.platformSetting.findMany({
      where: {
        key: { in: allowedKeys },
        OR: [
          { scope: "GLOBAL", regionId: null },
          { scope: "REGION", regionId },
        ],
      },
      orderBy: [{ scope: "asc" }, { key: "asc" }],
    });
    return res.json(settings);
  } catch (error: any) {
    return res.status(403).json({ message: error.message });
  }
});

router.put("/settings/:key", async (req, res) => {
  try {
    const regionId = getRegion(req);
    const { key } = req.params;
    const { value } = req.body as { value: any };

    if (!key) return res.status(400).json({ message: "Missing setting key" });
    if (value === undefined)
      return res.status(400).json({ message: "Missing setting value" });

    let normalizedValue: any;
    try {
      normalizedValue = normalizePlatformSetting(key, value);
    } catch (error: any) {
      return res.status(400).json({ message: error.message });
    }

    const setting = await prisma.platformSetting.upsert({
      where: { scope_regionId_key: { scope: "REGION", regionId, key } },
      create: { scope: "REGION", regionId, key, value: normalizedValue },
      update: { value: normalizedValue },
    });

    return res.json(setting);
  } catch (error: any) {
    return res.status(400).json({ message: error.message });
  }
});

// ---------------------------------------------------------------------------
// Promotions / promo codes
// ---------------------------------------------------------------------------

router.get("/promotions", async (req, res) => {
  try {
    const regionId = getRegion(req);
    const promotions = await prisma.promotion.findMany({
      where: { regionId },
      include: { _count: { select: { redemptions: true } } },
      orderBy: { createdAt: "desc" },
    });
    return res.json(promotions);
  } catch (error: any) {
    return res.status(403).json({ message: error.message });
  }
});

router.post("/promotions", async (req, res) => {
  try {
    const regionId = getRegion(req);
    const {
      code,
      name,
      description,
      type,
      stripePromotionCodeId,
      stripeCouponId,
      extraTrialDays,
      maxRedemptions,
      startsAt,
      endsAt,
      isActive,
    } = req.body as Record<string, any>;

    if (!code || !name) {
      return res.status(400).json({ message: "Missing code or name" });
    }

    const allowedTypes = ["STRIPE_PROMO", "INTERNAL_TRIAL", "CAMPAIGN"];
    const promoType = type || "STRIPE_PROMO";
    if (!allowedTypes.includes(promoType)) {
      return res.status(400).json({ message: "Invalid promotion type" });
    }

    const promotion = await prisma.promotion.create({
      data: {
        regionId,
        code: String(code).trim().toUpperCase(),
        name,
        description: description || null,
        type: promoType,
        stripePromotionCodeId: stripePromotionCodeId || null,
        stripeCouponId: stripeCouponId || null,
        extraTrialDays:
          extraTrialDays === undefined ? null : Number(extraTrialDays),
        maxRedemptions:
          maxRedemptions === undefined || maxRedemptions === null
            ? null
            : Number(maxRedemptions),
        startsAt: startsAt ? new Date(startsAt) : null,
        endsAt: endsAt ? new Date(endsAt) : null,
        isActive: typeof isActive === "boolean" ? isActive : true,
      },
    });

    return res.status(201).json(promotion);
  } catch (error: any) {
    if (error?.code === "P2002") {
      return res
        .status(400)
        .json({
          message: "A promotion with this code already exists in your region",
        });
    }
    return res.status(400).json({ message: error.message });
  }
});

router.patch("/promotions/:promotionId", async (req, res) => {
  try {
    const regionId = getRegion(req);
    const { promotionId } = req.params;
    const existing = await prisma.promotion.findUnique({
      where: { id: promotionId },
    });
    if (!existing || existing.regionId !== regionId) {
      return res
        .status(404)
        .json({ message: "Promotion not found in your region" });
    }

    const data: any = {};
    for (const key of [
      "name",
      "description",
      "type",
      "stripePromotionCodeId",
      "stripeCouponId",
    ]) {
      if (req.body[key] !== undefined) data[key] = req.body[key] || null;
    }
    if (req.body.code !== undefined)
      data.code = String(req.body.code).trim().toUpperCase();
    if (req.body.extraTrialDays !== undefined)
      data.extraTrialDays =
        req.body.extraTrialDays === null
          ? null
          : Number(req.body.extraTrialDays);
    if (req.body.maxRedemptions !== undefined)
      data.maxRedemptions =
        req.body.maxRedemptions === null
          ? null
          : Number(req.body.maxRedemptions);
    if (req.body.startsAt !== undefined)
      data.startsAt = req.body.startsAt ? new Date(req.body.startsAt) : null;
    if (req.body.endsAt !== undefined)
      data.endsAt = req.body.endsAt ? new Date(req.body.endsAt) : null;
    if (typeof req.body.isActive === "boolean")
      data.isActive = req.body.isActive;

    const promotion = await prisma.promotion.update({
      where: { id: promotionId },
      data,
    });
    return res.json(promotion);
  } catch (error: any) {
    return res.status(400).json({ message: error.message });
  }
});

// ---------------------------------------------------------------------------
// Invite links
// ---------------------------------------------------------------------------

router.get("/invites", async (req, res) => {
  try {
    const regionId = getRegion(req);
    const invites = await prisma.inviteLink.findMany({
      where: { regionId },
      include: { _count: { select: { redemptions: true } } },
      orderBy: { createdAt: "desc" },
    });
    return res.json(invites);
  } catch (error: any) {
    return res.status(403).json({ message: error.message });
  }
});

router.post("/invites", async (req, res) => {
  try {
    const regionId = getRegion(req);
    const {
      code,
      email,
      maxUses,
      expiresAt,
      promoCode,
      roleToAssign,
      isActive,
    } = req.body as Record<string, any>;
    const requestedRole = roleToAssign || UserRole.USER;

    if (requestedRole === UserRole.SUPER_ADMIN) {
      return res
        .status(400)
        .json({ message: "Invite links cannot create super admins" });
    }
    if (
      requestedRole !== UserRole.USER &&
      (req as any).user?.role !== UserRole.SUPER_ADMIN
    ) {
      return res
        .status(403)
        .json({ message: "Only a super admin can create admin invite links" });
    }

    const invite = await prisma.inviteLink.create({
      data: {
        regionId,
        code: code || generateInviteCode(),
        createdByUserId: (req as any).user?.id || null,
        roleToAssign: requestedRole,
        email: email || null,
        maxUses:
          maxUses === undefined || maxUses === null ? null : Number(maxUses),
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        promoCode: promoCode ? String(promoCode).trim().toUpperCase() : null,
        isActive: typeof isActive === "boolean" ? isActive : true,
      },
    });

    return res.status(201).json(invite);
  } catch (error: any) {
    if (error?.code === "P2002") {
      return res.status(400).json({ message: "Invite code already exists" });
    }
    return res.status(400).json({ message: error.message });
  }
});

router.patch("/invites/:inviteId", async (req, res) => {
  try {
    const regionId = getRegion(req);
    const { inviteId } = req.params;
    const existing = await prisma.inviteLink.findUnique({
      where: { id: inviteId },
    });
    if (!existing || existing.regionId !== regionId) {
      return res
        .status(404)
        .json({ message: "Invite not found in your region" });
    }

    const data: any = {};
    if (req.body.email !== undefined) data.email = req.body.email || null;
    if (req.body.maxUses !== undefined)
      data.maxUses =
        req.body.maxUses === null ? null : Number(req.body.maxUses);
    if (req.body.expiresAt !== undefined)
      data.expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : null;
    if (req.body.promoCode !== undefined)
      data.promoCode = req.body.promoCode
        ? String(req.body.promoCode).trim().toUpperCase()
        : null;
    if (typeof req.body.isActive === "boolean")
      data.isActive = req.body.isActive;

    const invite = await prisma.inviteLink.update({
      where: { id: inviteId },
      data,
    });
    return res.json(invite);
  } catch (error: any) {
    return res.status(400).json({ message: error.message });
  }
});

export default router;
