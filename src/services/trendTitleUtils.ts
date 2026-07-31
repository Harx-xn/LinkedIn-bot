import { TOPIC_DIVERSITY_CONFIG } from '../config/topicDiversityConfig';
import { HEADLINE_QUALITY_LIMITS } from '../config/trendRankingConfig';
import type { TrendCandidate } from './generationTypes';
import { jaccardSimilarity } from './ghostwriterTextUtils';
import { scoreDiscoverySourceQuality } from './trendPublisherUtils';

export const LOW_VALUE_TITLE_PATTERNS: Array<{ pattern: RegExp; code: string }> = [
  { pattern: /\bhiring\b/i, code: 'job_listing' },
  { pattern: /\bjob(s)?\b/i, code: 'job_listing' },
  { pattern: /\bintern(ship)?\b/i, code: 'internship' },
  { pattern: /\bunpaid\b/i, code: 'unpaid_work' },
  { pattern: /\bapply now\b/i, code: 'apply_now' },
  { pattern: /\bdevelopment company\b/i, code: 'agency_page' },
  { pattern: /\bbest .* company\b/i, code: 'company_directory' },
  { pattern: /\btop \d+ .* companies\b/i, code: 'company_directory' },
  { pattern: /\bhow much does .* cost\b/i, code: 'pricing_page' },
  { pattern: /\bcost in [a-z ]+\b/i, code: 'pricing_page' },
  { pattern: /\bpress release\b/i, code: 'press_release' },
  { pattern: /\bstrengthens position\b/i, code: 'pr_announcement' },
  { pattern: /\bagency services?\b/i, code: 'agency_page' },
  { pattern: /\brecruitment\b/i, code: 'job_listing' },
  { pattern: /\bvacancy\b/i, code: 'job_listing' },
  { pattern: /\bseo services\b/i, code: 'promotional_service' },
  { pattern: /\bonline training\b/i, code: 'training_ad' },
  { pattern: /\breal[- ]time trainer\b/i, code: 'training_ad' },
  { pattern: /\benroll now\b/i, code: 'promotional_cta' },
  { pattern: /\bregister now\b/i, code: 'promotional_cta' },
];

const FILLER_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'to', 'in', 'on', 'of', 'with', 'by',
  'how', 'what', 'why', 'when', 'your', 'our', 'their', 'this', 'that', 'from',
  'guide', 'best', 'top', 'new', 'latest', 'update', 'updates',
]);

/** Normalize headline tokens so near-duplicate trend titles cluster together. */
const TITLE_SYNONYM_GROUPS: string[][] = [
  ['changing', 'transforming', 'upending', 'reshaping', 'disrupting', 'revolutionizing'],
  ['product', 'products', 'software', 'tool', 'tools', 'platform', 'platforms'],
  ['ai', 'artificial', 'intelligence', 'machine', 'learning', 'ml'],
];

const TITLE_SYNONYM_MAP = new Map<string, string>(
  TITLE_SYNONYM_GROUPS.flatMap((group) => {
    const canonical = group[0];
    return group.map((word) => [word, canonical]);
  }),
);

const SOCIAL_POST_SIGNALS = [
  /\bI\s+(stopped|helped|built|learned|noticed|was|am)\b/i,
  /\bDM(?:'d|ed)?\s+me\b/i,
  /\bhere(?:'s| is) what\b/i,
  /\bfollow\s+me\b/i,
  /\blike\s+and\s+share\b/i,
  /\bcomment\s+below\b/i,
];

export type LowValueRejection = {
  trend: TrendCandidate;
  code: string;
};

function canonicalizeTitleToken(token: string): string {
  return TITLE_SYNONYM_MAP.get(token) ?? token;
}

export function normalizeTrendTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\b20\d{2}\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !FILLER_WORDS.has(w))
    .map(canonicalizeTitleToken)
    .join(' ')
    .trim();
}

export function trendTitleSimilarity(a: string, b: string): number {
  const na = normalizeTrendTitle(a);
  const nb = normalizeTrendTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  return jaccardSimilarity(na, nb);
}

