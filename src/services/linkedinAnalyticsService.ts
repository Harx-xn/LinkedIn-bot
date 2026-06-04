import axios from 'axios';
import { prisma } from '../prismaClient';
import { getRegionLinkedInCreds } from './linkedinService';

/**
 * Real LinkedIn post analytics.
 *
 * This module calls LinkedIn's Community Management API to retrieve REAL post
 * statistics for the authenticated member (or an organization page they admin):
 *
 *   - Member posts:       GET /rest/memberCreatorPostAnalytics   (scope: r_member_postAnalytics, API >= 202506)
 *   - Organization posts: GET /rest/organizationalEntityShareStatistics (scope: r_organization_social)
 *
 * IMPORTANT: These endpoints require your LinkedIn app to be APPROVED for the
 * Community Management API product. Until that approval is granted (and the user
 * has re-consented with the new scopes), every call here will fail with 401/403.
 * That is expected — every function is wrapped so that ANY failure returns null,
 * and the dashboard falls back to deterministic estimates. Nothing breaks.
 *
 * NOTE: The exact Rest.li request encoding (especially dateRange) cannot be
 * verified without approved access, so the request builders below are
 * best-effort and defensively parsed. Once approval lands, validate the live
 * response shape and adjust the field paths in `parse*` helpers if needed.
 */

const REST_BASE = 'https://api.linkedin.com/rest';

// Metrics exposed by memberCreatorPostAnalytics.
type MemberMetric = 'IMPRESSION' | 'MEMBERS_REACHED' | 'REACTION' | 'COMMENT' | 'RESHARE';

export type LiveAccountAnalytics = {
  source: 'member' | 'organization';
  totals: {
    impressions: number;
    reach: number;
    reactions: number;
    comments: number;
    reshares: number;
  };
  // Daily series keyed by YYYY-MM-DD (impressions/reach/engagement only).
  daily: Map<string, { impressions: number; reach: number; engagement: number }>;
};

type CacheEntry = { at: number; data: LiveAccountAnalytics | null };
const cache = new Map<string, CacheEntry>();
const TTL_MS = 30 * 60 * 1000; // 30 minutes

// Remember which accounts have already failed (e.g. not approved) so we don't
// spam LinkedIn or the logs on every dashboard load.
const knownUnavailable = new Set<string>();

export function invalidateAnalyticsCache(userId: string) {
  for (const key of cache.keys()) {
    if (key.startsWith(`${userId}:`)) cache.delete(key);
  }
  knownUnavailable.delete(userId);
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// Rest.li time range tuple using epoch milliseconds.
function timeRangeParam(startMs: number, endMs: number): string {
  return `(start:${startMs},end:${endMs})`;
}

function headers(accessToken: string, apiVersion: string) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'X-Restli-Protocol-Version': '2.0.0',
    'LinkedIn-Version': apiVersion,
  };
}

// ---------------------------------------------------------------------------
// Member post analytics (memberCreatorPostAnalytics)
// ---------------------------------------------------------------------------

// MEMBERS_REACHED does not support DAILY aggregation, so we request it as TOTAL.
async function fetchMemberMetric(
  accessToken: string,
  apiVersion: string,
  metric: MemberMetric,
  startMs: number,
  endMs: number,
): Promise<{ total: number; daily: Map<string, number> }> {
  const aggregation = metric === 'MEMBERS_REACHED' ? 'TOTAL' : 'DAILY';
  const url =
    `${REST_BASE}/memberCreatorPostAnalytics?q=me` +
    `&queryType=${metric}` +
    `&aggregation=${aggregation}` +
    `&dateRange=${timeRangeParam(startMs, endMs)}`;

  const { data } = await axios.get(url, { headers: headers(accessToken, apiVersion), timeout: 15000 });

  // The response is a list of elements. Each element typically carries a count
  // and (for DAILY) a timeRange. Defensive parsing across known shapes.
  const elements: any[] = data?.elements ?? data?.data ?? [];
  const daily = new Map<string, number>();
  let total = 0;

  for (const el of elements) {
    const count = Number(
      el?.count ?? el?.value ?? el?.metricValue ?? el?.aggregatedValue ?? 0,
    );
    if (!Number.isFinite(count)) continue;
    total += count;

    const start = el?.timeRange?.start ?? el?.dateRange?.start ?? el?.start;
    if (aggregation === 'DAILY' && typeof start === 'number') {
      daily.set(dayKey(start), count);
    }
  }

  // Some shapes return a single aggregate object instead of a list.
  if (elements.length === 0) {
    const single = Number(data?.count ?? data?.value ?? 0);
    if (Number.isFinite(single)) total = single;
  }

  return { total, daily };
}

