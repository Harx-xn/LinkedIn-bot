/*
  Warnings:

  - Added the required column `username` to the `User` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "LinkedInAccount" ADD COLUMN "selectedOrganizationUrn" TEXT;

-- AlterTable
ALTER TABLE "Post" ADD COLUMN "mediaUrl" TEXT;

-- AlterTable
ALTER TABLE "SheetConfig" ADD COLUMN "accessToken" TEXT;
ALTER TABLE "SheetConfig" ADD COLUMN "refreshToken" TEXT;

-- CreateTable
CREATE TABLE "BotConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "niches" TEXT NOT NULL,
    "sources" TEXT NOT NULL,
    "customRssFeeds" TEXT,
    "customLinks" TEXT,
    "customRedditFeeds" TEXT,
    "backgroundImageUrl" TEXT,
    "postingSchedule" TEXT,
    "postsPerWeek" INTEGER NOT NULL DEFAULT 7,
    "generationWindow" INTEGER NOT NULL DEFAULT 7,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "tone" TEXT DEFAULT 'Professional',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BotConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "linkedinClientId" TEXT,
    "linkedinClientSecret" TEXT,
    "googleClientId" TEXT,
    "googleClientSecret" TEXT
);
INSERT INTO "new_User" ("createdAt", "email", "id", "passwordHash", "updatedAt") SELECT "createdAt", "email", "id", "passwordHash", "updatedAt" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "BotConfig_userId_key" ON "BotConfig"("userId");
