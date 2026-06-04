import { prisma } from '../prismaClient';
import { getEntitlement } from './entitlementService';
import { getLiveAccountAnalytics, LiveAccountAnalytics } from './linkedinAnalyticsService';

/**
 * LinkedIn Growth Dashboard service.
 *
 * COMPLIANCE NOTE:
 * This module never scrapes arbitrary LinkedIn profiles, public posts, or feeds.
 * It only uses:
 *   - the authenticated user's own local posts stored in our database
 *   - the authenticated user's connected LinkedIn account (existence/metadata only)
 *   - locally generated creator inspiration / watchlist-style suggestions
 *
 * When live LinkedIn statistics are not available, analytics are produced as
 * DETERMINISTIC estimates derived from the user's own post content/id/media/date
 * so the same inputs always yield the same numbers (no per-request randomness).
 */

export type LinkedInGrowthDashboardResponse = {
  isTrial: boolean;

  // Whether the analytics numbers are deterministic estimates (true) or real
  // LinkedIn stats fetched from the Community Management API (false).
  isEstimated: boolean;
  dataSource: 'live' | 'estimated';

  connectedAccount?: {
    name: string;
    type: 'member' | 'organization';
  };

  dateRange: {
    from: string;
    to: string;
  };

  analytics: {
    kpis: {
      totalPosts: number;
      totalImpressions: number;
      totalReach: number;
      totalEngagement: number;
      averageEngagementRate: number;
      averageCommentsPerPost: number;
      bestPostingDay: string;
      bestPostingHour: number;
      bestContentType: string;
    };

    scores: {
      reachScore: number;
      engagementScore: number;
      consistencyScore: number;
      conversationScore: number;
      shareabilityScore: number;
      contentQualityScore: number;
    };

    charts: {
      performanceOverTime: Array<{
        date: string;
        impressions: number;
        reach: number;
        engagement: number;
      }>;

      engagementBreakdown: Array<{
        postId: string;
        label: string;
        reactions: number;
        comments: number;
        reshares: number;
      }>;

      bestTimes: Array<{
        day: string;
        hour: number;
        averageEngagementRate: number;
        averageReach: number;
      }>;

      contentTypePerformance: Array<{
        mediaType: string;
        averageEngagementRate: number;
        averageImpressions: number;
        postCount: number;
      }>;
    };
  };

  interactionOpportunities: Array<{
    id: string;
    authorName: string;
    authorHeadline?: string;
    postText: string;
    postUrl?: string;
    postedAt: string;
    reason: string;
    suggestedAction: 'comment' | 'like' | 'reshare' | 'save';
    suggestedComment?: string;
    relevanceScore: number;
    urgencyScore: number;
    relationshipScore: number;
  }>;

  topCreators: Array<{
    id: string;
    name: string;
    profileUrl?: string;
    niche: string;
    reasonToFollow: string;
    contentThemes: string[];
    postStyle: string;
    suggestedUserAction: string;
    relevanceScore: number;
  }>;

  insights: Array<{
    title: string;
    description: string;
    severity: 'positive' | 'neutral' | 'warning';
  }>;

  locked: {
    fullPlan: boolean;
    creatorDeepAnalysis: boolean;
    advancedInteractionQueue: boolean;
  };
};

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_MS = 86_400_000;
const WINDOW_DAYS = 90;

const REACH_BASELINE = 2500; // baseline avg impressions that maps to a strong reach score
const ENGAGEMENT_RATE_BASELINE = 7; // % engagement rate that maps to a strong engagement score

type MediaType = 'image' | 'poll' | 'document' | 'video' | 'article' | 'text';

type PostMetrics = {
  id: string;
  label: string;
  publishedAt: Date;
  mediaType: MediaType;
  impressions: number;
  reach: number;
  reactions: number;
  comments: number;
  reshares: number;
  engagement: number;
  engagementRate: number; // %
  qualityScore: number; // 0-100
};

// ---------------------------------------------------------------------------
// Deterministic helpers (no Math.random anywhere in this file).
// ---------------------------------------------------------------------------

