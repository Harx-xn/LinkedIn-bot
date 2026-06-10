import type { TrendCandidate, TrendContentType } from './generationTypes';

export type { TrendContentType };

const TIMELY_SIGNALS = /\b(launch|announces?|funding|acquisition|merger|regulation|policy|incident|breach|report|study|trial|update|releases?)\b/i;
const ANALYSIS_SIGNALS = /\b(analysis|insight|trend|outlook|forecast|trade-?off|architecture|implementation|why|how)\b/i;
const RESEARCH_SIGNALS = /\b(research|study|clinical|journal|paper|findings|survey)\b/i;
const EVERGREEN_SIGNALS = /\b(guide|tutorial|best practices|lessons?|tips|evergreen|introduction to)\b/i;

export function classifyTrendContentType(trend: TrendCandidate): TrendContentType {
  const title = trend.topic.toLowerCase();
  const source = `${trend.source ?? ''} ${trend.discoverySource ?? ''}`.toLowerCase();
  const ageDays = trend.publishedAt
    ? (Date.now() - Date.parse(String(trend.publishedAt))) / (1000 * 60 * 60 * 24)
    : null;

  if (/reddit|quora|community/i.test(source)) return 'community_discussion';
  if (trend.source === 'evergreen' || EVERGREEN_SIGNALS.test(title)) return 'evergreen';
  if (RESEARCH_SIGNALS.test(title)) return 'research';
  if (TIMELY_SIGNALS.test(title) && ageDays !== null && ageDays <= 14) return 'breaking_news';
  if (TIMELY_SIGNALS.test(title)) return 'industry_news';
  if (ANALYSIS_SIGNALS.test(title)) return 'technical_analysis';
  if (/\b(market|industry|sector|economy)\b/i.test(title)) return 'market_analysis';
  if (ageDays !== null && ageDays <= 7) return 'industry_news';
  return 'technical_analysis';
}

export function isTimelyContentType(type: TrendContentType): boolean {
  return type === 'breaking_news' || type === 'industry_news';
}

export function isAnalysisContentType(type: TrendContentType): boolean {
  return type === 'market_analysis' || type === 'technical_analysis' || type === 'research';
}
