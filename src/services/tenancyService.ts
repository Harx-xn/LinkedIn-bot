import { UserRole } from '@prisma/client';

type CurrentUser = {
  id: string;
  role: UserRole;
  regionId: string | null;
};

export function getRegionWhere(currentUser: CurrentUser) {
  if (currentUser.role === 'SUPER_ADMIN') {
    return {};
  }

  if (!currentUser.regionId) {
    throw new Error('User has no region assigned');
  }

  return { regionId: currentUser.regionId };
}

export function assertSameRegion(currentUser: CurrentUser, targetRegionId: string | null | undefined) {
  if (currentUser.role === 'SUPER_ADMIN') {
    return true;
  }

  if (!currentUser.regionId || !targetRegionId) {
    throw new Error('Region mismatch');
  }

  if (currentUser.regionId !== targetRegionId) {
    throw new Error('Access denied for this region');
  }

  return true;
}

// Resolve the region a sub-admin action targets.
// REGIONAL_ADMIN -> their own region. SUPER_ADMIN -> must pass regionId.
export function resolveRegionId(
  currentUser: CurrentUser,
  explicitRegionId?: string | null
): string {
  if (currentUser.role === 'REGIONAL_ADMIN') {
    if (!currentUser.regionId) throw new Error('User has no region assigned');
    return currentUser.regionId;
  }

  if (currentUser.role === 'SUPER_ADMIN') {
    if (!explicitRegionId) throw new Error('regionId is required for super-admin');
    return explicitRegionId;
  }

  throw new Error('Forbidden');
}

export function maskSecret(value?: string | null): string | null {
  if (!value) return null;
  const tail = value.slice(-4);
  return `••••${tail}`;
}