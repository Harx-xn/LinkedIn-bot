-- AlterTable
ALTER TABLE "BotGenerationJob" ADD COLUMN     "completedSlots" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "totalSlots" INTEGER NOT NULL DEFAULT 0;