// FNV-1a style 32-bit hash -> always positive integer for a given string.
function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Map a hash + salt deterministically into an inclusive [min, max] integer range.
function rangeFromHash(hash: number, salt: number, min: number, max: number): number {
  if (max <= min) return min;
  const mixed = (hash ^ Math.imul(salt + 1, 2654435761)) >>> 0;
  return min + (mixed % (max - min + 1));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, decimals = 0): number {
  const f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Media type detection (per product spec, evaluated in priority order).
// ---------------------------------------------------------------------------

function detectMediaType(content: string, mediaUrl: string | null): MediaType {
  const text = (content || '').toLowerCase();

  if (mediaUrl) return 'image';
  if (text.includes('poll:') || text.includes('[poll]')) return 'poll';
  if (text.includes('document') || text.includes('carousel')) return 'document';
  if (text.includes('video')) return 'video';
  if (text.includes('http://') || text.includes('https://')) return 'article';
  return 'text';
}

const MEDIA_REACH_MULTIPLIER: Record<MediaType, number> = {
  video: 1.4,
  document: 1.3,
  poll: 1.25,
  image: 1.2,
  text: 1.0,
  article: 0.9,
};

// ---------------------------------------------------------------------------
// Per-post deterministic quality + estimated metrics.
// ---------------------------------------------------------------------------

function scoreContentQuality(content: string, mediaType: MediaType): number {
  const text = content || '';
  const lower = text.toLowerCase();
  const length = text.length;
  let score = 0;

  // Length: 400-1600 chars is the sweet spot for LinkedIn long-form.
  if (length >= 400 && length <= 1600) score += 25;
  else if (length >= 150) score += 15;
  else score += 5;

  // Hook / question in the opening line.
  const firstLine = text.split('\n')[0] || '';
  if (firstLine.includes('?') || (firstLine.length > 0 && firstLine.length <= 90)) score += 15;
  if (text.includes('?')) score += 5;

  // Call to action.
  if (/(comment|share|follow|repost|reshare|dm|sign ?up|join|subscribe|link in)/i.test(lower)) {
    score += 15;
  }

  // List / structured formatting.
  if (/(\n\s*[-•*\d]|\n\d+\.)/.test(text)) score += 15;

  // Personal / story-driven language.
  if (/(^|\s)(i|i'm|i've|my|me|we|our)\b/i.test(lower)) score += 15;

  // Rich media bonus.
  if (mediaType !== 'text') score += 10;

  return clamp(round(score), 0, 100);
}

function buildPostMetrics(post: {
  id: string;
  content: string;
  mediaUrl: string | null;
  publishedAt: Date;
}): PostMetrics {
  const mediaType = detectMediaType(post.content, post.mediaUrl);
  const seed = hashString(
    `${post.id}|${(post.content || '').slice(0, 120)}|${post.mediaUrl || ''}|${post.publishedAt.toISOString()}`,
  );

  const mediaMultiplier = MEDIA_REACH_MULTIPLIER[mediaType];
  const qualityScore = scoreContentQuality(post.content, mediaType);

  // Impressions: deterministic base 800-5800, scaled by media type + quality.
  const baseImpressions = rangeFromHash(seed, 1, 800, 5800);
  const qualityFactor = 0.7 + (qualityScore / 100) * 0.6; // 0.7x - 1.3x
  const impressions = Math.max(1, Math.round(baseImpressions * mediaMultiplier * qualityFactor));

  // Reach: 55%-85% of impressions.
  const reachRatio = 0.55 + rangeFromHash(seed, 2, 0, 30) / 100;
  const reach = Math.round(impressions * reachRatio);

  // Engagement rate: 2%-12%, nudged up by quality.
  const baseRate = 0.02 + rangeFromHash(seed, 3, 0, 100) / 1000; // 0.02 - 0.12
  const rate = clamp(baseRate + (qualityScore / 100) * 0.02, 0.01, 0.16);
  const engagement = Math.max(0, Math.round(impressions * rate));

  // Split engagement into comments / reshares / reactions deterministically.
  const commentRatio = 0.05 + rangeFromHash(seed, 4, 0, 20) / 100; // 5%-25%
  const reshareRatio = 0.02 + rangeFromHash(seed, 5, 0, 13) / 100; // 2%-15%
  const comments = Math.round(engagement * commentRatio);
  const reshares = Math.round(engagement * reshareRatio);
  const reactions = Math.max(0, engagement - comments - reshares);

  const totalEngagement = reactions + comments + reshares;
  const engagementRate = impressions > 0 ? (totalEngagement / impressions) * 100 : 0;

  const label = (post.content || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48) || 'Untitled post';

  return {
    id: post.id,
    label,
    publishedAt: post.publishedAt,
    mediaType,
    impressions,
    reach,
    reactions,
    comments,
    reshares,
    engagement: totalEngagement,
    engagementRate,
    qualityScore,
  };
}

// Scale estimated per-post metrics so their sums match real LinkedIn totals,
// preserving each post's relative share. Mutates the provided metrics in place.
function calibrateMetricsToTotals(
  metrics: PostMetrics[],
  totals: { impressions: number; reach: number; reactions: number; comments: number; reshares: number },
): void {
  if (metrics.length === 0) return;

  const estTotals = {
    impressions: metrics.reduce((s, m) => s + m.impressions, 0),
    reach: metrics.reduce((s, m) => s + m.reach, 0),
    reactions: metrics.reduce((s, m) => s + m.reactions, 0),
    comments: metrics.reduce((s, m) => s + m.comments, 0),
    reshares: metrics.reduce((s, m) => s + m.reshares, 0),
  };

  const factor = (real: number, est: number) => (est > 0 ? real / est : 0);
  const fImpr = factor(totals.impressions, estTotals.impressions);
  const fReach = factor(totals.reach, estTotals.reach);
  const fReact = factor(totals.reactions, estTotals.reactions);
  const fComm = factor(totals.comments, estTotals.comments);
  const fRes = factor(totals.reshares, estTotals.reshares);

  for (const m of metrics) {
    m.impressions = Math.round(m.impressions * fImpr);
    m.reach = Math.round(m.reach * fReach);
    m.reactions = Math.round(m.reactions * fReact);
    m.comments = Math.round(m.comments * fComm);
    m.reshares = Math.round(m.reshares * fRes);
    m.engagement = m.reactions + m.comments + m.reshares;
    m.engagementRate = m.impressions > 0 ? (m.engagement / m.impressions) * 100 : 0;
  }
}

// ---------------------------------------------------------------------------
// Niche / theme derivation from the user's own data.
// ---------------------------------------------------------------------------

function parseNiches(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((n) => String(n)).filter(Boolean);
    if (typeof parsed === 'string' && parsed.trim()) return [parsed.trim()];
  } catch {
    if (raw.trim()) return [raw.trim()];
  }
  return [];
}

