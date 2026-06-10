import type { AuthorContext, TrendCandidate, TrendQualityResult } from './generationTypes';
import { buildFallbackExpansionPlan } from './nicheExpansionService';
import { buildEvergreenTopicsForPlan } from './trendDiversityService';

export const TREND_SCORE_THRESHOLD = Number(process.env.TREND_SCORE_THRESHOLD ?? 60);

const JOB_LISTING_SIGNALS = [
  /\bhiring\b/i,
  /\bjob\b/i,
  /\bjobs\b/i,
  /\bintern\b/i,
  /\binternship\b/i,
  /\bunpaid\b/i,
  /\bvacancy\b/i,
  /\bapply now\b/i,
  /\bcareer\b/i,
  /\bdeveloper wanted\b/i,
  /\brecruitment\b/i,
  /\bbusiness development manager\b/i,
];

const PROMO_SIGNALS = [
  /\bpress release\b/i,
  /\bpr\.com\b/i,
  /\bleading company\b/i,
  /\bbest software development company\b/i,
  /\btop agency\b/i,
  /\bbest .+ company in\b/i,
  /\bservices in\b/i,
  /\bcompany in\b/i,
  /\b#\d+\s+(software|agency|company)\b/i,
];

const AGENCY_LISTICLE = [
  /\btop \d+/i,
  /\bbest \d+/i,
  /\bleading \d+/i,
  /\bagency\b/i,
  /\bseo services\b/i,
  /\binternational seo\b/i,
];

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  const inter = [...sa].filter((x) => sb.has(x)).length;
  const union = new Set([...sa, ...sb]).size;
  return union === 0 ? 0 : inter / union;
}

function nicheOverlap(topic: string, niches: string[]): number {
  const topicTokens = tokenize(topic);
  let best = 0;
  for (const niche of niches) {
    const nicheTokens = tokenize(niche);
    best = Math.max(best, jaccard(topicTokens, nicheTokens));
  }
  return best;
}

function authorOverlap(topic: string, description: string): number {
  if (!description.trim()) return 0.2;
  return jaccard(tokenize(topic), tokenize(description));
}

function hasConcreteLessonSignal(topic: string): boolean {
  return /\b(how to|guide|architecture|pattern|trade-?off|debug|mistake|lesson|sprawl|limits?|auth|api|deploy|scale|test|build|design|implement)\b/i.test(
    topic,
  );
}

export function scoreTrend(
  trend: TrendCandidate,
  author: AuthorContext,
  existingTopics: string[] = [],
): TrendQualityResult {
  const topic = trend.topic.trim();
  const reasons: string[] = [];
  let score = 50;

  const niches = author.niches ?? [];
  const description = author.description ?? '';

  for (const re of JOB_LISTING_SIGNALS) {
    if (re.test(topic)) {
      reasons.push('job_listing');
      score -= 45;
      break;
    }
  }

  for (const re of PROMO_SIGNALS) {
    if (re.test(topic)) {
      reasons.push('promotional_content');
      score -= 35;
      break;
    }
  }

  for (const re of AGENCY_LISTICLE) {
    if (re.test(topic)) {
      reasons.push('agency_listicle');
      score -= 25;
      break;
    }
  }

  let nicheMatched = false;
  for (const niche of niches) {
    const key = niche.toLowerCase().split(/\s+/)[0];
    if (key.length > 2 && topic.toLowerCase().includes(key)) {
      nicheMatched = true;
      score += 18;
      break;
    }
  }

  const nicheScore = nicheOverlap(topic, niches);
  if (nicheScore > 0.15) {
    score += Math.round(nicheScore * 30);
    nicheMatched = true;
  } else if (niches.length > 0 && !nicheMatched) {
    reasons.push('weak_niche_match');
    score -= 15;
  }

  const authorScore = authorOverlap(topic, description);
  if (authorScore > 0.1) {
    score += Math.round(authorScore * 25);
  } else {
    reasons.push('weak_author_relevance');
    score -= 10;
  }

  if (hasConcreteLessonSignal(topic)) {
    score += 12;
  } else {
    reasons.push('low_lesson_signal');
    score -= 8;
  }

  if (/linkedin\.com\/jobs|indeed\.com|glassdoor/i.test(trend.link ?? '')) {
    reasons.push('job_board_source');
    score -= 40;
  }

  for (const existing of existingTopics) {
    const sim = jaccard(tokenize(topic), tokenize(existing));
    if (sim > 0.55) {
      reasons.push('duplicate_topic');
      score -= 30;
      break;
    }
  }

  score = Math.max(0, Math.min(100, score));
  const accepted = score >= TREND_SCORE_THRESHOLD && !reasons.includes('job_listing');

  return { accepted, score, reasons };
}

export function filterTrends(
  trends: TrendCandidate[],
  author: AuthorContext,
): { accepted: TrendCandidate[]; rejected: Array<{ trend: TrendCandidate; result: TrendQualityResult }> } {
  const accepted: TrendCandidate[] = [];
  const rejected: Array<{ trend: TrendCandidate; result: TrendQualityResult }> = [];
  const acceptedTopics: string[] = [];

  const sorted = [...trends].sort((a, b) => {
    const sa = scoreTrend(a, author, acceptedTopics);
    const sb = scoreTrend(b, author, acceptedTopics);
    return sb.score - sa.score;
  });

  for (const trend of sorted) {
    const result = scoreTrend(trend, author, acceptedTopics);
    if (result.accepted) {
      accepted.push(trend);
      acceptedTopics.push(trend.topic);
    } else {
      rejected.push({ trend, result });
    }
  }

  return { accepted, rejected };
}

export function buildEvergreenTopics(author: AuthorContext, count: number): TrendCandidate[] {
  const niche = author.niches?.[0] ?? 'technology';
  return buildEvergreenTopicsForPlan(
    author,
    buildFallbackExpansionPlan(niche),
    count,
    new Set(),
    [],
  );
}
