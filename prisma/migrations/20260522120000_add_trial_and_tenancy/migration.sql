-- AlterTable
ALTER TABLE "Region" ADD COLUMN     "geminiApiKeys" TEXT,
ADD COLUMN     "linkedinApiVersion" TEXT DEFAULT '202511',
ADD COLUMN     "linkedinClientId" TEXT,
ADD COLUMN     "linkedinClientSecret" TEXT,
ADD COLUMN     "linkedinRedirectUri" TEXT,
ADD COLUMN     "openaiApiKey" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "trialEndsAt" TIMESTAMP(3),
ADD COLUMN     "trialStartedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PaymentConfig" (
    "id" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'MANUAL',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "stripePublishableKey" TEXT,
    "stripeSecretKey" TEXT,
    "stripeWebhookSecret" TEXT,
    "paypalClientId" TEXT,
    "paypalClientSecret" TEXT,
    "paypalMode" TEXT DEFAULT 'sandbox',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentConfig_regionId_key" ON "PaymentConfig"("regionId");

-- AddForeignKey
ALTER TABLE "PaymentConfig" ADD CONSTRAINT "PaymentConfig_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE CASCADE ON UPDATE CASCADE;

