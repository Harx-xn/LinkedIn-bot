ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "hasCompletedProfileOnboarding" BOOLEAN NOT NULL DEFAULT false;

-- Existing customers with a meaningful GhostWriter profile should not be
-- forced through the new post-signup onboarding page.
UPDATE "User" AS u
SET "hasCompletedProfileOnboarding" = true
WHERE EXISTS (
  SELECT 1
  FROM "BotConfig" AS b
  WHERE b."userId" = u.id
    AND length(trim(COALESCE(b.description, ''))) >= 20
    AND b.niches IS NOT NULL
    AND b.niches <> '[]'
);