function deriveThemes(niches: string[], bestContentType: string): string[] {
  const fallback = ['LinkedIn growth', 'content systems', 'automation', 'personal branding', 'B2B SaaS'];
  const base = niches.length ? niches : fallback;
  const themes = Array.from(new Set(base.map((t) => t.trim()).filter(Boolean)));
  if (bestContentType && bestContentType !== 'none') themes.push(`${bestContentType} content`);
  return themes.slice(0, 6);
}

// ---------------------------------------------------------------------------
// Interaction opportunities (locally generated; NOT scraped).
// ---------------------------------------------------------------------------

type OpportunitySeed = {
  authorName: string;
  authorHeadline: string;
  topic: string;
  suggestedAction: 'comment' | 'like' | 'reshare' | 'save';
  suggestedComment?: string;
};

function buildInteractionOpportunities(
  userId: string,
  themes: string[],
  bestContentType: string,
  limit: number,
): LinkedInGrowthDashboardResponse['interactionOpportunities'] {
  const primaryTheme = themes[0] || 'LinkedIn growth';
  const secondaryTheme = themes[1] || 'content systems';

  const pool: OpportunitySeed[] = [
    {
      authorName: 'Creator in your niche',
      authorHeadline: 'LinkedIn growth / automation / SaaS',
      topic: `a post about ${primaryTheme} and staying consistent with content`,
      suggestedAction: 'comment',
      suggestedComment: `Really resonated with this. We've seen the same thing with ${primaryTheme} — consistency beats intensity every time. What helped you stay on schedule?`,
    },
    {
      authorName: 'Peer building in public',
      authorHeadline: 'Founder sharing the SaaS journey',
      topic: `a build-in-public update touching on ${secondaryTheme}`,
      suggestedAction: 'comment',
      suggestedComment: `Love the transparency here. The point about ${secondaryTheme} is underrated — congrats on the progress.`,
    },
    {
      authorName: 'Voice in automation',
      authorHeadline: 'Automation educator / no-code & workflows',
      topic: 'a breakdown of how automation saves hours each week',
      suggestedAction: 'reshare',
      suggestedComment: `Sharing this with my audience — a great breakdown of how automation compounds over time.`,
    },
    {
      authorName: 'Content strategist',
      authorHeadline: 'LinkedIn growth strategist',
      topic: `a framework for repurposing one idea into multiple ${bestContentType} posts`,
      suggestedAction: 'save',
    },
    {
      authorName: 'B2B sales creator',
      authorHeadline: 'B2B sales & pipeline content',
      topic: 'a post on turning content engagement into conversations',
      suggestedAction: 'comment',
      suggestedComment: `This matches what we're seeing — engagement only matters if it turns into real conversations. Great reminder.`,
    },
    {
      authorName: 'Personal brand builder',
      authorHeadline: 'Helping founders build a personal brand',
      topic: `a story-driven post about lessons learned in ${primaryTheme}`,
      suggestedAction: 'like',
    },
    {
      authorName: 'SaaS founder creator',
      authorHeadline: 'Bootstrapping a SaaS in public',
      topic: 'a candid post about churn, retention, and product feedback',
      suggestedAction: 'comment',
      suggestedComment: `Appreciate the honesty. Curious how you prioritized which feedback to act on first?`,
    },
    {
      authorName: 'Thought leader in your space',
      authorHeadline: 'Writing about the future of work & tooling',
      topic: `a forward-looking take on where ${secondaryTheme} is heading`,
      suggestedAction: 'reshare',
      suggestedComment: `Strong perspective — resharing because the take on ${secondaryTheme} deserves more eyes.`,
    },
  ];

  const baseSeed = hashString(`opps|${userId}|${primaryTheme}`);

  return pool.slice(0, clamp(limit, 0, pool.length)).map((seedItem, i) => {
    const itemSeed = hashString(`${baseSeed}|${i}|${seedItem.authorName}`);
    const postedDaysAgo = rangeFromHash(itemSeed, 1, 0, 3);
    const postedAt = new Date(Date.now() - postedDaysAgo * DAY_MS).toISOString();

    return {
      id: `opp_${(itemSeed >>> 0).toString(36)}`,
      authorName: seedItem.authorName,
      authorHeadline: seedItem.authorHeadline,
      postText: `A post about ${seedItem.topic}. (Suggested interaction target — a recommended type of post to engage with, not scraped private LinkedIn data.)`,
      postedAt,
      reason:
        i === 0
          ? `This matches your strongest content pillar (${primaryTheme}). Engaging here puts you in front of an aligned audience. This is a recommended interaction type, not a scraped LinkedIn post.`
          : `This type of post aligns with your content themes (${themes.slice(0, 3).join(', ')}). It's a recommended interaction target rather than scraped private data.`,
      suggestedAction: seedItem.suggestedAction,
      suggestedComment: seedItem.suggestedComment,
      relevanceScore: rangeFromHash(itemSeed, 2, 72, 98),
      urgencyScore: rangeFromHash(itemSeed, 3, 45, 90),
      relationshipScore: rangeFromHash(itemSeed, 4, 40, 88),
    };
  });
}

