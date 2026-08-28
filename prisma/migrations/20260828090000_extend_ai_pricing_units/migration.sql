-- Extend model pricing without rewriting or deleting existing pricing/history.
CREATE TYPE "AiPricingType" AS ENUM ('TEXT_TOKENS', 'IMAGE', 'PER_REQUEST', 'PER_SECOND', 'CUSTOM');

ALTER TABLE "AiModelPricing"
  ADD COLUMN "pricingType" "AiPricingType" NOT NULL DEFAULT 'TEXT_TOKENS',
  ADD COLUMN "imageOutputCost" DECIMAL(14,8),
  ADD COLUMN "imageOutputUnit" TEXT,
  ADD COLUMN "costPerRequest" DECIMAL(14,8),
  ADD COLUMN "costPerSecond" DECIMAL(14,8),
  ALTER COLUMN "inputCostPerMillionTokens" DROP NOT NULL,
  ALTER COLUMN "outputCostPerMillionTokens" DROP NOT NULL;

ALTER TABLE "AiUsageEvent"
  ADD COLUMN "pricingType" "AiPricingType",
  ADD COLUMN "requestedModel" TEXT,
  ADD COLUMN "resolvedModel" TEXT,
  ADD COLUMN "generatedImages" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "requestCount" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "billableSeconds" DECIMAL(14,4),
  ADD COLUMN "imageCostUsd" DECIMAL(14,8) NOT NULL DEFAULT 0,
  ADD COLUMN "requestCostUsd" DECIMAL(14,8) NOT NULL DEFAULT 0,
  ADD COLUMN "timeCostUsd" DECIMAL(14,8) NOT NULL DEFAULT 0,
  ADD COLUMN "customCostUsd" DECIMAL(14,8) NOT NULL DEFAULT 0;

CREATE INDEX "AiModelPricing_pricingType_idx" ON "AiModelPricing"("pricingType");
