-- Add structured strategy fields to BotConfig without removing legacy fields.
ALTER TABLE "BotConfig"
  ADD COLUMN "profilePositioning" JSONB,
  ADD COLUMN "targetAudience" JSONB,
  ADD COLUMN "contentGoals" JSONB,
  ADD COLUMN "contentPillars" JSONB,
  ADD COLUMN "topicRules" JSONB,
  ADD COLUMN "writingStyle" JSONB,
  ADD COLUMN "onboardingStatus" TEXT NOT NULL DEFAULT 'LEGACY';

CREATE INDEX "BotConfig_onboardingStatus_idx" ON "BotConfig"("onboardingStatus");
