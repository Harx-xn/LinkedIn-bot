import crypto from 'crypto';

export type CarouselExportPayload = {
  project: Record<string, unknown>;
  attributionRequired: boolean;
  filename: string;
};

type StoredExport = CarouselExportPayload & { expiresAt: number };
const exportsByToken = new Map<string, StoredExport>();
const TTL_MS = 2 * 60 * 1000;

function purgeExpired() {
  const now = Date.now();
  for (const [token, entry] of exportsByToken) if (entry.expiresAt <= now) exportsByToken.delete(token);
}

export function createCarouselExport(payload: CarouselExportPayload) {
  purgeExpired();
  const token = crypto.randomBytes(24).toString('base64url');
  exportsByToken.set(token, { ...payload, expiresAt: Date.now() + TTL_MS });
  return token;
}

export function getCarouselExport(token: string) {
  purgeExpired();
  return exportsByToken.get(token) || null;
}

export function deleteCarouselExport(token: string) {
  exportsByToken.delete(token);
}
