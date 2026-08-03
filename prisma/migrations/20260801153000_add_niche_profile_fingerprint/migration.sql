ALTER TABLE "UserNicheSearchPlan"
ADD COLUMN "schemaVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "queryGenerationVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "aliasGenerationVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "inputFingerprint" TEXT;
