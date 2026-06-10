-- CreateEnum
CREATE TYPE "TopicHistoryStatus" AS ENUM ('GENERATED', 'APPROVED', 'SCHEDULED', 'PUBLISHED', 'REJECTED');

-- CreateTable
CREATE TABLE "UserNicheSearchPlan" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "niche" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "subtopics" JSONB NOT NULL,
    "queries" JSONB NOT NULL,
    "exclusions" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserNicheSearchPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GeneratedTopicHistory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "postId" TEXT,
    "batchId" TEXT,
    "sourceTitle" TEXT,
    "normalizedTopic" TEXT NOT NULL,
    "topicCluster" TEXT NOT NULL,
    "coreClaim" TEXT,
    "angle" TEXT,
    "status" "TopicHistoryStatus" NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GeneratedTopicHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserNicheSearchPlan_userId_idx" ON "UserNicheSearchPlan"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserNicheSearchPlan_userId_niche_key" ON "UserNicheSearchPlan"("userId", "niche");

-- CreateIndex
CREATE INDEX "GeneratedTopicHistory_userId_generatedAt_idx" ON "GeneratedTopicHistory"("userId", "generatedAt");

-- CreateIndex
CREATE INDEX "GeneratedTopicHistory_userId_topicCluster_idx" ON "GeneratedTopicHistory"("userId", "topicCluster");

-- CreateIndex
CREATE INDEX "GeneratedTopicHistory_userId_normalizedTopic_idx" ON "GeneratedTopicHistory"("userId", "normalizedTopic");

-- CreateIndex
CREATE INDEX "GeneratedTopicHistory_postId_idx" ON "GeneratedTopicHistory"("postId");

-- AddForeignKey
ALTER TABLE "UserNicheSearchPlan" ADD CONSTRAINT "UserNicheSearchPlan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeneratedTopicHistory" ADD CONSTRAINT "GeneratedTopicHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
