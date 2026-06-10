-- CreateTable
CREATE TABLE "UserVoiceProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "profile" JSONB NOT NULL,
    "preferredPhrases" JSONB,
    "avoidedPhrases" JSONB,
    "approvedPatterns" JSONB,
    "rejectedPatterns" JSONB,
    "analyzedSampleCount" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lastAnalyzedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserVoiceProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserVoiceProfile_userId_key" ON "UserVoiceProfile"("userId");

-- AddForeignKey
ALTER TABLE "UserVoiceProfile" ADD CONSTRAINT "UserVoiceProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
