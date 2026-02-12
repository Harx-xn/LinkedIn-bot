import Parser from 'rss-parser';
import axios from 'axios';

export interface Trend {
  title: string;
  link: string;
  pubDate: string;
  source: string;
}

export class TrendsService {
  private parser: Parser;

  constructor() {
    this.parser = new Parser();
  }

  // Master fetcher (limit = total number of trends you want back)
  async fetchTrends(
    niche: string,
    sources: string[] = ['google'],
    customFeeds: string[] = [],
    customLinks: string[] = [],
    customRedditFeeds: string[] = [],
    limit: number = 10
  ): Promise<Trend[]> {
    // Split the limit across sources with a small buffer,
    // because sources overlap and some fail.
    const sourceCount = Math.max(1, sources.length);
    const perSource = Math.max(1, Math.ceil(limit / sourceCount) + 2);

    const promises = sources.map((source) => {
      switch (source.toLowerCase()) {
        case 'reddit':
          return this.fetchRedditTrends(niche, perSource);
        case 'medium':
          return this.fetchMediumTrends(niche, perSource);
        case 'google':
          return this.fetchGoogleTrends(niche, perSource);
        case 'linkedin':
          return this.fetchGoogleSearchTrends(niche, 'linkedin.com', perSource);
        case 'quora':
          return this.fetchGoogleSearchTrends(niche, 'quora.com', perSource);
        default:
          return Promise.resolve([]);
      }
    });

    // Add custom RSS feeds (also capped)
    if (customFeeds?.length) {
      promises.push(...customFeeds.map((url) => this.fetchCustomRssTrends(url, perSource)));
    }

    // Add custom reddit feeds (also capped)
    if (customRedditFeeds?.length) {
      promises.push(...customRedditFeeds.map((url) => this.fetchRedditJsonTrends(url, perSource)));
    }

    // Add custom links (cap total from links too)
    if (customLinks?.length) {
      promises.push(this.fetchCustomTrends(customLinks, perSource));
    }

    const results = (await Promise.all(promises)).flat();

    // Deduplicate + sort newest first + trim to requested limit
    const deduped = this.dedupeTrends(results);
    const sorted = deduped.sort((a, b) => this.safeTime(b.pubDate) - this.safeTime(a.pubDate));

    return sorted.slice(0, Math.max(1, limit));
  }

  // 1) Reddit Fetcher (JSON API)
  async fetchRedditTrends(niche: string, limit: number = 5): Promise<Trend[]> {
    const sanitizedNiche = niche.replace(/\s+/g, '');
    const url = `https://www.reddit.com/r/${sanitizedNiche}/top.json?limit=${Math.min(
      100,
      Math.max(1, limit)
    )}&t=day`;

    let results = await this.fetchRedditJsonTrends(url, limit);

    // Fallback: try the first word if the full niche name fails
    if (results.length === 0 && niche.includes(' ')) {
      const firstWord = niche.split(' ')[0];
      const fallbackUrl = `https://www.reddit.com/r/${firstWord}/top.json?limit=${Math.min(
        100,
        Math.max(1, limit)
      )}&t=day`;
      results = await this.fetchRedditJsonTrends(fallbackUrl, limit);
    }

    return results.slice(0, limit);
  }

  async fetchRedditJsonTrends(url: string, limit: number = 5): Promise<Trend[]> {
    try {
      const { data } = await axios.get(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'application/json',
        },
      });

      if (!data?.data?.children) return [];

      return data.data.children.slice(0, limit).map((child: any) => ({
        title: child.data.title,
        link: `https://www.reddit.com${child.data.permalink}`,
        pubDate: new Date(child.data.created_utc * 1000).toISOString(),
        source: `Reddit (${child.data.subreddit_name_prefixed})`,
      }));
    } catch (error: any) {
      // Only log if it's NOT a 404 (404 is expected for some niche guesses)
      if (error.response?.status !== 404) {
        console.error(`Error fetching Reddit JSON trends from ${url}:`, error.message);
      }
      return [];
    }
  }

  // 2) Medium Fetcher (RSS)
  async fetchMediumTrends(niche: string, limit: number = 5): Promise<Trend[]> {
    try {
      const url = `https://medium.com/feed/tag/${encodeURIComponent(niche)}`;
      const feed = await this.parser.parseURL(url);

      return (feed.items || []).slice(0, limit).map((item) => ({
        title: item.title || 'No Title',
        link: item.link || '',
        pubDate: item.pubDate || '',
        source: 'Medium',
      }));
    } catch (error) {
      console.error(`Error fetching Medium trends for ${niche}:`, error);
      return [];
    }
  }

  // 3) Google Search/News RSS (Quora/LinkedIn/General)
  async fetchGoogleSearchTrends(niche: string, site?: string, limit: number = 5): Promise<Trend[]> {
    try {
      const query = site ? `${niche} site:${site}` : niche;
      const encodedQuery = encodeURIComponent(query);
      const url = `https://news.google.com/rss/search?q=${encodedQuery}&hl=en-US&gl=US&ceid=US:en`;

      const feed = await this.parser.parseURL(url);

      return (feed.items || []).slice(0, limit).map((item) => ({
        title: item.title || 'No Title',
        link: item.link || '',
        pubDate: item.pubDate || '',
        source: site ? `Google News (${site})` : 'Google News',
      }));
    } catch (error) {
      console.error(`Error fetching Google trends for ${niche} (site: ${site}):`, error);
      return [];
    }
  }

  // Legacy / Default wrapper
  async fetchGoogleTrends(topic: string, limit: number = 5): Promise<Trend[]> {
    return this.fetchGoogleSearchTrends(topic, undefined, limit);
  }

  // 4) Custom RSS Fetcher
  async fetchCustomRssTrends(url: string, limit: number = 5): Promise<Trend[]> {
    try {
      const resp = await axios.get(url, {
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0' },
        responseType: 'text',
        validateStatus: () => true,
      });

      const contentType = (resp.headers['content-type'] || '').toLowerCase();
      const text = typeof resp.data === 'string' ? resp.data : '';

      const looksLikeXml =
        text.trimStart().startsWith('<?xml') ||
        text.trimStart().startsWith('<rss') ||
        text.trimStart().startsWith('<feed');
      const isXmlType = contentType.includes('xml') || contentType.includes('rss') || contentType.includes('atom');

      if (!looksLikeXml && !isXmlType) {
        console.warn(`[RSS SKIP] Not an RSS/Atom feed: ${url} (content-type: ${contentType || 'unknown'})`);
        return [];
      }

      const feed = await this.parser.parseString(text);

      return (feed.items || []).slice(0, limit).map((item) => ({
        title: item.title || 'No Title',
        link: item.link || '',
        pubDate: item.pubDate || '',
        source: `RSS (${new URL(url).hostname})`,
      }));
    } catch (error: any) {
      console.error(`Error fetching custom RSS feed ${url}:`, error.message || error);
      return [];
    }
  }

  // 5) Custom Links Fetcher
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
      } catch {}

      return {
        title,
        link,
        pubDate: new Date().toISOString(),
        source: 'Custom Link',
      };
    });
  }

  // -------- helpers --------

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
