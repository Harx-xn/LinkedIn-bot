ALTER TABLE "PlanProviderMapping"
ADD COLUMN "providerPaidPlanId" TEXT;

CREATE INDEX "PlanProviderMapping_provider_providerPaidPlanId_idx"
ON "PlanProviderMapping"("provider", "providerPaidPlanId");
