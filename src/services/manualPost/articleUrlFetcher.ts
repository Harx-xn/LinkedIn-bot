import axios from 'axios';
import dns from 'dns/promises';
import { ManualPostError } from '../manualPostService';

export const ARTICLE_FETCH_TIMEOUT_MS = 12_000;
export const ARTICLE_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const ARTICLE_MIN_TEXT_LENGTH = 200;
export const ARTICLE_MAX_EXCERPT_LENGTH = 2800;

export type ReadableArticle = {
  url: string;
  title: string;
  description: string;
  text: string;
};

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return false;
  }
  if (parts[0] === 10) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 0) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::1' || normalized === '::') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (normalized.startsWith('fe80')) return true;
  return false;
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host === 'metadata.google.internal' || host === 'metadata') return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return isPrivateIpv4(host);
  if (host.includes(':')) return isPrivateIpv6(host);
  return false;
}

async function assertResolvedHostIsPublic(hostname: string): Promise<void> {
  if (isBlockedHostname(hostname)) {
    throw new ManualPostError(400, 'URL is not allowed');
  }

  try {
    const results = await dns.lookup(hostname, { verbatim: true, all: true });
    const addresses = Array.isArray(results) ? results : [results];
    for (const entry of addresses) {
      const address = typeof entry === 'string' ? entry : entry.address;
      if (isPrivateIpv4(address) || isPrivateIpv6(address)) {
        throw new ManualPostError(400, 'URL is not allowed');
      }
    }
  } catch (err) {
    if (err instanceof ManualPostError) throw err;
    throw new ManualPostError(400, 'URL could not be resolved');
  }
}

export async function assertSafeArticleUrl(rawUrl: string): Promise<URL> {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new ManualPostError(400, 'url is required');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ManualPostError(400, 'Invalid URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ManualPostError(400, 'URL must use http or https');
  }

  if (parsed.username || parsed.password) {
    throw new ManualPostError(400, 'URL must not include credentials');
  }

  await assertResolvedHostIsPublic(parsed.hostname);
  return parsed;
}

function decodeBasicEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'");
}

function stripHtml(html: string): string {
  return decodeBasicEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function extractFirstMatch(html: string, pattern: RegExp): string {
  const match = html.match(pattern);
  return match?.[1] ? decodeBasicEntities(match[1].trim()) : '';
}

function extractMetaContent(html: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']+)["']`,
      'i',
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${escaped}["']`,
      'i',
    ),
  ];
  for (const pattern of patterns) {
    const value = extractFirstMatch(html, pattern);
    if (value) return value;
  }
  return '';
}

function extractTagText(html: string, tagName: string): string {
  const pattern = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = html.match(pattern);
  return match?.[1] ? stripHtml(match[1]) : '';
}

function extractMainReadableText(html: string): string {
  const candidates = [
    extractTagText(html, 'article'),
    extractTagText(html, 'main'),
    extractFirstMatch(html, /<div[^>]+role=["']main["'][^>]*>([\s\S]*?)<\/div>/i)
      ? stripHtml(extractFirstMatch(html, /<div[^>]+role=["']main["'][^>]*>([\s\S]*?)<\/div>/i))
      : '',
    extractTagText(html, 'body'),
  ].filter((value) => value.length > 0);

  return candidates.sort((a, b) => b.length - a.length)[0] || '';
}

export function extractReadableArticleFromHtml(html: string, url: string): ReadableArticle {
  const title =
    extractMetaContent(html, 'og:title') ||
    extractTagText(html, 'title') ||
    'Article';

  const description =
    extractMetaContent(html, 'og:description') ||
    extractMetaContent(html, 'description') ||
    '';

  const text = extractMainReadableText(html).slice(0, ARTICLE_MAX_EXCERPT_LENGTH);

  return {
    url,
    title: title.slice(0, 300),
    description: description.slice(0, 500),
    text,
  };
}

export async function fetchReadableArticleFromUrl(rawUrl: string): Promise<ReadableArticle> {
  const parsed = await assertSafeArticleUrl(rawUrl);

  let html: string;
  try {
    const response = await axios.get<string>(parsed.toString(), {
      timeout: ARTICLE_FETCH_TIMEOUT_MS,
      maxRedirects: 5,
      maxContentLength: ARTICLE_MAX_RESPONSE_BYTES,
      maxBodyLength: ARTICLE_MAX_RESPONSE_BYTES,
      headers: {
        'User-Agent': 'LinkedInBotArticleFetcher/1.0',
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      },
      responseType: 'text',
      validateStatus: (status) => status >= 200 && status < 400,
      beforeRedirect: async (options) => {
        const nextUrl = options.href || '';
        await assertSafeArticleUrl(nextUrl);
      },
    });
    html = typeof response.data === 'string' ? response.data : '';
  } catch (err) {
    if (err instanceof ManualPostError) throw err;
    console.error('[article-fetch] request failed:', err instanceof Error ? err.message : 'unknown');
    throw new ManualPostError(502, 'Could not fetch article from this URL. Try another link.');
  }

  if (!html.trim()) {
    throw new ManualPostError(400, 'Could not extract enough readable content from this URL.');
  }

  const article = extractReadableArticleFromHtml(html, parsed.toString());
  if (article.text.length < ARTICLE_MIN_TEXT_LENGTH) {
    throw new ManualPostError(400, 'Could not extract enough readable content from this URL.');
  }

  return article;
}
