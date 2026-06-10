-- AlterTable
ALTER TABLE "Post" ADD COLUMN "manualTopic" TEXT;
ALTER TABLE "Post" ADD COLUMN "aiGenerated" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ManualAiRewriteUsage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "regionId" TEXT,
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManualAiRewriteUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ManualAiRewriteUsage_userId_createdAt_idx" ON "ManualAiRewriteUsage"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ManualAiRewriteUsage_regionId_createdAt_idx" ON "ManualAiRewriteUsage"("regionId", "createdAt");

-- AddForeignKey
ALTER TABLE "ManualAiRewriteUsage" ADD CONSTRAINT "ManualAiRewriteUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualAiRewriteUsage" ADD CONSTRAINT "ManualAiRewriteUsage_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE SET NULL ON UPDATE CASCADE;
