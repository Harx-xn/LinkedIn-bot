CREATE TYPE "PersonalExperienceSource" AS ENUM ('USER_SUPPLIED', 'PROFILE_DERIVED', 'POST_DERIVED');

CREATE TABLE "PersonalExperience" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT,
    "rawText" TEXT NOT NULL,
    "summary" TEXT,
    "topics" JSONB,
    "lessons" JSONB,
    "outcomes" JSONB,
    "source" "PersonalExperienceSource" NOT NULL DEFAULT 'USER_SUPPLIED',
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PersonalExperience_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PersonalExperience_userId_updatedAt_idx" ON "PersonalExperience"("userId", "updatedAt");
CREATE INDEX "PersonalExperience_userId_lastUsedAt_idx" ON "PersonalExperience"("userId", "lastUsedAt");

ALTER TABLE "PersonalExperience" ADD CONSTRAINT "PersonalExperience_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