export function escapeLiteralPhrase(phrase: string): string {
  return phrase.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function matchesExclusion(title: string, exclusions: string[]): string | null {
  const lower = title.toLowerCase();
  for (const raw of exclusions) {
    const phrase = raw.trim().toLowerCase();
    if (phrase.length < 2) continue;
    if (lower.includes(phrase)) return `exclusion:${phrase}`;
  }
  return null;
}

export function detectSocialPostAsHeadline(title: string): boolean {
  const topic = title.trim();
  if (!topic) return false;

  const sentenceCount = topic
    .split(/[.!?]+/)
    .map((value) => value.trim())
    .filter(Boolean).length;

  const lineBreaks = (topic.match(/\n/g) ?? []).length;
  let socialSignals = 0;
  if (topic.length > HEADLINE_QUALITY_LIMITS.maxHeadlineLength) socialSignals++;
  if (sentenceCount > HEADLINE_QUALITY_LIMITS.maxSentenceCount) socialSignals++;
  if (lineBreaks >= 2) socialSignals++;
  if (SOCIAL_POST_SIGNALS.some((re) => re.test(topic))) socialSignals++;
  if (topic.length >= HEADLINE_QUALITY_LIMITS.socialPostMinLength && /\bI\b/.test(topic)) socialSignals++;

  return socialSignals >= 2;
}

export function detectProfileBiography(trend: Pick<TrendCandidate, 'topic' | 'link'>): boolean {
  const title = trend.topic.trim();
  if (/linkedin\.com\/in\//i.test(trend.link ?? '')) return true;
  const roleMatches = title.match(/\b(ceo|cmo|cro|cto|cfo|founder|co-founder|speaker|mentor|awardee|consultant|expert)\b/gi) ?? [];
  const separators = title.match(/[|·•–—]/g) ?? [];
  const startsLikeName = /^[A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’-]+){1,2}\s*[-–—|·]/.test(title);
  const biographyPhrase = /\b(studied at|works at|certified|enthusiast)\b/i.test(title);
  return (startsLikeName && separators.length >= 2 && (roleMatches.length >= 2 || biographyPhrase))
    || (separators.length >= 3 && roleMatches.length >= 3)
    || (startsLikeName && biographyPhrase);
}

export function rejectLowValueTrend(
  trend: TrendCandidate,
  exclusions: string[] = [],
): { rejected: boolean; code?: string } {
  const topic = trend.topic.trim();
  if (!topic) return { rejected: true, code: 'empty_title' };

  if (detectSocialPostAsHeadline(topic)) {
    return { rejected: true, code: 'social_post_body_instead_of_headline' };
  }
  if (detectProfileBiography(trend)) {
    return { rejected: true, code: 'profile_biography' };
  }

  const appliedExclusions = exclusions.length
    ? exclusions
    : (trend.exclusions ?? []);

  const exclusion = matchesExclusion(topic, appliedExclusions);
  if (exclusion) return { rejected: true, code: exclusion };

  for (const { pattern, code } of LOW_VALUE_TITLE_PATTERNS) {
    if (pattern.test(topic)) return { rejected: true, code };
  }

  if (/linkedin\.com\/jobs|indeed\.com|glassdoor/i.test(trend.link ?? '')) {
    return { rejected: true, code: 'job_board_source' };
  }

  return { rejected: false };
}

export function filterLowValueTrends(
  trends: TrendCandidate[],
  exclusions: string[] = [],
): { accepted: TrendCandidate[]; rejected: LowValueRejection[] } {
  const accepted: TrendCandidate[] = [];
  const rejected: LowValueRejection[] = [];
  for (const trend of trends) {
    const result = rejectLowValueTrend(trend, exclusions);
    if (result.rejected) {
      rejected.push({ trend, code: result.code ?? 'low_value' });
    } else {
      accepted.push(trend);
    }
  }
  return { accepted, rejected };
}

function sourceQualityScore(trend: TrendCandidate): number {
  return scoreDiscoverySourceQuality(trend.discoverySource ?? trend.source, trend.publisher) / 100;
}

function parsePubDate(value?: string | Date | null): number {
  if (!value) return 0;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : 0;
}

function metadataCompleteness(trend: TrendCandidate): number {
  let score = 0;
  if (trend.link) score += 0.4;
  if (trend.source) score += 0.3;
  if (trend.publishedAt) score += 0.3;
  return score;
}

function isPromotionalSource(source?: string): boolean {
  return /\b(custom link|agency|services)\b/i.test(source ?? '');
}

export function pickPreferredTrend(a: TrendCandidate, b: TrendCandidate): TrendCandidate {
  const sa = sourceQualityScore(a);
  const sb = sourceQualityScore(b);
  if (sa !== sb) return sa > sb ? a : b;

  const da = parsePubDate(a.publishedAt);
  const db = parsePubDate(b.publishedAt);
  if (da !== db) return da > db ? a : b;

  const ma = metadataCompleteness(a);
  const mb = metadataCompleteness(b);
  if (ma !== mb) return ma > mb ? a : b;

  const pa = isPromotionalSource(a.source) ? 0 : 1;
  const pb = isPromotionalSource(b.source) ? 0 : 1;
  if (pa !== pb) return pa > pb ? a : b;

  return a;
}

export function exactDedupeTrends(trends: TrendCandidate[]): TrendCandidate[] {
  const map = new Map<string, TrendCandidate>();
  for (const t of trends) {
    const key = `${t.topic.trim().toLowerCase()}|${(t.link ?? '').trim().toLowerCase()}`;
    const existing = map.get(key);
    map.set(key, existing ? pickPreferredTrend(existing, t) : t);
  }
  return Array.from(map.values());
}

export function nearDedupeTrends(
  trends: TrendCandidate[],
  threshold: number = TOPIC_DIVERSITY_CONFIG.titleDuplicateThreshold,
): { kept: TrendCandidate[]; removed: number } {
  const kept: TrendCandidate[] = [];
  let removed = 0;

  for (const trend of trends) {
    let duplicateIdx = -1;
    for (let i = 0; i < kept.length; i++) {
      if (trendTitleSimilarity(trend.topic, kept[i].topic) >= threshold) {
        duplicateIdx = i;
        break;
      }
    }
    if (duplicateIdx >= 0) {
      kept[duplicateIdx] = pickPreferredTrend(kept[duplicateIdx], trend);
      removed++;
    } else {
      kept.push(trend);
    }
  }

  return { kept, removed };
}

export function dedupeTrendCandidates(trends: TrendCandidate[]): TrendCandidate[] {
  const exact = exactDedupeTrends(trends);
  return nearDedupeTrends(exact).kept;
}
