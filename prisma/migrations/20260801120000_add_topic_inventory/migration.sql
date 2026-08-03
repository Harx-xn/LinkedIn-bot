CREATE TYPE "TopicInventoryStatus" AS ENUM ('AVAILABLE', 'RESERVED', 'CONSUMED', 'EXPIRED');
CREATE TABLE "TopicInventory" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "niche" TEXT NOT NULL, "title" TEXT NOT NULL,
  "normalizedTopic" TEXT NOT NULL, "coreClaim" TEXT, "semanticCluster" TEXT, "mechanism" TEXT, "intent" TEXT,
  "relevanceScore" DOUBLE PRECISION NOT NULL, "strategyScore" DOUBLE PRECISION NOT NULL, "confidenceScore" DOUBLE PRECISION NOT NULL,
  "sourceQualityScore" DOUBLE PRECISION NOT NULL, "noveltyScore" DOUBLE PRECISION NOT NULL, "recencyScore" DOUBLE PRECISION NOT NULL,
  "finalScore" DOUBLE PRECISION NOT NULL, "sourceUrl" TEXT, "sourceName" TEXT, "discoverySource" TEXT, "evidenceRole" TEXT,
  "evidenceSummary" TEXT, "supportingSources" JSONB, "fingerprint" TEXT NOT NULL, "profileFingerprint" TEXT,
  "sourcePublishedAt" TIMESTAMP(3), "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "expiresAt" TIMESTAMP(3),
  "status" "TopicInventoryStatus" NOT NULL DEFAULT 'AVAILABLE', "reservedByJobId" TEXT, "reservedAt" TIMESTAMP(3),
  "consumedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TopicInventory_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TopicInventory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TopicInventory_userId_fingerprint_key" ON "TopicInventory"("userId", "fingerprint");
CREATE INDEX "TopicInventory_userId_status_idx" ON "TopicInventory"("userId", "status");
CREATE INDEX "TopicInventory_userId_niche_status_idx" ON "TopicInventory"("userId", "niche", "status");
CREATE INDEX "TopicInventory_expiresAt_idx" ON "TopicInventory"("expiresAt");
