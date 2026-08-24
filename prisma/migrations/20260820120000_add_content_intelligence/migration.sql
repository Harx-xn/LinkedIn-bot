CREATE TABLE "UserContentIntelligence" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "profile" JSONB NOT NULL,
  "inputFingerprint" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "confidence" DOUBLE PRECISION,
  "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UserContentIntelligence_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UserContentIntelligence_userId_key" ON "UserContentIntelligence"("userId");
CREATE INDEX "UserContentIntelligence_inputFingerprint_idx" ON "UserContentIntelligence"("inputFingerprint");
ALTER TABLE "UserContentIntelligence" ADD CONSTRAINT "UserContentIntelligence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PostContentFingerprint"
  ADD COLUMN "pillar" TEXT,
  ADD COLUMN "territory" TEXT,
  ADD COLUMN "mechanism" TEXT,
  ADD COLUMN "perspective" TEXT,
  ADD COLUMN "argumentPattern" TEXT,
  ADD COLUMN "exampleType" TEXT,
  ADD COLUMN "authorityMode" TEXT,
  ADD COLUMN "contentIntent" TEXT;
