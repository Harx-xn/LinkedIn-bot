import { UserRole } from '@prisma/client';
import { prisma } from '../prismaClient';

// Normalize any billing cycle to a per-month amount (for MRR).
export function monthlyAmount(price: number, cycle?: string | null): number {
  const c = (cycle || 'monthly').toLowerCase();
  if (c.startsWith('year') || c === 'annual' || c === 'annually') return price / 12;
  if (c.startsWith('quarter')) return price / 3;
  if (c.startsWith('week')) return (price * 52) / 12;
  if (c.startsWith('day') || c === 'daily') return (price * 365) / 12;
  return price; // monthly / default
}

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Build an ordered list of the last N month keys (oldest first).
function lastMonths(n: number): string[] {
  const keys: string[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    keys.push(monthKey(d));
  }
  return keys;
}

type Scope = { regionId?: string };

function userWhere(scope: Scope) {
  return scope.regionId ? { regionId: scope.regionId } : {};
}

// Headline counts + current revenue.
export async function getOverview(scope: Scope) {
  const baseUserWhere = userWhere(scope);

  const [totalUsers, activeUsers, clients, subAdmins, regions, posts, publishedPosts] =
    await Promise.all([
      prisma.user.count({ where: baseUserWhere }),
      prisma.user.count({ where: { ...baseUserWhere, isActive: true } }),
      prisma.user.count({ where: { ...baseUserWhere, role: UserRole.USER } }),
      prisma.user.count({ where: { ...baseUserWhere, role: UserRole.REGIONAL_ADMIN } }),
      scope.regionId ? Promise.resolve(1) : prisma.region.count(),
      prisma.post.count({ where: scope.regionId ? { regionId: scope.regionId } : {} }),
      prisma.post.count({
        where: { status: 'PUBLISHED', ...(scope.regionId ? { regionId: scope.regionId } : {}) },
      }),
    ]);

  const activeSubs = await prisma.subscription.findMany({
    where: { status: 'ACTIVE', ...(scope.regionId ? { regionId: scope.regionId } : {}) },
    include: { plan: true },
  });

  let mrr = 0;
  for (const s of activeSubs) {
    if (s.plan) mrr += monthlyAmount(s.plan.price, s.plan.billingCycle);
  }
  mrr = Math.round(mrr * 100) / 100;

  return {
    totalUsers,
    activeUsers,
    clients,
    subAdmins,
    regions,
    totalPosts: posts,
    publishedPosts,
    activeSubscriptions: activeSubs.length,
    mrr,
    arr: Math.round(mrr * 12 * 100) / 100,
  };
}

// Signups per month over the last `months`.
export async function getGrowthSeries(scope: Scope, months = 12) {
  const since = new Date();
  since.setMonth(since.getMonth() - (months - 1));
  since.setDate(1);
  since.setHours(0, 0, 0, 0);

  const users = await prisma.user.findMany({
    where: { ...userWhere(scope), createdAt: { gte: since } },
    select: { createdAt: true },
  });

  const buckets: Record<string, number> = {};
  for (const k of lastMonths(months)) buckets[k] = 0;
  for (const u of users) {
    const k = monthKey(u.createdAt);
    if (k in buckets) buckets[k] += 1;
  }

  return lastMonths(months).map((month) => ({ month, signups: buckets[month] }));
}

// New-subscription revenue (normalized monthly) per month over last `months`.
export async function getRevenueSeries(scope: Scope, months = 12) {
  const since = new Date();
  since.setMonth(since.getMonth() - (months - 1));
  since.setDate(1);
  since.setHours(0, 0, 0, 0);

  const subs = await prisma.subscription.findMany({
    where: {
      ...(scope.regionId ? { regionId: scope.regionId } : {}),
      startsAt: { gte: since },
    },
    include: { plan: true },
  });

  const buckets: Record<string, number> = {};
  for (const k of lastMonths(months)) buckets[k] = 0;
  for (const s of subs) {
    const k = monthKey(s.startsAt);
    if (k in buckets && s.plan) buckets[k] += monthlyAmount(s.plan.price, s.plan.billingCycle);
  }

  return lastMonths(months).map((month) => ({
    month,
    revenue: Math.round(buckets[month] * 100) / 100,
  }));
}

// Active subscriptions grouped by plan.
export async function getPlanBreakdown(scope: Scope) {
  const subs = await prisma.subscription.findMany({
    where: { status: 'ACTIVE', ...(scope.regionId ? { regionId: scope.regionId } : {}) },
    include: { plan: true },
  });

  const map: Record<string, { planName: string; count: number; mrr: number }> = {};
  for (const s of subs) {
    const name = s.plan?.name || 'Unknown';
    if (!map[name]) map[name] = { planName: name, count: 0, mrr: 0 };
    map[name].count += 1;
    if (s.plan) map[name].mrr += monthlyAmount(s.plan.price, s.plan.billingCycle);
  }

  return Object.values(map).map((p) => ({ ...p, mrr: Math.round(p.mrr * 100) / 100 }));
}

// Per-sub-admin rollups (super-admin only): clients, MRR, posts per region.
export async function getSubAdminRollups() {
  const regions = await prisma.region.findMany({
    select: {
      id: true,
      name: true,
      code: true,
      users: { where: { role: UserRole.REGIONAL_ADMIN }, select: { email: true, username: true } },
      _count: { select: { posts: true } },
    },
  });

  const result = [];
  for (const r of regions) {
    const [clientCount, activeSubs] = await Promise.all([
      prisma.user.count({ where: { regionId: r.id, role: UserRole.USER } }),
      prisma.subscription.findMany({
        where: { regionId: r.id, status: 'ACTIVE' },
        include: { plan: true },
      }),
    ]);

    let mrr = 0;
    for (const s of activeSubs) if (s.plan) mrr += monthlyAmount(s.plan.price, s.plan.billingCycle);

    result.push({
      regionId: r.id,
      regionName: r.name,
      regionCode: r.code,
      subAdmin: r.users[0] || null,
      clients: clientCount,
      activeSubscriptions: activeSubs.length,
      posts: r._count.posts,
      mrr: Math.round(mrr * 100) / 100,
    });
  }

  return result.sort((a, b) => b.mrr - a.mrr);
}

// Post/bot activity breakdown by status.
export async function getActivity(scope: Scope) {
  const grouped = await prisma.post.groupBy({
    by: ['status'],
    where: scope.regionId ? { regionId: scope.regionId } : {},
    _count: { _all: true },
  });

  return grouped.map((g) => ({ status: g.status, count: g._count._all }));
}
