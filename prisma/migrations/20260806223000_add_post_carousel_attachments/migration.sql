CREATE TYPE "PostAttachmentType" AS ENUM ('NONE', 'IMAGE', 'CAROUSEL');
CREATE TYPE "CarouselAttachmentStatus" AS ENUM ('CURRENT', 'OUTDATED', 'GENERATING', 'FAILED');

ALTER TABLE "Plan" ADD COLUMN "convertPostToCarouselEnabled" BOOLEAN NOT NULL DEFAULT false;
UPDATE "Plan"
SET "convertPostToCarouselEnabled" = true
WHERE LOWER("name") IN ('pro', 'ultimate')
   OR LOWER("code") ~ '(^|[_-])(pro|ultimate)([_-]|$)';

ALTER TABLE "Post"
ADD COLUMN "attachmentType" "PostAttachmentType" NOT NULL DEFAULT 'NONE',
ADD COLUMN "carouselProjectId" TEXT,
ADD COLUMN "carouselPdfUrl" TEXT,
ADD COLUMN "carouselFileName" TEXT,
ADD COLUMN "carouselUpdatedAt" TIMESTAMP(3),
ADD COLUMN "carouselAttachmentStatus" "CarouselAttachmentStatus";

UPDATE "Post" SET "attachmentType" = 'IMAGE' WHERE "mediaUrl" IS NOT NULL;

CREATE INDEX "Post_carouselProjectId_idx" ON "Post"("carouselProjectId");
ALTER TABLE "Post" ADD CONSTRAINT "Post_carouselProjectId_fkey" FOREIGN KEY ("carouselProjectId") REFERENCES "CarouselProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;
