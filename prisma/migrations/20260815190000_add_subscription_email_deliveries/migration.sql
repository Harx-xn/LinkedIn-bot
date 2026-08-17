CREATE TABLE "SubscriptionEmailDelivery" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "messageId" TEXT,
    "sentAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SubscriptionEmailDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SubscriptionEmailDelivery_subscriptionId_eventType_key"
ON "SubscriptionEmailDelivery"("subscriptionId", "eventType");
CREATE INDEX "SubscriptionEmailDelivery_userId_createdAt_idx"
ON "SubscriptionEmailDelivery"("userId", "createdAt");
CREATE INDEX "SubscriptionEmailDelivery_status_idx"
ON "SubscriptionEmailDelivery"("status");

ALTER TABLE "SubscriptionEmailDelivery"
ADD CONSTRAINT "SubscriptionEmailDelivery_subscriptionId_fkey"
FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubscriptionEmailDelivery"
ADD CONSTRAINT "SubscriptionEmailDelivery_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
