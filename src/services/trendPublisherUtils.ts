import {
  AUTHORITATIVE_PUBLISHERS,
  KNOWN_INDUSTRY_PUBLISHERS,
  TREND_SOURCE_SCORES,
} from '../config/trendRankingConfig';

const PUBLISHER_SUFFIX_PATTERN = /\s[-–—|]\s([^-|–—]+)$/;

export type ParsedPublisher = {
  title: string;
  publisher: string;
  discoverySource: string;
  rawTitle?: string;
};

export function extractPublisherFromGoogleNewsTitle(
  rawTitle: string,
  discoverySource = 'Google News',
): ParsedPublisher {
  const trimmed = rawTitle.trim();
  const match = trimmed.match(PUBLISHER_SUFFIX_PATTERN);
  if (match && match[1].trim().length >= 2 && match[1].trim().length <= 60) {
    const publisher = match[1].trim();
    const title = trimmed.slice(0, match.index).trim();
    if (title.length >= 12) {
      return { title, publisher, discoverySource, rawTitle: trimmed };
    }
  }
  return { title: trimmed, publisher: 'Unknown Publisher', discoverySource, rawTitle: trimmed };
}

export function normalizePublisherKey(publisher: string): string {
  return publisher.trim().toLowerCase();
}

export function scorePublisherQuality(publisher: string, discoverySource?: string): number {
  const key = normalizePublisherKey(publisher);
  if (key === 'unknown publisher' || !key) {
    if (/medium/i.test(discoverySource ?? '')) return TREND_SOURCE_SCORES.medium;
    if (/reddit/i.test(discoverySource ?? '')) return TREND_SOURCE_SCORES.reddit;
    if (/linkedin/i.test(discoverySource ?? '')) return TREND_SOURCE_SCORES.linkedInPost;
    if (/google news/i.test(discoverySource ?? '')) return TREND_SOURCE_SCORES.unknownPublisher;
    return TREND_SOURCE_SCORES.unknownPublisher;
  }

  for (const name of AUTHORITATIVE_PUBLISHERS) {
    if (key.includes(name) || name.includes(key)) return TREND_SOURCE_SCORES.authoritativePublisher;
  }
  for (const name of KNOWN_INDUSTRY_PUBLISHERS) {
    if (key.includes(name) || name.includes(key)) return TREND_SOURCE_SCORES.knownIndustryPublisher;
  }

  if (/medium/i.test(key)) return TREND_SOURCE_SCORES.medium;
  if (/reddit/i.test(key)) return TREND_SOURCE_SCORES.reddit;
  if (/linkedin/i.test(key)) return TREND_SOURCE_SCORES.linkedInPost;

  return TREND_SOURCE_SCORES.unknownPublisher;
}

export function scoreDiscoverySourceQuality(
  discoverySource?: string,
  publisher?: string,
): number {
  const ds = (discoverySource ?? '').toLowerCase();
  if (publisher && publisher !== 'Unknown Publisher') {
    return scorePublisherQuality(publisher, discoverySource);
  }
  if (ds.includes('medium')) return TREND_SOURCE_SCORES.medium;
  if (ds.includes('reddit')) return TREND_SOURCE_SCORES.reddit;
  if (ds.includes('linkedin')) return TREND_SOURCE_SCORES.linkedInPost;
  if (ds.includes('google news')) return TREND_SOURCE_SCORES.unknownPublisher;
  if (ds.includes('rss')) return TREND_SOURCE_SCORES.customTrustedRss;
  if (ds.includes('custom')) return TREND_SOURCE_SCORES.customLink;
  if (ds.includes('quora')) return TREND_SOURCE_SCORES.quora;
  return TREND_SOURCE_SCORES.unknownPublisher;
}