async function fetchMemberAnalytics(
  accessToken: string,
  apiVersion: string,
  startMs: number,
  endMs: number,
): Promise<LiveAccountAnalytics> {
  const [impression, reach, reaction, comment, reshare] = await Promise.all([
    fetchMemberMetric(accessToken, apiVersion, 'IMPRESSION', startMs, endMs),
    fetchMemberMetric(accessToken, apiVersion, 'MEMBERS_REACHED', startMs, endMs),
    fetchMemberMetric(accessToken, apiVersion, 'REACTION', startMs, endMs),
    fetchMemberMetric(accessToken, apiVersion, 'COMMENT', startMs, endMs),
    fetchMemberMetric(accessToken, apiVersion, 'RESHARE', startMs, endMs),
  ]);

  // Build a daily impressions/reach/engagement series. Reach is only available
  // as a total, so distribute it proportionally to daily impressions.
  const daily = new Map<string, { impressions: number; reach: number; engagement: number }>();
  const totalImpr = impression.total || 0;

  const dates = new Set<string>([
    ...impression.daily.keys(),
    ...reaction.daily.keys(),
    ...comment.daily.keys(),
    ...reshare.daily.keys(),
  ]);

  for (const d of dates) {
    const impr = impression.daily.get(d) || 0;
    const eng = (reaction.daily.get(d) || 0) + (comment.daily.get(d) || 0) + (reshare.daily.get(d) || 0);
    const reachShare = totalImpr > 0 ? Math.round((impr / totalImpr) * reach.total) : 0;
    daily.set(d, { impressions: impr, reach: reachShare, engagement: eng });
  }

  return {
    source: 'member',
    totals: {
      impressions: impression.total,
      reach: reach.total,
      reactions: reaction.total,
      comments: comment.total,
      reshares: reshare.total,
    },
    daily,
  };
}

// ---------------------------------------------------------------------------
// Organization share statistics (organizationalEntityShareStatistics)
// ---------------------------------------------------------------------------

async function fetchOrganizationAnalytics(
  accessToken: string,
  apiVersion: string,
  orgUrn: string,
  startMs: number,
  endMs: number,
): Promise<LiveAccountAnalytics> {
  const url =
    `${REST_BASE}/organizationalEntityShareStatistics?q=organizationalEntity` +
    `&organizationalEntity=${encodeURIComponent(orgUrn)}` +
    `&timeIntervals=(timeRange:${timeRangeParam(startMs, endMs)},timeGranularityType:DAY)`;

  const { data } = await axios.get(url, { headers: headers(accessToken, apiVersion), timeout: 15000 });

  const elements: any[] = data?.elements ?? [];
  const daily = new Map<string, { impressions: number; reach: number; engagement: number }>();
  const totals = { impressions: 0, reach: 0, reactions: 0, comments: 0, reshares: 0 };

  for (const el of elements) {
    const s = el?.totalShareStatistics ?? el?.shareStatistics ?? {};
    const impressions = Number(s.impressionCount ?? 0);
    const reach = Number(s.uniqueImpressionsCount ?? s.impressionCount ?? 0);
    const reactions = Number(s.likeCount ?? 0);
    const comments = Number(s.commentCount ?? 0);
    const reshares = Number(s.shareCount ?? 0);

    totals.impressions += impressions;
    totals.reach += reach;
    totals.reactions += reactions;
    totals.comments += comments;
    totals.reshares += reshares;

    const start = el?.timeRange?.start;
    if (typeof start === 'number') {
      daily.set(dayKey(start), {
        impressions,
        reach,
        engagement: reactions + comments + reshares,
      });
    }
  }

  return { source: 'organization', totals, daily };
}

// ---------------------------------------------------------------------------
// Public entry point used by the dashboard.
// ---------------------------------------------------------------------------

/**
 * Returns REAL analytics for the user's connected LinkedIn account, or null if
 * unavailable (no account, expired token, app not approved for the Community
 * Management API, or any error). Results are cached for `TTL_MS`.
 */
export async function getLiveAccountAnalytics(
  userId: string,
  sinceMs: number,
): Promise<LiveAccountAnalytics | null> {
  if (knownUnavailable.has(userId)) return null;

  const cacheKey = `${userId}:${dayKey(sinceMs)}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  let data: LiveAccountAnalytics | null = null;
  try {
    const account = await prisma.linkedInAccount.findFirst({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
    });

    // No connected account or an expired token -> no live data.
    if (!account || !account.accessToken) return cacheAndReturn(cacheKey, null);
    if (account.expiresAt && account.expiresAt.getTime() < Date.now()) {
      return cacheAndReturn(cacheKey, null);
    }

    const creds = await getRegionLinkedInCreds(userId);
    const apiVersion = creds.apiVersion;
    const endMs = Date.now();

    if (account.selectedOrganizationUrn) {
      data = await fetchOrganizationAnalytics(
        account.accessToken,
        apiVersion,
        account.selectedOrganizationUrn,
        sinceMs,
        endMs,
      );
    } else {
      data = await fetchMemberAnalytics(account.accessToken, apiVersion, sinceMs, endMs);
    }

    // Treat an all-zero response as "no usable data" so we keep estimates.
    if (data && data.totals.impressions === 0 && data.totals.reach === 0) {
      data = null;
    }
  } catch (err: any) {
    const status = err?.response?.status;
    // 401/403 almost always means "not approved / scope not granted yet".
    if (status === 401 || status === 403) {
      knownUnavailable.add(userId);
      console.warn(
        `[linkedinAnalytics] Live analytics unavailable for user ${userId} (HTTP ${status}). ` +
          `App likely not approved for Community Management API yet — using estimates.`,
      );
    } else {
      console.warn('[linkedinAnalytics] Failed to fetch live analytics:', err?.message || err);
    }
    data = null;
  }

  return cacheAndReturn(cacheKey, data);
}

function cacheAndReturn(key: string, data: LiveAccountAnalytics | null): LiveAccountAnalytics | null {
  cache.set(key, { at: Date.now(), data });
  return data;
}
