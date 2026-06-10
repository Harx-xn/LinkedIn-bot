import type { TrendCandidate } from './generationTypes';
import { scoreDiscoverySourceQuality } from './trendPublisherUtils';

export type PreviewScoreInput = {
  relevanceScore: number;
  sourceQualityScore: number;
  recencyScore: number;
  titleQualityScore: number;
  promotionalPenalty: number;
};

const PROMOTIONAL_PATTERNS = [
  /\bonline training\b/i,
  /\breal[- ]time trainer\b/i,
  /\benroll now\b/i,
  /\bregister now\b/i,
  /\bcertification course\b/i,
];

export function promotionalPenalty(title: string): number {
  let penalty = 0;
  for (const pattern of PROMOTIONAL_PATTERNS) {
    if (pattern.test(title)) penalty += 15;
  }
  if (title.length > 200) penalty += 10;
  return Math.min(40, penalty);
}

export function titleQualityScore(title: string): number {
  const len = title.trim().length;
  if (len < 12) return 20;
  if (len > 180) return 35;
  const sentences = title.split(/[.!?]+/).filter(Boolean).length;
  if (sentences > 3) return 40;
  return 80;
}

export function calculatePreviewScore(input: PreviewScoreInput): number {
  return (
    input.relevanceScore * 0.35
    + input.sourceQualityScore * 0.25
    + input.recencyScore * 0.25
    + input.titleQualityScore * 0.15
    - input.promotionalPenalty
  );
}

export function recencyScoreForPreview(publishedAt?: string | Date | null): number {
  if (!publishedAt) return 40;
  const t = Date.parse(String(publishedAt));
  if (!Number.isFinite(t)) return 40;
  const days = (Date.now() - t) / (1000 * 60 * 60 * 24);
  if (days <= 1) return 100;
  if (days <= 7) return 85;
  if (days <= 30) return 65;
  if (days <= 90) return 45;
  return 25;
}

export function buildPreviewScoreInput(
  trend: TrendCandidate,
  relevance: number,
): PreviewScoreInput {
  return {
    relevanceScore: relevance,
    sourceQualityScore: scoreDiscoverySourceQuality(
      trend.discoverySource ?? trend.source,
      trend.publisher,
    ),
    recencyScore: recencyScoreForPreview(trend.publishedAt),
    titleQualityScore: titleQualityScore(trend.topic),
    promotionalPenalty: promotionalPenalty(trend.topic),
  };
}
