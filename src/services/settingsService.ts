import { prisma } from '../prismaClient';

export async function getSetting<T = any>(key: string, regionId?: string | null, fallback?: T): Promise<T> {
  if (regionId) {
    const regional = await prisma.platformSetting.findFirst({
      where: { scope: 'REGION', regionId, key },
      select: { value: true },
    });
    if (regional) return regional.value as T;
  }

  const global = await prisma.platformSetting.findFirst({
    where: { scope: 'GLOBAL', regionId: null, key },
    select: { value: true },
  });

  return global ? (global.value as T) : (fallback as T);
}

export async function getNumberSetting(key: string, regionId?: string | null, fallback = 0): Promise<number> {
  const value = await getSetting<any>(key, regionId, fallback);
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export async function getBooleanSetting(key: string, regionId?: string | null, fallback = false): Promise<boolean> {
  const value = await getSetting<any>(key, regionId, fallback);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return ['true', '1', 'yes', 'on'].includes(value.toLowerCase());
  return Boolean(value);
}

export async function listPublicSettings(regionId?: string | null) {
  const keys = [
    'auth.inviteOnly',
    'billing.promoCodesEnabled',
    'trial.days',
    'trial.dailyPublishLimit',
    'ui.supportEmail',
  ];

  const values = await Promise.all(keys.map(async (key) => [key, await getSetting(key, regionId, null)]));
  return Object.fromEntries(values.filter(([, value]) => value !== null));
}
