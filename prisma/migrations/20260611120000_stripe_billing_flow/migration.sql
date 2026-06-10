-- CreateEnum
CREATE TYPE "BillingAccessStatus" AS ENUM ('BILLING_REQUIRED', 'TRIAL_PENDING', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'PAYMENT_ACTION_REQUIRED', 'PAUSED', 'CANCELED', 'INCOMPLETE');

-- AlterTable User
ALTER TABLE "User" ADD COLUMN "trialRedeemedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "billingAccessStatus" "BillingAccessStatus" NOT NULL DEFAULT 'BILLING_REQUIRED';
ALTER TABLE "User" ADD COLUMN "stripeCustomerId" TEXT;

-- Backfill billing access for existing users
UPDATE "User" SET "billingAccessStatus" = 'TRIALING'
WHERE "role" = 'USER'
  AND "trialEndsAt" IS NOT NULL
  AND "trialEndsAt" > NOW()
  AND "trialRedeemedAt" IS NULL;

UPDATE "User" SET "trialRedeemedAt" = "trialStartedAt", "billingAccessStatus" = 'TRIALING'
WHERE "role" = 'USER'
  AND "trialEndsAt" IS NOT NULL
  AND "trialEndsAt" > NOW()
  AND "trialStartedAt" IS NOT NULL;

UPDATE "User" u SET "billingAccessStatus" = 'ACTIVE'
FROM "Subscription" s
WHERE s."userId" = u.id
  AND s.status IN ('ACTIVE', 'TRIALING')
  AND u."role" = 'USER';

-- AlterTable Subscription
ALTER TABLE "Subscription" ADD COLUMN "stripeSubscriptionItemId" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "stripeLatestInvoiceId" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "stripeDefaultPaymentMethodId" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Subscription" ADD COLUMN "canceledAt" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN "currentPeriodStart" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN "currentPeriodEnd" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN "trialStart" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN "trialEnd" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN "paymentFailedAt" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN "paymentActionRequiredAt" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN "lastStripeEventCreatedAt" TIMESTAMP(3);

-- AlterTable PaymentEvent
ALTER TABLE "PaymentEvent" ADD COLUMN "stripeCreatedAt" TIMESTAMP(3);
ALTER TABLE "PaymentEvent" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'RECEIVED';
ALTER TABLE "PaymentEvent" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PaymentEvent" ADD COLUMN "processedAt" TIMESTAMP(3);
ALTER TABLE "PaymentEvent" ADD COLUMN "errorMessage" TEXT;
ALTER TABLE "PaymentEvent" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Mark legacy webhook events as already processed
UPDATE "PaymentEvent" SET "status" = 'PROCESSED', "processedAt" = "createdAt" WHERE "processedAt" IS NULL;

-- CreateTable Notification
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
