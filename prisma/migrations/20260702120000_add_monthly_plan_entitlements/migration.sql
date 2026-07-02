-- AlterTable: nullable monthly entitlement limits. Daily limits remain in place
-- as the enforcement fallback while the application migrates to monthly usage.
ALTER TABLE "Plan"
  ADD COLUMN "monthlyPostLimit" INTEGER,
  ADD COLUMN "monthlyBatchGenerationLimit" INTEGER,
  ADD COLUMN "monthlyImageGenerationLimit" INTEGER,
  ADD COLUMN "monthlyManualAiOperationLimit" INTEGER;

-- Backfill existing plans without overwriting any monthly values that may have
-- been populated independently during a staged deployment.
UPDATE "Plan"
SET "monthlyPostLimit" = "dailyPostLimit" * 30
WHERE "monthlyPostLimit" IS NULL
  AND "dailyPostLimit" IS NOT NULL;

UPDATE "Plan"
SET "monthlyBatchGenerationLimit" = "dailyBatchGenerationLimit" * 30
WHERE "monthlyBatchGenerationLimit" IS NULL
  AND "dailyBatchGenerationLimit" IS NOT NULL;

UPDATE "Plan"
SET "monthlyImageGenerationLimit" = "dailyImageGenerationLimit" * 30
WHERE "monthlyImageGenerationLimit" IS NULL
  AND "dailyImageGenerationLimit" IS NOT NULL;

UPDATE "Plan"
SET "monthlyManualAiOperationLimit" = GREATEST(1, "maxRewritesPerPost" * 150)
WHERE "monthlyManualAiOperationLimit" IS NULL
  AND "maxRewritesPerPost" IS NOT NULL;
