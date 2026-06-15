-- Social login: nullable passwords for OAuth-only users, provider accounts, OAuth state.
ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;

CREATE TABLE "AuthProviderAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthProviderAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OAuthState" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AuthProviderAccount_provider_providerAccountId_key" ON "AuthProviderAccount"("provider", "providerAccountId");
CREATE INDEX "AuthProviderAccount_userId_idx" ON "AuthProviderAccount"("userId");

ALTER TABLE "AuthProviderAccount" ADD CONSTRAINT "AuthProviderAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
