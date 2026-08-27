import { prisma } from '../../prismaClient';
import { getPlanEconomicsSummaries, summarizePlanDistribution, type PlanCostDistribution, type PlanEconomicsSummary } from './unitEconomicsService';
import type { CostFilters } from './actualCostService';
import { aiUsageWhere } from './actualCostService';

export type PricingSettings = {
  targetGrossMargin: number;
  minimumAcceptableMargin: number;
  pricingPercentileBasis: 'P50' | 'P75' | 'P90' | 'P95';
};

export const DEFAULT_PRICING_SETTINGS: PricingSettings = {
  targetGrossMargin: 0.75,
  minimumAcceptableMargin: 0.5,
  pricingPercentileBasis: 'P75',
};

export function recommendedMinimumPrice(cost: number, targetMargin: number): number {
  if (cost < 0 || targetMargin < 0 || targetMargin >= 1) throw new Error('Target margin must be between 0 and 1');
  return cost / (1 - targetMargin);
}

export async function getPricingSettings(): Promise<PricingSettings> {
  const row = await prisma.platformSetting.findFirst({
    where: { scope: 'GLOBAL', regionId: null, key: 'COST_INTELLIGENCE_PRICING' },
  });
  const value = (row?.value ?? {}) as Record<string, unknown>;
  return {
    targetGrossMargin: typeof value.targetGrossMargin === 'number' ? value.targetGrossMargin : DEFAULT_PRICING_SETTINGS.targetGrossMargin,
    minimumAcceptableMargin: typeof value.minimumAcceptableMargin === 'number' ? value.minimumAcceptableMargin : DEFAULT_PRICING_SETTINGS.minimumAcceptableMargin,
    pricingPercentileBasis: ['P50', 'P75', 'P90', 'P95'].includes(String(value.pricingPercentileBasis))
      ? value.pricingPercentileBasis as PricingSettings['pricingPercentileBasis']
      : DEFAULT_PRICING_SETTINGS.pricingPercentileBasis,
  };
}

export async function savePricingSettings(settings: PricingSettings) {
  if (settings.targetGrossMargin < 0 || settings.targetGrossMargin >= 1 || settings.minimumAcceptableMargin < 0 || settings.minimumAcceptableMargin >= 1) {
    throw new Error('Margins must be decimal values between 0 and 1');
  }
  const existing = await prisma.platformSetting.findFirst({
    where: { scope: 'GLOBAL', regionId: null, key: 'COST_INTELLIGENCE_PRICING' }, select: { id: true },
  });
  return existing
    ? prisma.platformSetting.update({ where: { id: existing.id }, data: { value: settings } })
    : prisma.platformSetting.create({ data: { scope: 'GLOBAL', regionId: null, key: 'COST_INTELLIGENCE_PRICING', value: settings } });
}

function percentileCost(summary: ReturnType<typeof summarizePlanDistribution>, basis: PricingSettings['pricingPercentileBasis']) {
  return basis === 'P50' ? summary.p50CostUsd : basis === 'P90' ? summary.p90CostUsd : basis === 'P95' ? summary.p95CostUsd : summary.p75CostUsd;
}

function buildRecommendationFromSummary(summary: PlanEconomicsSummary, settings: PricingSettings) {
  const selectedCost = percentileCost(summary, settings.pricingPercentileBasis);
  if (summary.sampleStatus === 'LOW_SAMPLE_SIZE' || selectedCost == null || !summary.sampleSize) {
    return { ...summary, targetMarginPercent: settings.targetGrossMargin * 100, recommendedMinimumUsd: null, suggestedPriceRangeUsd: null, status: 'INSUFFICIENT_DATA' as const };
  }
  if (summary.currency.toUpperCase() !== 'USD') return { ...summary, targetMarginPercent: settings.targetGrossMargin * 100, recommendedMinimumUsd: null, suggestedPriceRangeUsd: null, status: 'INSUFFICIENT_DATA' as const, limitation: 'CROSS_CURRENCY_CONVERSION_UNAVAILABLE' };
  const recommended = recommendedMinimumPrice(selectedCost, settings.targetGrossMargin);
  const selectedMargin = summary.price ? (summary.price - selectedCost) / summary.price : -Infinity;
  const status = selectedMargin < 0 ? 'UNPROFITABLE' : selectedMargin < settings.minimumAcceptableMargin ? 'BELOW_TARGET' : selectedMargin < settings.targetGrossMargin ? 'WATCH' : 'HEALTHY';
  return { ...summary, targetMarginPercent: settings.targetGrossMargin * 100,
    currentMarginAtP50Percent: summary.price && summary.p50CostUsd != null ? (summary.price - summary.p50CostUsd) / summary.price * 100 : null,
    currentMarginAtP75Percent: summary.price && summary.p75CostUsd != null ? (summary.price - summary.p75CostUsd) / summary.price * 100 : null,
    currentMarginAtP90Percent: summary.price && summary.p90CostUsd != null ? (summary.price - summary.p90CostUsd) / summary.price * 100 : null,
    recommendedMinimumUsd: recommended, suggestedPriceRangeUsd: { min: recommended, max: recommended * 1.15 }, status };
}

