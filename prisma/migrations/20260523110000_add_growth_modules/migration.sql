-- Growth modules: platform settings, promotions, promo redemptions, invite links.

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN "promotionCode" TEXT,
ADD COLUMN "inviteCode" TEXT;

-- CreateTable
CREATE TABLE "PlatformSetting" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'GLOBAL',
    "regionId" TEXT,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Promotion" (
    "id" TEXT NOT NULL,
    "regionId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "type" TEXT NOT NULL DEFAULT 'STRIPE_PROMO',
    "stripePromotionCodeId" TEXT,
    "stripeCouponId" TEXT,
    "extraTrialDays" INTEGER,
    "maxRedemptions" INTEGER,
    "redemptionCount" INTEGER NOT NULL DEFAULT 0,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionRedemption" (
    "id" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "regionId" TEXT,
    "subscriptionId" TEXT,
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromotionRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InviteLink" (
    "id" TEXT NOT NULL,
    "regionId" TEXT,
    "code" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "roleToAssign" "UserRole" NOT NULL DEFAULT 'USER',
    "email" TEXT,
    "maxUses" INTEGER,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "promoCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InviteLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InviteRedemption" (
    "id" TEXT NOT NULL,
    "inviteLinkId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InviteRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlatformSetting_scope_regionId_key_key" ON "PlatformSetting"("scope", "regionId", "key");
CREATE INDEX "PlatformSetting_regionId_idx" ON "PlatformSetting"("regionId");
CREATE INDEX "PlatformSetting_key_idx" ON "PlatformSetting"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Promotion_code_regionId_key" ON "Promotion"("code", "regionId");
CREATE INDEX "Promotion_regionId_idx" ON "Promotion"("regionId");
CREATE INDEX "Promotion_code_idx" ON "Promotion"("code");
CREATE INDEX "Promotion_isActive_idx" ON "Promotion"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "PromotionRedemption_promotionId_userId_key" ON "PromotionRedemption"("promotionId", "userId");
CREATE INDEX "PromotionRedemption_userId_idx" ON "PromotionRedemption"("userId");
CREATE INDEX "PromotionRedemption_regionId_idx" ON "PromotionRedemption"("regionId");

-- CreateIndex
CREATE UNIQUE INDEX "InviteLink_code_key" ON "InviteLink"("code");
CREATE INDEX "InviteLink_regionId_idx" ON "InviteLink"("regionId");
CREATE INDEX "InviteLink_code_idx" ON "InviteLink"("code");
CREATE INDEX "InviteLink_isActive_idx" ON "InviteLink"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "InviteRedemption_inviteLinkId_userId_key" ON "InviteRedemption"("inviteLinkId", "userId");
CREATE INDEX "InviteRedemption_userId_idx" ON "InviteRedemption"("userId");

-- AddForeignKey
ALTER TABLE "PlatformSetting" ADD CONSTRAINT "PlatformSetting_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PromotionRedemption" ADD CONSTRAINT "PromotionRedemption_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PromotionRedemption" ADD CONSTRAINT "PromotionRedemption_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PromotionRedemption" ADD CONSTRAINT "PromotionRedemption_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InviteLink" ADD CONSTRAINT "InviteLink_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InviteLink" ADD CONSTRAINT "InviteLink_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InviteRedemption" ADD CONSTRAINT "InviteRedemption_inviteLinkId_fkey" FOREIGN KEY ("inviteLinkId") REFERENCES "InviteLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InviteRedemption" ADD CONSTRAINT "InviteRedemption_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
