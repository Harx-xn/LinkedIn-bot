import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { BillingAccessStatus, UserRole } from '@prisma/client';
import { prisma } from '../../prismaClient';
import { completeSocialAuth } from './socialAuthService';

const originals: Array<[object, string, unknown]> = [];
function replace(target: object, key: string, value: unknown) {
  originals.push([target, key, (target as any)[key]]);
  (target as any)[key] = value;
}

afterEach(() => {
  for (const [target, key, value] of originals.reverse()) (target as any)[key] = value;
});

describe('unified Google authentication', () => {
  const existingUser = {
    id: 'existing-user', email: 'existing@example.com', username: 'existing', role: UserRole.USER,
    isActive: true, regionId: 'region-1', trialEndsAt: null, isBillingExempt: false,
    hasCompletedProfileOnboarding: true, needsIdentityOnboarding: false,
    botConfigs: null, region: { id: 'region-1', name: 'Pakistan', slug: 'pk', code: 'PK' },
  };

  it('logs in an existing provider-linked user without creating another account', async () => {
    let creates = 0;
    replace(prisma.authProviderAccount, 'findUnique', async () => ({ userId: existingUser.id }));
    replace(prisma.user, 'findUnique', async () => existingUser);
    replace(prisma.user, 'create', async () => { creates += 1; });

    const result = await completeSocialAuth('google', {
      providerAccountId: 'google-existing', email: existingUser.email, emailVerified: true,
    }, { mode: 'login', csrf: 'csrf' });

    assert.equal(result.isNewUser, false);
    assert.equal(result.user.id, existingUser.id);
    assert.equal(creates, 0);
  });

  it('links a matching verified email account instead of duplicating it', async () => {
    let linkedUserId: string | null = null;
    let creates = 0;
    replace(prisma.authProviderAccount, 'findUnique', async () => null);
    replace(prisma.authProviderAccount, 'upsert', async ({ create }: any) => {
      linkedUserId = create.userId;
      return create;
    });
    replace(prisma.user, 'findUnique', async ({ where }: any) => where.email ? { id: existingUser.id } : existingUser);
    replace(prisma.user, 'create', async () => { creates += 1; });

    const result = await completeSocialAuth('google', {
      providerAccountId: 'google-new-link', email: existingUser.email, emailVerified: true,
    }, { mode: 'register', csrf: 'csrf' });

    assert.equal(result.isNewUser, false);
    assert.equal(linkedUserId, existingUser.id);
    assert.equal(creates, 0);
  });

  it('creates a regionless onboarding account even when OAuth started in login mode', async () => {
    let createdData: Record<string, unknown> | null = null;
    let linkedUserId: string | null = null;
    replace(prisma.authProviderAccount, 'findUnique', async () => null);
    replace(prisma.authProviderAccount, 'upsert', async ({ create }: any) => {
      linkedUserId = create.userId;
      return create;
    });
    replace(prisma.user, 'findUnique', async () => null);
    replace(prisma.user, 'create', async ({ data }: any) => {
      createdData = data;
      return {
        id: 'google-user-1', email: data.email, username: 'new.google', role: UserRole.USER,
        isActive: true, regionId: null, trialEndsAt: null, isBillingExempt: false,
        hasCompletedProfileOnboarding: false, needsIdentityOnboarding: true,
        botConfigs: null, region: null,
      };
    });

    const result = await completeSocialAuth('google', {
      providerAccountId: 'google-123', email: 'new.google@example.com', emailVerified: true,
    }, { mode: 'login', csrf: 'csrf' });

    assert.equal(result.isNewUser, true);
    assert.equal(result.user.regionId, null);
    assert.equal(result.user.needsIdentityOnboarding, true);
    const persisted = createdData as unknown as Record<string, unknown>;
    assert.equal(persisted.passwordHash, null);
    assert.equal(persisted.billingAccessStatus, BillingAccessStatus.BILLING_REQUIRED);
    assert.equal(persisted.regionId, null);
    assert.equal(persisted.needsIdentityOnboarding, true);
    assert.equal(linkedUserId, 'google-user-1');
  });

  it('rejects an unverified Google identity before account lookup', async () => {
    await assert.rejects(
      completeSocialAuth('google', {
        providerAccountId: 'google-123', email: 'unverified@example.com', emailVerified: false,
      }, { mode: 'login', csrf: 'csrf' }),
      /not verified/i,
    );
  });
});
