-- CreateTable
CREATE TABLE "BotGenerationJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "daysWindow" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "BotGenerationJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BotGenerationJob_userId_createdAt_idx" ON "BotGenerationJob"("userId", "createdAt");
