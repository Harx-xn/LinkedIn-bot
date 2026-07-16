ALTER TABLE "User"
  ADD COLUMN "isBillingExempt" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "billingExemptAt" TIMESTAMP(3),
  ADD COLUMN "billingExemptById" TEXT,
  ADD COLUMN "billingExemptReason" TEXT;

CREATE INDEX "User_isBillingExempt_idx" ON "User"("isBillingExempt");
