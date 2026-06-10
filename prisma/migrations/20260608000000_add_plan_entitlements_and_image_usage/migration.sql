-- AlterTable: Plan feature toggles / usage limits
ALTER TABLE "Plan" ADD COLUMN IF NOT EXISTS "fullDashboardUnlock" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Plan" ADD COLUMN IF NOT EXISTS "maxRewritesPerPost" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "Plan" ADD COLUMN IF NOT EXISTS "dailyPostLimit" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "Plan" ADD COLUMN IF NOT EXISTS "dailyBatchGenerationLimit" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Plan" ADD COLUMN IF NOT EXISTS "imageGenerationEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Plan" ADD COLUMN IF NOT EXISTS "dailyImageGenerationLimit" INTEGER NOT NULL DEFAULT 0;

-- CreateTable: ImageGenerationUsage
CREATE TABLE IF NOT EXISTS "ImageGenerationUsage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "regionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImageGenerationUsage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ImageGenerationUsage_userId_createdAt_idx" ON "ImageGenerationUsage"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "ImageGenerationUsage_regionId_createdAt_idx" ON "ImageGenerationUsage"("regionId", "createdAt");

-- Foreign keys (guarded so re-runs don't fail)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ImageGenerationUsage_userId_fkey'
  ) THEN
    ALTER TABLE "ImageGenerationUsage"
      ADD CONSTRAINT "ImageGenerationUsage_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ImageGenerationUsage_regionId_fkey'
  ) THEN
    ALTER TABLE "ImageGenerationUsage"
      ADD CONSTRAINT "ImageGenerationUsage_regionId_fkey"
      FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
