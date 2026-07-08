import Parser from 'rss-parser';
import axios from 'axios';
import {
  getPipelineConfig,
  targetCandidateCount,
  type GoogleFreshnessLayer,
  type TrendPipelineMode,
} from '../config/trendPipelineConfig';
import { getSubredditsForNiche } from '../config/redditDomainFeeds';
import type { NicheExpansionPlan } from './generationTypes';
import { extractPublisherFromGoogleNewsTitle } from './trendPublisherUtils';
import { flattenExpansionQueries, getMediumTagsForPlan } from './nicheExpansionService';
import { selectPreviewQueries } from './trendPreviewQuerySelection';
import {
  buildTrendCacheKey,
  fetchTrendsWithCache,
  getTrendCacheStats,
  resetTrendCacheStats,
} from './trendFetchCache';
import {
  filterRedditFromSources,
  isRedditCircuitOpen,
  isRedditConfigured,
  logRedditSkippedOnce,
  noteRedditHttpFailure,
  resetRedditSkipLog,
} from './redditCircuit';
import {
  selectPreviewLinkedInQuery,
  selectPreviewMediumQuery,
  sourcesForPreviewQuery,
} from './trendPreviewQuerySelection';
import { mapWithConcurrency } from './concurrencyUtils';
import { countUsableTrends } from './trendSelectionService';

export interface Trend {
  title: string;
  link: string;
  pubDate: string;
  source: string;
  publisher?: string;
  discoverySource?: string;
  rawTitle?: string;
  niche?: string;
  searchQuery?: string;
  summary?: string;
  keyPoints?: string[];
}

export type TrendFetchInput = {
  niche: string;
  queries?: string[];
  exclusions?: string[];
  sources?: string[];
  customFeeds?: string[];
  customLinks?: string[];
  customRedditFeeds?: string[];
  limit?: number;
  expansionPlan?: NicheExpansionPlan;
  pipelineMode?: TrendPipelineMode;
  candidateTarget?: number;
  requestedCount?: number;
};

export type TrendFetchMetrics = {
  sourceRequestCount: number;
  cacheHits: number;
  cacheMisses: number;
};

export const DEFAULT_TREND_SOURCES = ['google'] as const;

/** Parse bot config `sources` JSON; empty/missing arrays fall back to Google News. */
export function parseTrendSources(raw: string | null | undefined): string[] {
  if (!raw) return [...DEFAULT_TREND_SOURCES];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_TREND_SOURCES];
    const filtered = parsed.filter(
      (value): value is string => typeof value === 'string' && value.trim().length > 0,
    );
    return filtered.length > 0 ? filtered : [...DEFAULT_TREND_SOURCES];
  } catch {
    return [...DEFAULT_TREND_SOURCES];
  }
}

export class TrendsService {
  private parser: Parser;
  private lastFetchMetrics: TrendFetchMetrics = {
    sourceRequestCount: 0,
    cacheHits: 0,
    cacheMisses: 0,
  };

  constructor() {
    this.parser = new Parser();
  }

  getLastFetchMetrics(): TrendFetchMetrics {
    return { ...this.lastFetchMetrics };
  }

  async fetchTrends(
    niche: string,
    sources: string[] = ['google'],
    customFeeds: string[] = [],
    customLinks: string[] = [],
    customRedditFeeds: string[] = [],
    limit: number = 10,
  ): Promise<Trend[]> {
    return this.fetchTrendsWithInput({
      niche,
      sources,
      customFeeds,
      customLinks,
      customRedditFeeds,
      limit,
      pipelineMode: 'generation',
    });
  }

  async fetchTrendsWithInput(input: TrendFetchInput): Promise<Trend[]> {
    const pipelineMode = input.pipelineMode ?? 'generation';
    if (pipelineMode === 'preview') {
      return this.fetchPreviewTrends(input);
    }
    return this.fetchGenerationTrends(input);
  }

