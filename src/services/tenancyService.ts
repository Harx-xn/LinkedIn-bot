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