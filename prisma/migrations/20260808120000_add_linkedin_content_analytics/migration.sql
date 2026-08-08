CREATE TYPE "LinkedInAnalyticsStatus" AS ENUM ('PROCESSING', 'ANALYZING', 'READY', 'FAILED');

CREATE TABLE "LinkedInAnalyticsImport" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL, "status" "LinkedInAnalyticsStatus" NOT NULL DEFAULT 'PROCESSING',
  "impressions" INTEGER NOT NULL DEFAULT 0, "membersReached" INTEGER NOT NULL DEFAULT 0,
  "engagementCount" INTEGER NOT NULL DEFAULT 0, "followerCount" INTEGER,
  "normalizedData" JSONB NOT NULL, "deterministicData" JSONB NOT NULL, "analysisError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LinkedInAnalyticsImport_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "LinkedInAnalyticsDailyMetric" ("id" TEXT NOT NULL, "importId" TEXT NOT NULL, "date" TIMESTAMP(3) NOT NULL, "impressions" INTEGER NOT NULL DEFAULT 0, "engagements" INTEGER NOT NULL DEFAULT 0, "newFollowers" INTEGER, CONSTRAINT "LinkedInAnalyticsDailyMetric_pkey" PRIMARY KEY ("id"));
CREATE TABLE "LinkedInAnalyticsPostMetric" ("id" TEXT NOT NULL, "importId" TEXT NOT NULL, "linkedinPostUrl" TEXT NOT NULL, "publishedAt" TIMESTAMP(3), "impressions" INTEGER NOT NULL DEFAULT 0, "engagements" INTEGER NOT NULL DEFAULT 0, "engagementRate" DOUBLE PRECISION NOT NULL DEFAULT 0, "matchedPostId" TEXT, "enrichment" JSONB, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "LinkedInAnalyticsPostMetric_pkey" PRIMARY KEY ("id"));
CREATE TABLE "LinkedInAnalyticsDemographic" ("id" TEXT NOT NULL, "importId" TEXT NOT NULL, "type" TEXT NOT NULL, "label" TEXT NOT NULL, "value" DOUBLE PRECISION NOT NULL, CONSTRAINT "LinkedInAnalyticsDemographic_pkey" PRIMARY KEY ("id"));
CREATE TABLE "LinkedInProfileSnapshot" ("id" TEXT NOT NULL, "userId" TEXT NOT NULL, "name" TEXT, "headline" TEXT, "location" TEXT, "summary" TEXT, "skills" JSONB NOT NULL, "experience" JSONB, "education" JSONB, "linkedinUrl" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "LinkedInProfileSnapshot_pkey" PRIMARY KEY ("id"));
CREATE TABLE "LinkedInAnalyticsInsight" ("id" TEXT NOT NULL, "importId" TEXT NOT NULL, "type" TEXT NOT NULL, "importance" TEXT NOT NULL, "title" TEXT NOT NULL, "finding" TEXT NOT NULL, "recommendation" TEXT NOT NULL, "nextMove" TEXT, "evidence" JSONB NOT NULL, "confidence" DOUBLE PRECISION, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "LinkedInAnalyticsInsight_pkey" PRIMARY KEY ("id"));

CREATE UNIQUE INDEX "LinkedInAnalyticsImport_userId_periodStart_periodEnd_key" ON "LinkedInAnalyticsImport"("userId", "periodStart", "periodEnd");
CREATE INDEX "LinkedInAnalyticsImport_userId_periodEnd_idx" ON "LinkedInAnalyticsImport"("userId", "periodEnd");
CREATE UNIQUE INDEX "LinkedInAnalyticsDailyMetric_importId_date_key" ON "LinkedInAnalyticsDailyMetric"("importId", "date");
CREATE INDEX "LinkedInAnalyticsDailyMetric_importId_idx" ON "LinkedInAnalyticsDailyMetric"("importId");
CREATE INDEX "LinkedInAnalyticsPostMetric_importId_idx" ON "LinkedInAnalyticsPostMetric"("importId");
CREATE INDEX "LinkedInAnalyticsPostMetric_matchedPostId_idx" ON "LinkedInAnalyticsPostMetric"("matchedPostId");
CREATE INDEX "LinkedInAnalyticsDemographic_importId_type_idx" ON "LinkedInAnalyticsDemographic"("importId", "type");
CREATE INDEX "LinkedInProfileSnapshot_userId_createdAt_idx" ON "LinkedInProfileSnapshot"("userId", "createdAt");
CREATE INDEX "LinkedInAnalyticsInsight_importId_importance_idx" ON "LinkedInAnalyticsInsight"("importId", "importance");

ALTER TABLE "LinkedInAnalyticsImport" ADD CONSTRAINT "LinkedInAnalyticsImport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LinkedInAnalyticsDailyMetric" ADD CONSTRAINT "LinkedInAnalyticsDailyMetric_importId_fkey" FOREIGN KEY ("importId") REFERENCES "LinkedInAnalyticsImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LinkedInAnalyticsPostMetric" ADD CONSTRAINT "LinkedInAnalyticsPostMetric_importId_fkey" FOREIGN KEY ("importId") REFERENCES "LinkedInAnalyticsImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LinkedInAnalyticsDemographic" ADD CONSTRAINT "LinkedInAnalyticsDemographic_importId_fkey" FOREIGN KEY ("importId") REFERENCES "LinkedInAnalyticsImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LinkedInProfileSnapshot" ADD CONSTRAINT "LinkedInProfileSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LinkedInAnalyticsInsight" ADD CONSTRAINT "LinkedInAnalyticsInsight_importId_fkey" FOREIGN KEY ("importId") REFERENCES "LinkedInAnalyticsImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
