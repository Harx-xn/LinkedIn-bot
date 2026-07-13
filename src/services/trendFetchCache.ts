import type { Trend } from './trendsService';

export const TREND_CACHE_TTL_SECONDS = {
  google: 15 * 60,
  medium: 60 * 60,
  linkedin: 30 * 60,
  reddit: 15 * 60,
  quora: 30 * 60,
} as const;

type CacheEntry = {
  trends: Trend[];
  expiresAt: number;
  staleAt: number;
};

const cache = new Map<string, CacheEntry>();
const inFlightFetches = new Map<string, Promise<Trend[]>>();
const refreshingKeys = new Set<string>();

export type TrendCacheStats = {
  hits: number;
  misses: number;
};

const stats: TrendCacheStats = { hits: 0, misses: 0 };

export function resetTrendCacheStats(): void {
  stats.hits = 0;
  stats.misses = 0;
}

export function getTrendCacheStats(): TrendCacheStats {
  return { ...stats };
}

export function buildTrendCacheKey(input: {
  source: string;
  query: string;
  freshness?: string;
}): string {
  const normalizedQuery = input.query.toLowerCase().trim().replace(/\s+/g, ' ');
  return ['trend', input.source, input.freshness ?? 'default', normalizedQuery].join(':');
}

function ttlForSource(source: string): number {
  const key = source.toLowerCase();
  
  if (key in TREND_CACHE_TTL_SECONDS) {
    return TREND_CACHE_TTL_SECONDS[key as keyof typeof TREND_CACHE_TTL_SECONDS] * 1000;
  }
  return 15 * 60 * 1000;
}

function getFreshEntry(key: string): Trend[] | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) return null;
  stats.hits += 1;
  return entry.trends;
}

function scheduleStaleRefresh(key: string, fetcher: () => Promise<Trend[]>, source: string): void {
  const entry = cache.get(key);
  if (!entry || Date.now() < entry.staleAt || refreshingKeys.has(key)) return;
  refreshingKeys.add(key);
  void fetcher()
    .then((trends) => {
      const ttl = ttlForSource(source);
      const now = Date.now();
      cache.set(key, {
        trends,
        expiresAt: now + ttl,
        staleAt: now + Math.floor(ttl * 0.75),
      });
    })
    .catch(() => {
      // keep stale entry
    })
    .finally(() => {
      refreshingKeys.delete(key);
    });
}

export async function fetchTrendsWithCache(
  key: string,
  source: string,
  fetcher: () => Promise<Trend[]>,
): Promise<Trend[]> {
  const fresh = getFreshEntry(key);
  if (fresh) return fresh;

  const entry = cache.get(key);
  if (entry && Date.now() <= entry.expiresAt) {
    stats.hits += 1;
    scheduleStaleRefresh(key, fetcher, source);
    return entry.trends;
  }

  return fetchWithCoalescing(key, source, fetcher);
}

async function fetchWithCoalescing(
  key: string,
  source: string,
  fetcher: () => Promise<Trend[]>,
): Promise<Trend[]> {
  const existing = inFlightFetches.get(key);
  if (existing) {
    stats.hits += 1;
    return existing;
  }

  stats.misses += 1;
  const pending = fetcher()
    .then((trends) => {
      const ttl = ttlForSource(source);
      const now = Date.now();
      cache.set(key, {
        trends,
        expiresAt: now + ttl,
        staleAt: now + Math.floor(ttl * 0.75),
      });
      return trends;
    })
    .finally(() => {
      inFlightFetches.delete(key);
    });

  inFlightFetches.set(key, pending);
  return pending;
}

export function clearTrendFetchCache(): void {
  cache.clear();
  inFlightFetches.clear();
  refreshingKeys.clear();
}
