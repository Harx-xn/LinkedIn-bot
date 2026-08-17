ALTER TABLE "Subscription"
ADD COLUMN "canceledDuringTrial" BOOLEAN NOT NULL DEFAULT false;

UPDATE "Subscription"
SET "canceledDuringTrial" = true
WHERE "status" = 'CANCELED'
  AND "trialStart" IS NOT NULL
  AND "trialEnd" IS NOT NULL
  AND ("currentPeriodStart" IS NULL OR "currentPeriodStart" <= "trialEnd");
