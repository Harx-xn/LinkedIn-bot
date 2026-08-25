ALTER TABLE "BotGenerationJob"
ADD COLUMN "heartbeatAt" TIMESTAMP(3);

CREATE INDEX "BotGenerationJob_status_heartbeatAt_idx"
ON "BotGenerationJob"("status", "heartbeatAt");