// ---------------------------------------------------------------------------
// Top creators (locally generated inspiration categories; NOT fetched profiles).
// ---------------------------------------------------------------------------

function buildTopCreators(
  userId: string,
  themes: string[],
  limit: number,
): LinkedInGrowthDashboardResponse['topCreators'] {
  const t = (i: number) => themes[i % Math.max(1, themes.length)] || 'LinkedIn growth';

  const pool: Array<Omit<LinkedInGrowthDashboardResponse['topCreators'][number], 'id' | 'relevanceScore'>> = [
    {
      name: 'SaaS Founder Creator',
      niche: 'B2B SaaS / build-in-public',
      reasonToFollow: `Shares real metrics and lessons relevant to your focus on ${t(0)}.`,
      contentThemes: ['build in public', 'product', t(0)],
      postStyle: 'Candid story-driven updates with concrete numbers',
      suggestedUserAction: 'Study their hook structure and adapt it to your own launches.',
    },
    {
      name: 'LinkedIn Growth Strategist',
      niche: 'Personal branding & LinkedIn growth',
      reasonToFollow: 'Breaks down what makes posts perform, useful for sharpening your own content.',
      contentThemes: ['hooks', 'content systems', 'audience growth'],
      postStyle: 'Tactical carousels and frameworks',
      suggestedUserAction: 'Borrow one framework per week and test it on your audience.',
    },
    {
      name: 'Automation Educator',
      niche: 'Automation & no-code workflows',
      reasonToFollow: `Aligns with your automation themes (${t(1)}) and how to scale content output.`,
      contentThemes: ['automation', 'workflows', t(1)],
      postStyle: 'How-to breakdowns with step-by-step visuals',
      suggestedUserAction: 'Reshare one workflow idea and add your own take.',
    },
    {
      name: 'B2B Sales Creator',
      niche: 'B2B sales & social selling',
      reasonToFollow: 'Shows how to turn content engagement into pipeline conversations.',
      contentThemes: ['sales', 'pipeline', 'outreach'],
      postStyle: 'Short, opinionated takes with clear CTAs',
      suggestedUserAction: 'Mirror how they end posts with a conversation starter.',
    },
    {
      name: 'Personal Brand Builder',
      niche: 'Founder personal branding',
      reasonToFollow: 'Great example of consistent storytelling that builds trust over time.',
      contentThemes: ['storytelling', 'authority', 'consistency'],
      postStyle: 'Narrative posts with a personal angle',
      suggestedUserAction: 'Adopt their cadence of mixing personal stories with lessons.',
    },
    {
      name: 'Content Systems Coach',
      niche: 'Content operations & repurposing',
      reasonToFollow: `Helpful for scaling your strongest pillar (${t(0)}) without burning out.`,
      contentThemes: ['repurposing', 'batching', 'systems'],
      postStyle: 'Process-led posts and checklists',
      suggestedUserAction: 'Set up a repurposing system inspired by their templates.',
    },
    {
      name: 'Product Marketing Voice',
      niche: 'Product marketing & positioning',
      reasonToFollow: 'Useful for sharpening how you describe your product value.',
      contentThemes: ['positioning', 'messaging', 'launches'],
      postStyle: 'Clear teardowns and before/after examples',
      suggestedUserAction: 'Rewrite one of your posts using their positioning angle.',
    },
    {
      name: 'Data-Driven Marketer',
      niche: 'Growth & analytics',
      reasonToFollow: 'Shows how to read engagement data and act on it.',
      contentThemes: ['analytics', 'experiments', 'growth'],
      postStyle: 'Insight posts backed by charts',
      suggestedUserAction: 'Run one small content experiment per week and document it.',
    },
    {
      name: 'Community Builder',
      niche: 'Community & engagement',
      reasonToFollow: 'Models how to build genuine engagement instead of vanity metrics.',
      contentThemes: ['community', 'engagement', 'conversations'],
      postStyle: 'Question-led posts that invite replies',
      suggestedUserAction: 'Copy their habit of replying to every early comment.',
    },
    {
      name: 'Bootstrapper Creator',
      niche: 'Indie / bootstrapped founders',
      reasonToFollow: 'Relatable journey content that performs well with founder audiences.',
      contentThemes: ['bootstrapping', 'revenue', 'lessons'],
      postStyle: 'Milestone and lessons-learned posts',
      suggestedUserAction: 'Share your own milestone posts in a similar honest tone.',
    },
  ];

  const baseSeed = hashString(`creators|${userId}|${themes.join(',')}`);

  return pool.slice(0, clamp(limit, 0, pool.length)).map((c, i) => ({
    id: `creator_${((baseSeed ^ Math.imul(i + 1, 2654435761)) >>> 0).toString(36)}`,
    ...c,
    relevanceScore: rangeFromHash(baseSeed, i + 1, 70, 97),
  }));
}

