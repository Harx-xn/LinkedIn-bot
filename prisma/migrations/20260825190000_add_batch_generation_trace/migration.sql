ALTER TABLE "BotGenerationJob"
ADD COLUMN "batchTraceId" TEXT,
ADD COLUMN "generationTrace" JSONB,
ADD COLUMN "generationTraceVersion" INTEGER,
ADD COLUMN "generationTraceExpiresAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "BotGenerationJob_batchTraceId_key" ON "BotGenerationJob"("batchTraceId");
CREATE INDEX "BotGenerationJob_generationTraceExpiresAt_idx" ON "BotGenerationJob"("generationTraceExpiresAt");
