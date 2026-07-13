import { createHash } from 'crypto';
import { NICHE_EXPANSION_PLAN_VERSION } from '../config/topicDiversityConfig';
import type { RankedTrendCandidate } from './generationTypes';

export type StoredTrendPreview = {
  id: string;
  userId: string;
  configHash: string;
  candidates: RankedTrendCandidate[];
  createdAt: Date;
  expiresAt: Date;
};

const PREVIEW_TTL_MS = 30 * 60 * 1000;
const store = new Map<string, StoredTrendPreview>();

export type TrendConfigHashInput = {
  niches: string[];
  sources: string[];
};

export function buildTrendConfigHash(input: TrendConfigHashInput): string {
  const payload = JSON.stringify({
    ...input,
    niches: [...input.niches].sort(),
    sources: [...input.sources].sort(),
    searchPlanVersion: NICHE_EXPANSION_PLAN_VERSION,
  });
  return createHash('sha256').update(payload).digest('hex');
}

function pruneExpired(): void {
  const now = Date.now();
  for (const [id, entry] of store) {
    if (entry.expiresAt.getTime() <= now) store.delete(id);
  }
}

export function saveTrendPreviewPool(params: {
  userId: string;
  configHash: string;
  candidates: RankedTrendCandidate[];
}): StoredTrendPreview {
  pruneExpired();
  const id = `tp_${createHash('sha256').update(`${params.userId}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 16)}`;
  const now = new Date();
  const entry: StoredTrendPreview = {
    id,
    userId: params.userId,
    configHash: params.configHash,
    candidates: params.candidates,
    createdAt: now,
    expiresAt: new Date(now.getTime() + PREVIEW_TTL_MS),
  };
  store.set(id, entry);
  return entry;
}

export function getTrendPreviewPool(
  previewId: string,
  userId: string,
  configHash: string,
): { ok: true; pool: StoredTrendPreview } | { ok: false; reason: string } {
  pruneExpired();
  const entry = store.get(previewId);
  if (!entry) return { ok: false, reason: 'preview_not_found' };
  if (entry.userId !== userId) return { ok: false, reason: 'preview_user_mismatch' };
  if (entry.expiresAt.getTime() <= Date.now()) {
    store.delete(previewId);
    return { ok: false, reason: 'preview_expired' };
  }
  if (entry.configHash !== configHash) return { ok: false, reason: 'preview_config_mismatch' };
  return { ok: true, pool: entry };
}

export function clearTrendPreviewPoolStore(): void {
  store.clear();
}
