CREATE TYPE "AiUsageStatus" AS ENUM ('SUCCESS', 'FAILED', 'PARTIAL');
CREATE TYPE "PlatformExpenseType" AS ENUM ('FIXED', 'VARIABLE');
CREATE TYPE "PlatformExpenseCycle" AS ENUM ('ONE_TIME', 'MONTHLY', 'YEARLY', 'USAGE');

CREATE TABLE "AiModelPricing" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputCostPerMillionTokens" DECIMAL(14,8) NOT NULL,
    "cachedInputCostPerMillionTokens" DECIMAL(14,8),
    "outputCostPerMillionTokens" DECIMAL(14,8) NOT NULL,
    "pricingUnit" TEXT NOT NULL DEFAULT 'TOKENS',
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AiModelPricing_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiUsageEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "regionId" TEXT,
    "feature" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "agent" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "generationId" TEXT,
    "postId" TEXT,
    "batchJobId" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "inputCostUsd" DECIMAL(14,8) NOT NULL DEFAULT 0,
    "cachedInputCostUsd" DECIMAL(14,8) NOT NULL DEFAULT 0,
    "outputCostUsd" DECIMAL(14,8) NOT NULL DEFAULT 0,
    "totalCostUsd" DECIMAL(14,8) NOT NULL DEFAULT 0,
    "status" "AiUsageStatus" NOT NULL DEFAULT 'SUCCESS',
    "durationMs" INTEGER,
    "providerUsage" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiUsageEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlatformExpense" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT,
    "category" TEXT NOT NULL,
    "type" "PlatformExpenseType" NOT NULL,
    "billingCycle" "PlatformExpenseCycle" NOT NULL,
    "amountUsd" DECIMAL(14,4) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "notes" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PlatformExpense_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CostAllocationRule" (
    "id" TEXT NOT NULL,
    "expenseCategory" TEXT NOT NULL,
    "allocationMethod" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CostAllocationRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CostProjectionScenario" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "projectedUsers" INTEGER NOT NULL,
    "monthlyUserGrowthRate" DOUBLE PRECISION NOT NULL,
    "activeUserRate" DOUBLE PRECISION NOT NULL,
    "trialToPaidRate" DOUBLE PRECISION NOT NULL,
    "monthlyChurnRate" DOUBLE PRECISION NOT NULL,
    "averageAiUsageMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "horizonMonths" INTEGER NOT NULL DEFAULT 12,
    "assumptions" JSONB,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CostProjectionScenario_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiModelPricing_provider_model_idx" ON "AiModelPricing"("provider", "model");
CREATE INDEX "AiModelPricing_provider_model_effectiveFrom_idx" ON "AiModelPricing"("provider", "model", "effectiveFrom");
CREATE INDEX "AiModelPricing_active_idx" ON "AiModelPricing"("active");
CREATE INDEX "AiUsageEvent_createdAt_idx" ON "AiUsageEvent"("createdAt");
CREATE INDEX "AiUsageEvent_userId_createdAt_idx" ON "AiUsageEvent"("userId", "createdAt");
CREATE INDEX "AiUsageEvent_regionId_createdAt_idx" ON "AiUsageEvent"("regionId", "createdAt");
CREATE INDEX "AiUsageEvent_feature_createdAt_idx" ON "AiUsageEvent"("feature", "createdAt");
CREATE INDEX "AiUsageEvent_operation_createdAt_idx" ON "AiUsageEvent"("operation", "createdAt");
CREATE INDEX "AiUsageEvent_agent_createdAt_idx" ON "AiUsageEvent"("agent", "createdAt");
CREATE INDEX "AiUsageEvent_provider_model_createdAt_idx" ON "AiUsageEvent"("provider", "model", "createdAt");
CREATE INDEX "AiUsageEvent_generationId_idx" ON "AiUsageEvent"("generationId");
CREATE INDEX "AiUsageEvent_postId_idx" ON "AiUsageEvent"("postId");
CREATE INDEX "AiUsageEvent_batchJobId_idx" ON "AiUsageEvent"("batchJobId");
CREATE INDEX "PlatformExpense_category_idx" ON "PlatformExpense"("category");
CREATE INDEX "PlatformExpense_active_idx" ON "PlatformExpense"("active");
CREATE INDEX "PlatformExpense_effectiveFrom_effectiveTo_idx" ON "PlatformExpense"("effectiveFrom", "effectiveTo");
CREATE INDEX "CostAllocationRule_expenseCategory_idx" ON "CostAllocationRule"("expenseCategory");
CREATE INDEX "CostAllocationRule_active_idx" ON "CostAllocationRule"("active");
CREATE INDEX "CostProjectionScenario_createdAt_idx" ON "CostProjectionScenario"("createdAt");
CREATE INDEX "CostProjectionScenario_createdByUserId_idx" ON "CostProjectionScenario"("createdByUserId");

ALTER TABLE "AiUsageEvent" ADD CONSTRAINT "AiUsageEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiUsageEvent" ADD CONSTRAINT "AiUsageEvent_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CostProjectionScenario" ADD CONSTRAINT "CostProjectionScenario_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