// ---------------------------------------------------------------------------
// Empty-state dashboard (user has no published posts).
// ---------------------------------------------------------------------------

function emptyDashboard(params: {
  isTrial: boolean;
  locked: LinkedInGrowthDashboardResponse['locked'];
  connectedAccount?: LinkedInGrowthDashboardResponse['connectedAccount'];
  userId: string;
  themes: string[];
  oppLimit: number;
  creatorLimit: number;
}): LinkedInGrowthDashboardResponse {
  const to = new Date();
  const from = new Date(to.getTime() - WINDOW_DAYS * DAY_MS);

  return {
    isTrial: params.isTrial,
    isEstimated: true,
    dataSource: 'estimated',
    connectedAccount: params.connectedAccount,
    dateRange: { from: from.toISOString(), to: to.toISOString() },
    analytics: {
      kpis: {
        totalPosts: 0,
        totalImpressions: 0,
        totalReach: 0,
        totalEngagement: 0,
        averageEngagementRate: 0,
        averageCommentsPerPost: 0,
        bestPostingDay: 'none',
        bestPostingHour: 0,
        bestContentType: 'none',
      },
      scores: {
        reachScore: 0,
        engagementScore: 0,
        consistencyScore: 0,
        conversationScore: 0,
        shareabilityScore: 0,
        contentQualityScore: 0,
      },
      charts: {
        performanceOverTime: [],
        engagementBreakdown: [],
        bestTimes: [],
        contentTypePerformance: [],
      },
    },
    interactionOpportunities: buildInteractionOpportunities(
      params.userId,
      params.themes,
      'text',
      params.oppLimit,
    ),
    topCreators: buildTopCreators(params.userId, params.themes, params.creatorLimit),
    insights: [
      {
        title: 'Publish your first posts to unlock analytics',
        description:
          'We could not find any published posts in the last 90 days. Publish a few posts and your reach, engagement, and content-quality analytics will appear here.',
        severity: 'neutral',
      },
      {
        title: 'Start with a consistent cadence',
        description:
          'Aim for 3–5 posts per week. Consistency is the single biggest driver of LinkedIn reach and is something you fully control.',
        severity: 'neutral',
      },
      {
        title: 'Use the starter inspiration below',
        description:
          'The interaction opportunities and creator categories below are locally generated suggestions to help you get started — they are not scraped from LinkedIn.',
        severity: 'positive',
      },
    ],
    locked: params.locked,
  };
}

