-- Provider-independent billing configuration and ownership.
ALTER TABLE "PaymentConfig"
  ADD COLUMN "safepayPublicKey" TEXT,
  ADD COLUMN "safepaySecretKey" TEXT,
  ADD COLUMN "safepayWebhookSecret" TEXT,
  ADD COLUMN "safepayEnvironment" TEXT DEFAULT 'SANDBOX';

ALTER TABLE "Subscription"
  ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "providerSubscriptionId" TEXT,
  ADD COLUMN "providerCustomerId" TEXT,
  ADD COLUMN "providerStatus" TEXT,
  ADD COLUMN "providerPaymentMethodPresent" BOOLEAN NOT NULL DEFAULT false;

-- Backfill generic ownership from the legacy Stripe columns. Keeping the legacy
-- columns allows a zero-downtime Stripe rollout.
UPDATE "Subscription"
SET "provider" = 'STRIPE',
    "providerSubscriptionId" = "stripeSubscriptionId",
    "providerCustomerId" = "stripeCustomerId",
    "providerPaymentMethodPresent" = ("stripeDefaultPaymentMethodId" IS NOT NULL)
WHERE "stripeSubscriptionId" IS NOT NULL OR "stripeCustomerId" IS NOT NULL;

CREATE UNIQUE INDEX "Subscription_provider_providerSubscriptionId_key"
  ON "Subscription"("provider", "providerSubscriptionId");
CREATE INDEX "Subscription_provider_providerCustomerId_idx"
  ON "Subscription"("provider", "providerCustomerId");

CREATE TABLE "PlanProviderMapping" (
  "id" TEXT NOT NULL,
  "planId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "environment" TEXT NOT NULL DEFAULT 'LIVE',
  "providerPlanId" TEXT,
  "providerProductId" TEXT,
  "providerPriceId" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlanProviderMapping_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PlanProviderMapping_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PlanProviderMapping_planId_provider_environment_key"
  ON "PlanProviderMapping"("planId", "provider", "environment");
CREATE INDEX "PlanProviderMapping_provider_providerPlanId_idx"
  ON "PlanProviderMapping"("provider", "providerPlanId");
CREATE INDEX "PlanProviderMapping_provider_providerPriceId_idx"
  ON "PlanProviderMapping"("provider", "providerPriceId");

-- Preserve existing Stripe plan IDs in the generic mapping layer.
INSERT INTO "PlanProviderMapping" (
  "id", "planId", "provider", "environment", "providerPriceId", "createdAt", "updatedAt"
)
SELECT CONCAT('legacy_stripe_', "id"), "id", 'STRIPE', 'LIVE', "stripePriceId", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Plan"
WHERE "stripePriceId" IS NOT NULL
ON CONFLICT ("planId", "provider", "environment") DO NOTHING;

ALTER TABLE "PaymentEvent" ADD COLUMN "regionId" TEXT, ADD COLUMN "payload" JSONB;

CREATE TABLE "BillingTransaction" (
  "id" TEXT NOT NULL,
  "subscriptionId" TEXT,
  "userId" TEXT NOT NULL,
  "regionId" TEXT,
  "provider" TEXT NOT NULL,
  "providerInvoiceId" TEXT,
  "providerTransactionId" TEXT,
  "amount" INTEGER NOT NULL,
  "amountPaid" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "periodStart" TIMESTAMP(3),
  "periodEnd" TIMESTAMP(3),
  "paidAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "receiptUrl" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BillingTransaction_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BillingTransaction_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BillingTransaction_provider_providerTransactionId_key"
  ON "BillingTransaction"("provider", "providerTransactionId");
CREATE INDEX "BillingTransaction_userId_createdAt_idx" ON "BillingTransaction"("userId", "createdAt");
CREATE INDEX "BillingTransaction_subscriptionId_idx" ON "BillingTransaction"("subscriptionId");
