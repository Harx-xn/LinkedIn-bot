import type { NicheExpansionPlan } from './generationTypes';

export type PreviewQueryCategory =
  | 'news'
  | 'technical'
  | 'market'
  | 'research'
  | 'evergreen'
  | 'general';

export type CategorizedPreviewQuery = {
  query: string;
  category: PreviewQueryCategory;
};

const CATEGORY_ORDER: PreviewQueryCategory[] = [
  'news',
  'technical',
  'market',
  'research',
  'evergreen',
];

function categorizeQuery(query: string): PreviewQueryCategory {
  const lower = query.toLowerCase();
  if (/\b(research|study|clinical|trial|findings|publication)\b/.test(lower)) return 'research';
  if (/\b(market|outlook|forecast|report|analysis)\b/.test(lower)) return 'market';
  if (/\b(engineering|implementation|architecture|technical|lessons)\b/.test(lower)) return 'technical';
  if (/\b(best practices|lessons|guide|evergreen)\b/.test(lower)) return 'evergreen';
  if (/\b(launch|funding|acquisition|announcement|regulation|incident|policy|security)\b/.test(lower)) {
    return 'news';
  }
  return 'general';
}

export function selectPreviewQueries(
  plan: NicheExpansionPlan,
  maxQueries: number,
): CategorizedPreviewQuery[] {
  const buckets = plan.queryBuckets;
  const picked: CategorizedPreviewQuery[] = [];
  const seen = new Set<string>();

  const pushUnique = (query: string, category: PreviewQueryCategory) => {
    const trimmed = query.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    picked.push({ query: trimmed, category });
  };

  if (buckets) {
    const bucketMap: Record<PreviewQueryCategory, string[]> = {
      news: buckets.newsQueries,
      technical: buckets.technicalQueries,
      market: buckets.marketQueries,
      research: buckets.researchQueries,
      evergreen: buckets.evergreenQueries,
      general: [],
    };

    for (const category of CATEGORY_ORDER) {
      const first = bucketMap[category][0];
      if (first) pushUnique(first, category);
      if (picked.length >= maxQueries) break;
    }
  } else {
    const byCategory = new Map<PreviewQueryCategory, string[]>();
    for (const q of plan.queries) {
      const cat = categorizeQuery(q);
      const list = byCategory.get(cat) ?? [];
      list.push(q);
      byCategory.set(cat, list);
    }
    for (const category of CATEGORY_ORDER) {
      const first = byCategory.get(category)?.[0];
      if (first) pushUnique(first, category);
      if (picked.length >= maxQueries) break;
    }
    if (picked.length < maxQueries) {
      for (const q of plan.queries) {
        pushUnique(q, categorizeQuery(q));
        if (picked.length >= maxQueries) break;
      }
    }
  }

  pushUnique(plan.niche, 'general');

  return picked.slice(0, maxQueries);
}

export type TrendSourceName = 'google' | 'medium' | 'linkedin' | 'reddit' | 'quora';

export function sourcesForPreviewQuery(category: PreviewQueryCategory): TrendSourceName[] {
  switch (category) {
    case 'news':
    case 'market':
    case 'research':
      return ['google'];
    case 'technical':
      return ['google', 'medium'];
    case 'evergreen':
      return ['medium'];
    default:
      return ['google'];
  }
}

export function selectPreviewMediumQuery(
  queries: CategorizedPreviewQuery[],
): string | null {
  const technical = queries.find((q) => q.category === 'technical');
  if (technical) return technical.query;
  const evergreen = queries.find((q) => q.category === 'evergreen');
  if (evergreen) return evergreen.query;
  return queries[0]?.query ?? null;
}

export function selectPreviewLinkedInQuery(
  queries: CategorizedPreviewQuery[],
): string | null {
  const news = queries.find((q) => q.category === 'news');
  return news?.query ?? queries[0]?.query ?? null;
}
