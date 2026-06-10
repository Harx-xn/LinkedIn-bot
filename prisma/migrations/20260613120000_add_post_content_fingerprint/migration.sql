-- CreateTable
CREATE TABLE "PostContentFingerprint" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "primaryTopic" TEXT NOT NULL,
    "subtopic" TEXT,
    "coreClaim" TEXT NOT NULL,
    "structure" TEXT,
    "hookType" TEXT,
    "evidenceType" TEXT,
    "ctaType" TEXT,
    "keywords" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostContentFingerprint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PostContentFingerprint_postId_key" ON "PostContentFingerprint"("postId");

-- CreateIndex
CREATE INDEX "PostContentFingerprint_userId_primaryTopic_idx" ON "PostContentFingerprint"("userId", "primaryTopic");

-- CreateIndex
CREATE INDEX "PostContentFingerprint_userId_createdAt_idx" ON "PostContentFingerprint"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "PostContentFingerprint" ADD CONSTRAINT "PostContentFingerprint_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostContentFingerprint" ADD CONSTRAINT "PostContentFingerprint_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