export function buildPricingRecommendation(plan: PlanCostDistribution, settings: PricingSettings) {
  const summary = summarizePlanDistribution(plan);
  const selectedCost = percentileCost(summary, settings.pricingPercentileBasis);
  if (summary.sampleStatus === 'LOW_SAMPLE_SIZE' || selectedCost == null || !plan.costs.length) {
    return { ...summary, targetMarginPercent: settings.targetGrossMargin * 100, recommendedMinimumUsd: null, suggestedPriceRangeUsd: null, status: 'INSUFFICIENT_DATA' as const };
  }
  const isUsd = plan.currency.toUpperCase() === 'USD';
  if (!isUsd) return { ...summary, targetMarginPercent: settings.targetGrossMargin * 100, recommendedMinimumUsd: null, suggestedPriceRangeUsd: null, status: 'INSUFFICIENT_DATA' as const, limitation: 'CROSS_CURRENCY_CONVERSION_UNAVAILABLE' };
  const recommended = recommendedMinimumPrice(selectedCost, settings.targetGrossMargin);
  const selectedMargin = plan.price ? (plan.price - selectedCost) / plan.price : -Infinity;
  const status = selectedMargin < 0 ? 'UNPROFITABLE'
    : selectedMargin < settings.minimumAcceptableMargin ? 'BELOW_TARGET'
      : selectedMargin < settings.targetGrossMargin ? 'WATCH' : 'HEALTHY';
  return {
    ...summary,
    targetMarginPercent: settings.targetGrossMargin * 100,
    currentMarginAtP50Percent: plan.price && summary.p50CostUsd != null ? (plan.price - summary.p50CostUsd) / plan.price * 100 : null,
    currentMarginAtP75Percent: plan.price && summary.p75CostUsd != null ? (plan.price - summary.p75CostUsd) / plan.price * 100 : null,
    currentMarginAtP90Percent: plan.price && summary.p90CostUsd != null ? (plan.price - summary.p90CostUsd) / plan.price * 100 : null,
    recommendedMinimumUsd: recommended,
    suggestedPriceRangeUsd: { min: recommended, max: recommended * 1.15 },
    status,
  };
}

export async function getPricingIntelligence(filters: CostFilters) {
  const [settings, summaries, exposure] = await Promise.all([getPricingSettings(), getPlanEconomicsSummaries(filters), getMaximumEntitlementExposure(filters)]);
  return { mode: 'ACTUAL' as const, settings, plans: summaries.map((summary) => ({ ...buildRecommendationFromSummary(summary, settings), estimatedMaximumAiExposurePerUserUsd: exposure.get(summary.planId) ?? null, exposureMode: 'ESTIMATE' as const })) };
}

async function observedAverageByGeneration(filters: CostFilters, feature?: string, operation?: string) {
  const rows = await prisma.aiUsageEvent.groupBy({
    by: ['generationId'],
    where: { ...aiUsageWhere(filters), generationId: { not: null }, ...(feature ? { feature } : {}), ...(operation ? { operation } : {}) },
    _sum: { totalCostUsd: true },
  });
  return rows.length ? rows.reduce((sum, row) => sum + Number(row._sum.totalCostUsd ?? 0), 0) / rows.length : null;
}

export async function getMaximumEntitlementExposure(filters: CostFilters) {
  const [plans, manualPost, batch, image, rewrite, carousel] = await Promise.all([
    prisma.plan.findMany({ where: { isActive: true, ...(filters.regionId ? { regionId: filters.regionId } : {}) }, select: {
      id: true, dailyPostLimit: true, monthlyPostLimit: true, dailyBatchGenerationLimit: true, monthlyBatchGenerationLimit: true,
      dailyImageGenerationLimit: true, monthlyImageGenerationLimit: true, monthlyManualAiOperationLimit: true, carouselAiGenerationLimit: true,
    } }),
    observedAverageByGeneration(filters, 'MANUAL_POST', 'MANUAL_GENERATE'),
    observedAverageByGeneration(filters, 'BATCH_POST'),
    observedAverageByGeneration(filters, 'AI_IMAGE', 'IMAGE_GENERATE'),
    observedAverageByGeneration(filters, 'REWRITE', 'MANUAL_REWRITE'),
    observedAverageByGeneration(filters, 'CAROUSEL', 'CAROUSEL_GENERATE'),
  ]);
  return new Map(plans.map((plan) => {
    const estimates: Array<number | null> = [
      manualPost == null ? null : (plan.monthlyPostLimit ?? plan.dailyPostLimit * 30) * manualPost,
      batch == null ? null : (plan.monthlyBatchGenerationLimit ?? plan.dailyBatchGenerationLimit * 30) * batch,
      image == null ? null : (plan.monthlyImageGenerationLimit ?? plan.dailyImageGenerationLimit * 30) * image,
      rewrite == null || plan.monthlyManualAiOperationLimit == null ? null : plan.monthlyManualAiOperationLimit * rewrite,
      carousel == null || plan.carouselAiGenerationLimit == null ? null : plan.carouselAiGenerationLimit * carousel,
    ];
    const known = estimates.filter((value): value is number => value != null);
    return [plan.id, known.length ? known.reduce((sum, value) => sum + value, 0) : null] as const;
  }));
}