  private resolveCandidateTarget(input: TrendFetchInput, mode: TrendPipelineMode): number {
    if (input.candidateTarget) return input.candidateTarget;
    const requested = input.requestedCount ?? input.limit ?? 12;
    return targetCandidateCount(mode, requested);
  }

  private beginFetchMetrics(): void {
    resetTrendCacheStats();
    this.lastFetchMetrics = { sourceRequestCount: 0, cacheHits: 0, cacheMisses: 0 };
    resetRedditSkipLog();
  }

  private endFetchMetrics(): void {
    const cache = getTrendCacheStats();
    this.lastFetchMetrics.cacheHits = cache.hits;
    this.lastFetchMetrics.cacheMisses = cache.misses;
  }

  private trackSourceRequest(): void {
    this.lastFetchMetrics.sourceRequestCount += 1;
  }

  private effectiveSources(sources: string[], mode: TrendPipelineMode): string[] {
    const normalized = sources.length > 0 ? sources : [...DEFAULT_TREND_SOURCES];
    const hadReddit = normalized.some((s) => s.toLowerCase() === 'reddit');
    const filtered = filterRedditFromSources(normalized);
    if (hadReddit && filtered.length < normalized.length) {
      logRedditSkippedOnce({
        mode,
        reason: isRedditConfigured() ? 'reddit_circuit_open' : 'reddit_not_configured',
      });
    }
    return filtered;
  }

  async fetchPreviewTrends(input: TrendFetchInput): Promise<Trend[]> {
    this.beginFetchMetrics();
    const cfg = getPipelineConfig('preview');
    const {
      niche,
      exclusions = [],
      customFeeds = [],
      customLinks = [],
      customRedditFeeds = [],
      expansionPlan,
      sources: rawSources = [...DEFAULT_TREND_SOURCES],
    } = input;

    const sources = this.effectiveSources(rawSources, 'preview');
    const candidateTarget = this.resolveCandidateTarget(input, 'preview');
    const plan = expansionPlan ?? {
      niche,
      domain: niche,
      confidence: 0.4,
      subtopics: [niche],
      queries: [niche],
      exclusions,
    };

    const previewQueries = selectPreviewQueries(plan, cfg.maxQueriesPerNiche);
    const mediumTags = getMediumTagsForPlan(plan);

    let results: Trend[] = [];
    const exclusionsList = plan.exclusions ?? exclusions;

    const hasEnough = () => countUsableTrends(results, niche, exclusionsList) >= candidateTarget;

    // Phase 1: Google 7d for all preview queries
    await mapWithConcurrency(previewQueries, cfg.sourceConcurrency, async (entry) => {
      if (hasEnough()) return;
      if (!sources.some((s) => s.toLowerCase() === 'google')) return;
      if (!sourcesForPreviewQuery(entry.category).includes('google')) return;
      const perQueryLimit = Math.max(3, Math.ceil(candidateTarget / previewQueries.length));
      const batch = await this.fetchGoogleWithLayers(entry.query, perQueryLimit, ['7d']);
      results.push(...batch.map((t) => ({ ...t, niche, searchQuery: entry.query })));
    });

    // Phase 2: custom RSS
    if (!hasEnough() && customFeeds.length) {
      for (const url of customFeeds.slice(0, 3)) {
        if (hasEnough()) break;
        const batch = await this.fetchCustomRssTrends(url, 6);
        results.push(...batch.map((t) => ({ ...t, niche, searchQuery: niche })));
      }
    }

    // Phase 3: Medium (tags only, one logical fetch)
    if (!hasEnough() && sources.some((s) => s.toLowerCase() === 'medium')) {
      const mediumLimit = Math.min(6, candidateTarget);
      const batch = await this.fetchMediumTrends(niche, mediumLimit, mediumTags);
      results.push(...batch.map((t) => ({ ...t, niche, searchQuery: selectPreviewMediumQuery(previewQueries) ?? niche })));
    }

    // Phase 4: LinkedIn at most one query
    if (!hasEnough() && sources.some((s) => s.toLowerCase() === 'linkedin')) {
      const linkedInQuery = selectPreviewLinkedInQuery(previewQueries) ?? plan.niche;
      const batch = await this.fetchGoogleSearchTrends(linkedInQuery, 'linkedin.com', 4);
      results.push(...batch.map((t) => ({ ...t, niche, searchQuery: linkedInQuery })));
    }

    // Phase 5: limited Google 30d fallback on top queries only
    if (!hasEnough() && sources.some((s) => s.toLowerCase() === 'google')) {
      const shortfall = candidateTarget - countUsableTrends(results, niche, exclusionsList);
      const topQueries = previewQueries.slice(0, 2);
      for (const entry of topQueries) {
        if (countUsableTrends(results, niche, exclusionsList) >= candidateTarget) break;
        const batch = await this.fetchGoogleWithLayers(
          entry.query,
          Math.max(2, Math.ceil(shortfall / topQueries.length)),
          ['30d'],
        );
        results.push(...batch.map((t) => ({ ...t, niche, searchQuery: entry.query })));
      }
    }

    if (customRedditFeeds.length && isRedditConfigured() && !isRedditCircuitOpen()) {
      for (const url of customRedditFeeds.slice(0, 2)) {
        if (hasEnough()) break;
        const batch = await this.fetchRedditJsonTrends(url, 4);
        results.push(...batch.map((t) => ({ ...t, niche, searchQuery: niche })));
      }
    }

    if (customLinks.length && !hasEnough()) {
      const batch = await this.fetchCustomTrends(customLinks, Math.min(customLinks.length, 4));
      results.push(...batch.map((t) => ({ ...t, niche, searchQuery: niche })));
    }

    const deduped = this.dedupeTrends(results);
    const sorted = deduped.sort((a, b) => this.safeTime(b.pubDate) - this.safeTime(a.pubDate));
    this.endFetchMetrics();
    return sorted.slice(0, Math.max(candidateTarget, cfg.maxCandidatesPerNiche));
  }