// ---------------------------------------------------------------------------
// Main entry point.
// ---------------------------------------------------------------------------

export async function getLinkedInGrowthDashboard(userId: string): Promise<LinkedInGrowthDashboardResponse> {
  const entitlement = await getEntitlement(userId);
  const isTrial = entitlement.status === 'TRIAL' || entitlement.status === 'EXPIRED';

  const locked: LinkedInGrowthDashboardResponse['locked'] = {
    fullPlan: isTrial,
    creatorDeepAnalysis: isTrial,
    advancedInteractionQueue: isTrial,
  };

  const oppLimit = isTrial ? 3 : 8;
  const creatorLimit = isTrial ? 3 : 9;

  // Connected LinkedIn account (metadata only — no scraping).
  const [user, account, botConfig] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { username: true, email: true } }),
    prisma.linkedInAccount.findFirst({ where: { userId }, orderBy: { updatedAt: 'desc' } }),
    prisma.botConfig.findUnique({ where: { userId }, select: { niches: true } }),
  ]);

  const niches = parseNiches(botConfig?.niches);

  let connectedAccount: LinkedInGrowthDashboardResponse['connectedAccount'] | undefined;
  if (account) {
    connectedAccount = {
      name: user?.username || user?.email || 'Connected account',
      type: account.selectedOrganizationUrn ? 'organization' : 'member',
    };
  }

  // Pull the user's own published posts from the last 90 days.
  const since = new Date(Date.now() - WINDOW_DAYS * DAY_MS);
  const posts = await prisma.post.findMany({
    where: {
      userId,
      status: 'PUBLISHED',
      publishedAt: { gte: since },
    },
    orderBy: { publishedAt: 'asc' },
    take: 100,
    select: { id: true, content: true, mediaUrl: true, publishedAt: true, linkedinPostUrn: true },
  });

  const published = posts.filter((p): p is typeof p & { publishedAt: Date } => p.publishedAt != null);

  if (published.length === 0) {
    return emptyDashboard({
      isTrial,
      locked,
      connectedAccount,
      userId,
      themes: deriveThemes(niches, 'none'),
      oppLimit,
      creatorLimit,
    });
  }

  // Build deterministic per-post metrics (estimates).
  const metrics = published.map((p) =>
    buildPostMetrics({
      id: p.id,
      content: p.content,
      mediaUrl: p.mediaUrl,
      publishedAt: p.publishedAt,
    }),
  );

  // Try to fetch REAL analytics from LinkedIn. Returns null if the app is not
  // approved for the Community Management API (the common case until approval),
  // if there's no connected account, or on any error — in which case we keep
  // the deterministic estimates above.
  let live: LiveAccountAnalytics | null = null;
  try {
    live = await getLiveAccountAnalytics(userId, since.getTime());
  } catch {
    live = null;
  }

  const isEstimated = live == null;

  // When real totals are available, calibrate each post's estimated metric so
  // the per-post numbers sum to LinkedIn's real totals. This keeps every chart
  // and score consistent with the real headline figures while we lack real
  // per-post granularity. The estimates' relative weighting (which posts did
  // better) is preserved.
  if (live) {
    calibrateMetricsToTotals(metrics, live.totals);
  }

  // ---- KPIs ----
  const totalPosts = metrics.length;
  const totalImpressions = metrics.reduce((s, m) => s + m.impressions, 0);
  const totalReach = metrics.reduce((s, m) => s + m.reach, 0);
  const totalEngagement = metrics.reduce((s, m) => s + m.engagement, 0);
  const totalComments = metrics.reduce((s, m) => s + m.comments, 0);
  const totalReshares = metrics.reduce((s, m) => s + m.reshares, 0);

  const averageEngagementRate = totalImpressions > 0 ? (totalEngagement / totalImpressions) * 100 : 0;
  const averageCommentsPerPost = totalPosts > 0 ? totalComments / totalPosts : 0;
  const averageImpressions = totalPosts > 0 ? totalImpressions / totalPosts : 0;

  // Best posting day (by avg engagement rate).
  const dayBuckets = new Map<number, { rate: number; reach: number; count: number }>();
  for (const m of metrics) {
    const d = m.publishedAt.getDay();
    const b = dayBuckets.get(d) || { rate: 0, reach: 0, count: 0 };
    b.rate += m.engagementRate;
    b.reach += m.reach;
    b.count += 1;
    dayBuckets.set(d, b);
  }
  let bestPostingDay = 'none';
  let bestDayRate = -1;
  for (const [day, b] of dayBuckets) {
    const avg = b.rate / b.count;
    if (avg > bestDayRate) {
      bestDayRate = avg;
      bestPostingDay = DAY_NAMES[day];
    }
  }

  // Best posting hour (by avg engagement rate).
  const hourBuckets = new Map<number, { rate: number; count: number }>();
  for (const m of metrics) {
    const h = m.publishedAt.getHours();
    const b = hourBuckets.get(h) || { rate: 0, count: 0 };
    b.rate += m.engagementRate;
    b.count += 1;
    hourBuckets.set(h, b);
  }
  let bestPostingHour = 0;
  let bestHourRate = -1;
  for (const [hour, b] of hourBuckets) {
    const avg = b.rate / b.count;
    if (avg > bestHourRate) {
      bestHourRate = avg;
      bestPostingHour = hour;
    }
  }

  // Content type performance + best content type.
  const typeBuckets = new Map<MediaType, { rate: number; impressions: number; count: number }>();
  for (const m of metrics) {
    const b = typeBuckets.get(m.mediaType) || { rate: 0, impressions: 0, count: 0 };
    b.rate += m.engagementRate;
    b.impressions += m.impressions;
    b.count += 1;
    typeBuckets.set(m.mediaType, b);
  }
  let bestContentType = 'none';
  let bestTypeRate = -1;
  const contentTypePerformance: LinkedInGrowthDashboardResponse['analytics']['charts']['contentTypePerformance'] = [];
  for (const [mediaType, b] of typeBuckets) {
    const avgRate = b.rate / b.count;
    contentTypePerformance.push({
      mediaType,
      averageEngagementRate: round(avgRate, 2),
      averageImpressions: round(b.impressions / b.count),
      postCount: b.count,
    });
    if (avgRate > bestTypeRate) {
      bestTypeRate = avgRate;
      bestContentType = mediaType;
    }
  }
  contentTypePerformance.sort((a, b) => b.averageEngagementRate - a.averageEngagementRate);

  // ---- Scores (0-100) ----
  const reachScore = clamp(round((averageImpressions / REACH_BASELINE) * 70), 0, 100);
  const engagementScore = clamp(round((averageEngagementRate / ENGAGEMENT_RATE_BASELINE) * 70), 0, 100);

  const uniqueDays = new Set(metrics.map((m) => dayKey(m.publishedAt))).size;
  const consistencyTarget = 36; // ~3 posts/week over 12 weeks
  const consistencyScore = clamp(round((uniqueDays / consistencyTarget) * 100), 0, 100);

  const commentRatio = totalEngagement > 0 ? totalComments / totalEngagement : 0;
  const conversationScore = clamp(round((commentRatio / 0.2) * 100), 0, 100);

  const reshareRatio = totalEngagement > 0 ? totalReshares / totalEngagement : 0;
  const shareabilityScore = clamp(round((reshareRatio / 0.1) * 100), 0, 100);

  const contentQualityScore = clamp(
    round(metrics.reduce((s, m) => s + m.qualityScore, 0) / totalPosts),
    0,
    100,
  );

  // ---- Charts ----
  const dateBuckets = new Map<string, { impressions: number; reach: number; engagement: number }>();
  for (const m of metrics) {
    const key = dayKey(m.publishedAt);
    const b = dateBuckets.get(key) || { impressions: 0, reach: 0, engagement: 0 };
    b.impressions += m.impressions;
    b.reach += m.reach;
    b.engagement += m.engagement;
    dateBuckets.set(key, b);
  }
  // Prefer LinkedIn's real daily series when available; otherwise use the
  // (calibrated) per-post estimates grouped by publish date.
  const performanceOverTime =
    live && live.daily.size > 0
      ? Array.from(live.daily.entries())
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([date, b]) => ({
            date,
            impressions: b.impressions,
            reach: b.reach,
            engagement: b.engagement,
          }))
      : Array.from(dateBuckets.entries())
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([date, b]) => ({ date, impressions: b.impressions, reach: b.reach, engagement: b.engagement }));

  const engagementBreakdown = [...metrics]
    .sort((a, b) => b.engagement - a.engagement)
    .slice(0, 15)
    .map((m) => ({
      postId: m.id,
      label: m.label,
      reactions: m.reactions,
      comments: m.comments,
      reshares: m.reshares,
    }));

  // Best times: aggregate per (day, hour) bucket that has posts.
  const dayHourBuckets = new Map<string, { day: number; hour: number; rate: number; reach: number; count: number }>();
  for (const m of metrics) {
    const day = m.publishedAt.getDay();
    const hour = m.publishedAt.getHours();
    const key = `${day}-${hour}`;
    const b = dayHourBuckets.get(key) || { day, hour, rate: 0, reach: 0, count: 0 };
    b.rate += m.engagementRate;
    b.reach += m.reach;
    b.count += 1;
    dayHourBuckets.set(key, b);
  }
  const bestTimes = Array.from(dayHourBuckets.values())
    .map((b) => ({
      day: DAY_NAMES[b.day],
      hour: b.hour,
      averageEngagementRate: round(b.rate / b.count, 2),
      averageReach: round(b.reach / b.count),
    }))
    .sort((a, b) => b.averageEngagementRate - a.averageEngagementRate)
    .slice(0, 12);

  // ---- Insights ----
  const insights: LinkedInGrowthDashboardResponse['insights'] = [];

  if (averageEngagementRate >= ENGAGEMENT_RATE_BASELINE) {
    insights.push({
      title: 'Strong engagement rate',
      description: `Your average engagement rate is ${round(averageEngagementRate, 2)}%, at or above the ~${ENGAGEMENT_RATE_BASELINE}% benchmark. Your audience is genuinely responding to your content.`,
      severity: 'positive',
    });
  } else if (averageEngagementRate > 0) {
    insights.push({
      title: 'Room to grow engagement',
      description: `Your average engagement rate is ${round(averageEngagementRate, 2)}%, below the ~${ENGAGEMENT_RATE_BASELINE}% benchmark. Try stronger hooks and clearer calls to action.`,
      severity: 'warning',
    });
  }

  if (averageCommentsPerPost < 2) {
    insights.push({
      title: 'Conversation depth is low',
      description: `You're averaging ${round(averageCommentsPerPost, 1)} comments per post. Ask questions and reply to early comments to spark more discussion.`,
      severity: 'warning',
    });
  } else {
    insights.push({
      title: 'Healthy conversation volume',
      description: `You're averaging ${round(averageCommentsPerPost, 1)} comments per post — conversations are a big part of LinkedIn's ranking signal.`,
      severity: 'positive',
    });
  }

  if (consistencyScore < 50) {
    insights.push({
      title: 'Posting consistency needs work',
      description: `You published on ${uniqueDays} distinct days in the last 90. A steadier cadence (3–5 posts/week) will compound your reach.`,
      severity: 'warning',
    });
  } else {
    insights.push({
      title: 'Consistent posting cadence',
      description: `You published on ${uniqueDays} distinct days in the last 90 — consistency is one of your strengths.`,
      severity: 'positive',
    });
  }

  if (bestContentType !== 'none') {
    insights.push({
      title: `${bestContentType} content performs best`,
      description: `Your ${bestContentType} posts have the highest average engagement rate. Consider leaning into this format more often.`,
      severity: 'positive',
    });
  }

  if (bestPostingDay !== 'none') {
    insights.push({
      title: 'Best time to post identified',
      description: `Your posts tend to perform best around ${bestPostingDay} at ${bestPostingHour}:00. Schedule key content in this window.`,
      severity: 'positive',
    });
  }

  // Be transparent about where the numbers come from.
  if (isEstimated) {
    insights.unshift({
      title: 'Analytics are estimated',
      description:
        'These numbers are deterministic estimates derived from your own posts, not live LinkedIn metrics. Connect a LinkedIn account on an app approved for the Community Management API to see real impressions and engagement.',
      severity: 'neutral',
    });
  } else {
    insights.unshift({
      title: 'Live LinkedIn analytics',
      description: 'These numbers are real metrics fetched from LinkedIn for your connected account.',
      severity: 'positive',
    });
  }

  const trimmedInsights = insights.slice(0, 5);

  // ---- Opportunities + creators ----
  const themes = deriveThemes(niches, bestContentType);
  const interactionOpportunities = buildInteractionOpportunities(userId, themes, bestContentType, oppLimit);
  const topCreators = buildTopCreators(userId, themes, creatorLimit);

  const to = new Date();
  const from = new Date(to.getTime() - WINDOW_DAYS * DAY_MS);

  return {
    isTrial,
    isEstimated,
    dataSource: isEstimated ? 'estimated' : 'live',
    connectedAccount,
    dateRange: { from: from.toISOString(), to: to.toISOString() },
    analytics: {
      kpis: {
        totalPosts,
        totalImpressions,
        totalReach,
        totalEngagement,
        averageEngagementRate: round(averageEngagementRate, 2),
        averageCommentsPerPost: round(averageCommentsPerPost, 2),
        bestPostingDay,
        bestPostingHour,
        bestContentType,
      },
      scores: {
        reachScore,
        engagementScore,
        consistencyScore,
        conversationScore,
        shareabilityScore,
        contentQualityScore,
      },
      charts: {
        performanceOverTime,
        engagementBreakdown,
        bestTimes,
        contentTypePerformance,
      },
    },
    interactionOpportunities,
    topCreators,
    insights: trimmedInsights,
    locked,
  };
}
