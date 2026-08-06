ALTER TABLE "Plan" ADD COLUMN "carouselSaveLimit" INTEGER;
ALTER TABLE "Plan" ADD COLUMN "carouselAiGenerationLimit" INTEGER;

CREATE TABLE "CarouselAiGenerationUsage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "regionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CarouselAiGenerationUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CarouselAiGenerationUsage_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "CarouselAiGenerationUsage_userId_createdAt_idx" ON "CarouselAiGenerationUsage"("userId", "createdAt");
CREATE INDEX "CarouselAiGenerationUsage_regionId_createdAt_idx" ON "CarouselAiGenerationUsage"("regionId", "createdAt");

CREATE TABLE "CarouselProject" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "regionId" TEXT,
    "title" TEXT NOT NULL,
    "projectJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CarouselProject_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CarouselProject_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "CarouselProject_userId_updatedAt_idx" ON "CarouselProject"("userId", "updatedAt");
CREATE INDEX "CarouselProject_regionId_updatedAt_idx" ON "CarouselProject"("regionId", "updatedAt");