  async fetchGenerationTrends(input: TrendFetchInput): Promise<Trend[]> {
    this.beginFetchMetrics();
    const cfg = getPipelineConfig('generation');
    const {
      niche,
      queries = [niche],
      sources: rawSources = [...DEFAULT_TREND_SOURCES],
      customFeeds = [],
      customLinks = [],
      customRedditFeeds = [],
      expansionPlan,
    } = input;

    const sources = this.effectiveSources(rawSources, 'generation');
    const candidateTarget = Math.min(
      cfg.maxCandidatesPerNiche * 2,
      this.resolveCandidateTarget(input, 'generation'),
    );

    const planQueries = expansionPlan ? flattenExpansionQueries(expansionPlan) : queries;
    const activeQueries = [...new Set(planQueries.map((q) => q.trim()).filter(Boolean))]
      .slice(0, cfg.maxQueriesPerNiche);

    if (activeQueries.length === 0) activeQueries.push(niche);

    const domain = expansionPlan?.domain ?? niche;
    const mediumTags = expansionPlan ? getMediumTagsForPlan(expansionPlan) : [];
    const layers = cfg.googleFreshnessLayers as GoogleFreshnessLayer[];

    const fetchJobs: Array<() => Promise<Trend[]>> = [];

    for (const query of activeQueries) {
      for (const source of sources) {
        fetchJobs.push(() => this.fetchFromSource({
          source,
          query,
          niche,
          limit: Math.max(2, Math.ceil(candidateTarget / (activeQueries.length * Math.max(1, sources.length)))),
          searchQuery: query,
          domain,
          mediumTags,
          googleLayers: layers,
          pipelineMode: 'generation',
        }));
      }
    }

    if (customFeeds.length) {
      for (const url of customFeeds.slice(0, 5)) {
        fetchJobs.push(() => this.fetchCustomRssTrends(url, 5).then((items) =>
          items.map((t) => ({ ...t, niche, searchQuery: niche })),
        ));
      }
    }

    if (customRedditFeeds.length && isRedditConfigured() && !isRedditCircuitOpen()) {
      for (const url of customRedditFeeds.slice(0, 3)) {
        fetchJobs.push(() => this.fetchRedditJsonTrends(url, 5).then((items) =>
          items.map((t) => ({ ...t, niche, searchQuery: niche })),
        ));
      }
    }

    if (customLinks.length) {
      fetchJobs.push(() => this.fetchCustomTrends(customLinks, Math.min(customLinks.length, 8)).then((items) =>
        items.map((t) => ({ ...t, niche, searchQuery: niche })),
      ));
    }

    const results: Trend[] = [];
    await mapWithConcurrency(fetchJobs, cfg.sourceConcurrency, async (job) => {
      try {
        results.push(...await job());
      } catch (error) {
        console.warn('[trends] source fetch failed', {
          niche,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });

    const deduped = this.dedupeTrends(results);
    const sorted = deduped.sort((a, b) => this.safeTime(b.pubDate) - this.safeTime(a.pubDate));
    this.endFetchMetrics();
    return sorted.slice(0, candidateTarget);
  }

  private async fetchFromSource(params: {
    source: string;
    query: string;
    niche: string;
    limit: number;
    searchQuery: string;
    domain: string;
    mediumTags: string[];
    googleLayers: GoogleFreshnessLayer[];
    pipelineMode: TrendPipelineMode;
  }): Promise<Trend[]> {
    const { source, query, niche, limit, searchQuery, domain, mediumTags, googleLayers } = params;
    let items: Trend[] = [];
    switch (source.toLowerCase()) {
      case 'reddit':
        if (!isRedditConfigured() || isRedditCircuitOpen()) return [];
        items = await this.fetchRedditTrends(domain, niche, query, limit);
        break;
      case 'medium':
        items = await this.fetchMediumTrends(niche, limit, mediumTags);
        break;
      case 'google':
        items = await this.fetchGoogleWithLayers(query, limit, googleLayers);
        break;
      case 'linkedin':
        items = await this.fetchGoogleSearchTrends(query, 'linkedin.com', limit);
        break;
      case 'quora':
        items = await this.fetchGoogleSearchTrends(query, 'quora.com', limit);
        break;
      default:
        items = [];
    }
    return items.map((t) => ({ ...t, niche, searchQuery }));
  }

  async fetchRedditTrends(domain: string, niche: string, query: string, limit: number = 5): Promise<Trend[]> {
    if (!isRedditConfigured() || isRedditCircuitOpen()) return [];

    const subreddits = getSubredditsForNiche(domain, niche);
    const results: Trend[] = [];

    if (subreddits.length > 0) {
      for (const sub of subreddits.slice(0, 3)) {
        if (isRedditCircuitOpen()) break;
        const url = `https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(query)}&restrict_sr=1&sort=top&t=week&limit=${Math.min(25, limit)}`;
        const batch = await this.fetchRedditJsonTrends(url, limit);
        results.push(...batch);
      }
    } else {
      console.debug('[trends] no subreddit mapping; skipping Reddit search', { domain, niche });
    }

    return results.slice(0, limit);
  }

  async fetchRedditJsonTrends(url: string, limit: number = 5): Promise<Trend[]> {
    if (!isRedditConfigured() || isRedditCircuitOpen()) return [];

    try {
      this.trackSourceRequest();
      const { data } = await axios.get(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'application/json',
        },
        timeout: 8000,
      });

      if (!data?.data?.children) return [];

      return data.data.children.slice(0, limit).map((child: { data: { title: string; permalink: string; created_utc: number; subreddit_name_prefixed: string } }) => ({
        title: child.data.title,
        link: `https://www.reddit.com${child.data.permalink}`,
        pubDate: new Date(child.data.created_utc * 1000).toISOString(),
        source: `Reddit (${child.data.subreddit_name_prefixed})`,
        publisher: child.data.subreddit_name_prefixed,
        discoverySource: 'Reddit',
      }));
    } catch (error: unknown) {
      const status = (error as { response?: { status?: number } })?.response?.status;
      noteRedditHttpFailure(status);
      if (status !== 404) {
        console.warn('[trends] Reddit fetch failed', {
          url: url.slice(0, 120),
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return [];
    }
  }

  normalizeMediumTag(topic: string): string | null {
    const tag = topic
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-');
    if (!tag || tag.length > 40 || tag.split('-').length > 4) return null;
    return tag;
  }

  async fetchMediumTrends(niche: string, limit: number = 5, mediumTags: string[] = []): Promise<Trend[]> {
    const tags = mediumTags.length
      ? mediumTags
      : [this.normalizeMediumTag(niche)].filter((t): t is string => !!t);

    if (tags.length === 0) {
      console.debug('[trends] skipping Medium; no valid tags', { niche });
      return [];
    }

    const results: Trend[] = [];
    for (const tag of tags.slice(0, 2)) {
      const cacheKey = buildTrendCacheKey({ source: 'medium', query: tag });
      try {
        const batch = await fetchTrendsWithCache(cacheKey, 'medium', async () => {
          this.trackSourceRequest();
          const url = `https://medium.com/feed/tag/${encodeURIComponent(tag)}`;
          const feed = await this.parser.parseURL(url);
          return (feed.items || []).slice(0, limit).map((item) => ({
            title: item.title || 'No Title',
            link: item.link || '',
            pubDate: item.pubDate || '',
            source: 'Medium',
            publisher: 'Medium',
            discoverySource: 'Medium',
          }));
        });
        results.push(...batch);
      } catch (error) {
        console.warn('[trends] Medium fetch failed', {
          tag,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results.slice(0, limit);
  }

  async fetchGoogleWithLayers(
    query: string,
    limit: number = 5,
    layers: GoogleFreshnessLayer[] = ['7d', '30d', 'fallback'],
  ): Promise<Trend[]> {
    const merged: Trend[] = [];

    for (const layer of layers) {
      const suffix = layer === '7d' ? ' when:7d' : layer === '30d' ? ' when:30d' : '';
      const cacheKey = buildTrendCacheKey({
        source: 'google',
        query,
        freshness: layer,
      });
      const batch = await fetchTrendsWithCache(cacheKey, 'google', async () => {
        this.trackSourceRequest();
        return this.fetchGoogleSearchTrends(`${query}${suffix}`.trim(), undefined, limit);
      });
      merged.push(...batch);
      const deduped = this.dedupeTrends(merged);
      if (deduped.length >= limit) return deduped.slice(0, limit);
    }

    return this.dedupeTrends(merged).slice(0, limit);
  }

  async fetchGoogleTrendsLayered(query: string, limit: number = 5): Promise<Trend[]> {
    return this.fetchGoogleWithLayers(query, limit, ['7d', '30d', 'fallback']);
  }

  async fetchGoogleSearchTrends(niche: string, site?: string, limit: number = 5): Promise<Trend[]> {
    try {
      const query = site ? `${niche} site:${site}` : niche;
      const cacheKey = buildTrendCacheKey({
        source: site ? 'linkedin' : 'google',
        query,
        freshness: 'default',
      });
      return await fetchTrendsWithCache(cacheKey, site ? 'linkedin' : 'google', async () => {
        this.trackSourceRequest();
        const encodedQuery = encodeURIComponent(query);
        const url = `https://news.google.com/rss/search?q=${encodedQuery}&hl=en-US&gl=US&ceid=US:en`;

        const feed = await this.parser.parseURL(url);
        const discoverySource = site ? `Google News (${site})` : 'Google News';

        return (feed.items || []).slice(0, limit).map((item) => {
          const rawTitle = item.title || 'No Title';
          const parsed = extractPublisherFromGoogleNewsTitle(rawTitle, discoverySource);
          return {
            title: parsed.title,
            link: item.link || '',
            pubDate: item.pubDate || '',
            source: parsed.publisher,
            publisher: parsed.publisher,
            discoverySource: parsed.discoverySource,
            rawTitle: parsed.rawTitle,
          };
        });
      });
    } catch (error) {
      console.warn('[trends] Google News fetch failed', {
        query: niche.slice(0, 80),
        site,
        message: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  async fetchGoogleTrends(topic: string, limit: number = 5): Promise<Trend[]> {
    return this.fetchGoogleTrendsLayered(topic, limit);
  }

  async fetchCustomRssTrends(url: string, limit: number = 5): Promise<Trend[]> {
    const cacheKey = buildTrendCacheKey({ source: 'customRss', query: url });
    try {
      return await fetchTrendsWithCache(cacheKey, 'customRss', async () => {
        this.trackSourceRequest();
        const resp = await axios.get(url, {
          timeout: 10000,
          headers: { 'User-Agent': 'Mozilla/5.0' },
          responseType: 'text',
          validateStatus: () => true,
        });

        const contentType = (resp.headers['content-type'] || '').toLowerCase();
        const text = typeof resp.data === 'string' ? resp.data : '';

        const looksLikeXml =
          text.trimStart().startsWith('<?xml')
          || text.trimStart().startsWith('<rss')
          || text.trimStart().startsWith('<feed');
        const isXmlType = contentType.includes('xml') || contentType.includes('rss') || contentType.includes('atom');

        if (!looksLikeXml && !isXmlType) {
          console.warn(`[RSS SKIP] Not an RSS/Atom feed: ${url} (content-type: ${contentType || 'unknown'})`);
          return [];
        }

        const feed = await this.parser.parseString(text);
        let hostname = 'RSS';
        try {
          hostname = new URL(url).hostname;
        } catch {
          // keep default
        }

        return (feed.items || []).slice(0, limit).map((item) => ({
          title: item.title || 'No Title',
          link: item.link || '',
          pubDate: item.pubDate || '',
          source: hostname,
          publisher: hostname,
          discoverySource: `RSS (${hostname})`,
        }));
      });
    } catch (error: unknown) {
      console.warn('[trends] custom RSS fetch failed', {
        url: url.slice(0, 120),
        message: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  async fetchCustomTrends(links: string[], limit: number = 5): Promise<Trend[]> {
    return links.slice(0, limit).map((link) => {
      let title = link;
      try {
        const urlObj = new URL(link);

        const keyword = urlObj.searchParams.get('keywords') || urlObj.searchParams.get('q') || urlObj.searchParams.get('tag');

        if (keyword) {
          title = keyword.charAt(0).toUpperCase() + keyword.slice(1);
        } else {
          const segments = urlObj.pathname.split('/').filter((s) => s.length > 0);
          const lastSegment = segments.pop();
          if (lastSegment) {
            title = lastSegment.replace(/[-_]/g, ' ');
            title = title.charAt(0).toUpperCase() + title.slice(1);
          }
        }
      } catch {
        // keep link as title
      }

      return {
        title,
        link,
        pubDate: new Date().toISOString(),
        source: 'Custom Link',
        publisher: 'Custom Link',
        discoverySource: 'Custom Link',
      };
    });
  }

  private safeTime(d: string): number {
    const t = Date.parse(d || '');
    return Number.isFinite(t) ? t : 0;
  }

  private dedupeTrends(trends: Trend[]): Trend[] {
    const map = new Map<string, Trend>();
    for (const t of trends) {
      const key = `${(t.title || '').trim().toLowerCase()}|${(t.link || '').trim().toLowerCase()}`;
      if (!map.has(key)) map.set(key, t);
    }
    return Array.from(map.values());
  }
}
