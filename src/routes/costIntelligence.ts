import { Router } from 'express';
import { PlatformExpenseCycle, PlatformExpenseType, Prisma, UserRole } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../prismaClient';
import { authMiddleware } from '../middleware/authMiddleware';
import { requireRole } from '../middleware/requireRole';
import { aggregateAiDimension, aiUsageWhere, getAiSpendTimeline, getAiUsageSummary, getOverview, type CostFilters } from '../services/costIntelligence/actualCostService';
import { assertPricingWindowAvailable, normalizeProvider } from '../services/costIntelligence/aiPricingService';
import { expenseCostForPeriod, getPlatformExpenseSummary, normalizedMonthlyExpense } from '../services/costIntelligence/platformCostService';
import { getPlanEconomicsSummaries, getUnitEconomics, getUserEconomics } from '../services/costIntelligence/unitEconomicsService';
import { getPricingIntelligence, getPricingSettings, savePricingSettings } from '../services/costIntelligence/pricingIntelligenceService';
import { buildForecast } from '../services/costIntelligence/projectionService';
import { createScenario, updateScenario, validateScenarioInput } from '../services/costIntelligence/scenarioService';

const router = Router();
router.use(authMiddleware);
router.use(requireRole(UserRole.SUPER_ADMIN));

function parseDate(value: unknown, fallback: Date): Date {
  const parsed = typeof value === 'string' ? new Date(value) : fallback;
  if (Number.isNaN(parsed.getTime())) throw new Error('Invalid date range');
  return parsed;
}

function filtersFromQuery(query: Record<string, unknown>): CostFilters {
  const to = parseDate(query.to, new Date());
  const from = parseDate(query.from, new Date(to.getTime() - 30 * 86_400_000));
  if (from >= to) throw new Error('From must be earlier than to');
  const text = (key: string) => typeof query[key] === 'string' && query[key] ? String(query[key]) : undefined;
  return {
    from, to, regionId: text('regionId'), planId: text('planId'), provider: text('provider'),
    model: text('model'), feature: text('feature'), operation: text('operation'), agent: text('agent'), userId: text('userId'),
  };
}

function route(handler: (req: any, res: any) => Promise<unknown>) {
  return async (req: any, res: any) => {
    try { await handler(req, res); }
    catch (error) {
      console.error('[cost-intelligence] admin request failed', error);
      const message = error instanceof Error ? error.message : 'Cost intelligence request failed';
      res.status(/not found/i.test(message) ? 404 : 400).json({ message });
    }
  };
}

router.get('/overview', route(async (req, res) => res.json(await getOverview(filtersFromQuery(req.query)))));
router.get('/ai-usage', route(async (req, res) => res.json(await getAiUsageSummary(filtersFromQuery(req.query)))));
router.get('/timeline', route(async (req, res) => res.json({ mode: 'ACTUAL', items: await getAiSpendTimeline(filtersFromQuery(req.query)) })));
router.get('/agents', route(async (req, res) => res.json({ mode: 'ACTUAL', items: await aggregateAiDimension(filtersFromQuery(req.query), 'agent') })));
router.get('/models', route(async (req, res) => {
  const items = await aggregateAiDimension(filtersFromQuery(req.query), 'providerModel') as any[];
  res.json({
    mode: 'ACTUAL', items,
    highlights: {
      mostExpensiveModel: items[0] ?? null,
      mostUsedModel: [...items].sort((a, b) => b.calls - a.calls)[0] ?? null,
      highestAverageCostPerCall: [...items].sort((a, b) => b.averageCostUsd - a.averageCostUsd)[0] ?? null,
    },
  });
}));
router.get('/features', route(async (req, res) => res.json({ mode: 'ACTUAL', items: await aggregateAiDimension(filtersFromQuery(req.query), 'feature') })));
router.get('/unit-economics', route(async (req, res) => res.json(await getUnitEconomics(filtersFromQuery(req.query)))));
router.get('/users', route(async (req, res) => res.json(await getUserEconomics(filtersFromQuery(req.query), Number(req.query.page ?? 1), Number(req.query.pageSize ?? 25)))));
router.get('/plans', route(async (req, res) => {
  res.json({ mode: 'ACTUAL', items: await getPlanEconomicsSummaries(filtersFromQuery(req.query)) });
}));
router.get('/pricing', route(async (req, res) => res.json(await getPricingIntelligence(filtersFromQuery(req.query)))));

router.get('/events', route(async (req, res) => {
  const filters = filtersFromQuery(req.query);
  const page = Math.max(1, Number(req.query.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 25)));
  const where = aiUsageWhere(filters);
  const [total, items] = await Promise.all([
    prisma.aiUsageEvent.count({ where }),
    prisma.aiUsageEvent.findMany({
      where, skip: (page - 1) * pageSize, take: pageSize, orderBy: { createdAt: 'desc' },
      include: { user: { select: { email: true, username: true } }, region: { select: { name: true, code: true } } },
    }),
  ]);
  res.json({ mode: 'ACTUAL', items, page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
}));
router.get('/generations/:generationId', route(async (req, res) => {
  const items = await prisma.aiUsageEvent.findMany({ where: { generationId: req.params.generationId }, orderBy: { createdAt: 'asc' } });
  if (!items.length) throw new Error('Generation trace not found');
  res.json({
    mode: 'ACTUAL', generationId: req.params.generationId, calls: items,
    totals: {
      calls: items.length,
      tokens: items.reduce((sum, item) => sum + item.totalTokens, 0),
      costUsd: items.reduce((sum, item) => sum + Number(item.totalCostUsd), 0),
      durationMs: items.reduce((sum, item) => sum + (item.durationMs ?? 0), 0),
    },
  });
}));

const pricingSchema = z.object({
  provider: z.string().trim().min(1).max(80), model: z.string().trim().min(1).max(160),
  inputCostPerMillionTokens: z.coerce.number().min(0), cachedInputCostPerMillionTokens: z.coerce.number().min(0).nullable().optional(),
  outputCostPerMillionTokens: z.coerce.number().min(0), pricingUnit: z.string().trim().max(40).default('TOKENS'),
  effectiveFrom: z.coerce.date(), effectiveTo: z.coerce.date().nullable().optional(), active: z.boolean().default(true),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

router.get('/model-pricing', route(async (_req, res) => res.json(await prisma.aiModelPricing.findMany({ orderBy: [{ provider: 'asc' }, { model: 'asc' }, { effectiveFrom: 'desc' }] }))));
router.post('/model-pricing', route(async (req, res) => {
  const value = pricingSchema.parse(req.body);
  await assertPricingWindowAvailable(value);
  const created = await prisma.aiModelPricing.create({ data: { ...value, provider: normalizeProvider(value.provider), metadata: value.metadata as Prisma.InputJsonValue } });
  res.status(201).json(created);
}));
router.put('/model-pricing/:id', route(async (req, res) => {
  const value = pricingSchema.parse(req.body);
  const existing = await prisma.aiModelPricing.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new Error('Model pricing not found');
  const changesPrice = normalizeProvider(value.provider) !== existing.provider || value.model !== existing.model ||
    value.inputCostPerMillionTokens !== Number(existing.inputCostPerMillionTokens) ||
    value.outputCostPerMillionTokens !== Number(existing.outputCostPerMillionTokens) ||
    (value.cachedInputCostPerMillionTokens ?? null) !== (existing.cachedInputCostPerMillionTokens == null ? null : Number(existing.cachedInputCostPerMillionTokens));
  if (changesPrice && existing.effectiveFrom <= new Date()) {
    if (value.effectiveFrom <= existing.effectiveFrom) throw new Error('A replacement pricing version must start after the existing version');
    await assertPricingWindowAvailable({ ...value, excludeId: existing.id });
    const result = await prisma.$transaction(async (tx) => {
      await tx.aiModelPricing.update({ where: { id: existing.id }, data: { active: false, effectiveTo: value.effectiveFrom } });
      return tx.aiModelPricing.create({ data: { ...value, provider: normalizeProvider(value.provider), metadata: value.metadata as Prisma.InputJsonValue } });
    });
    return res.json({ versioned: true, previousPricingId: existing.id, pricing: result });
  }
  await assertPricingWindowAvailable({ ...value, excludeId: existing.id });
  return res.json(await prisma.aiModelPricing.update({ where: { id: existing.id }, data: { ...value, provider: normalizeProvider(value.provider), metadata: value.metadata as Prisma.InputJsonValue } }));
}));

const expenseSchema = z.object({
  name: z.string().trim().min(1).max(160), provider: z.string().trim().max(160).nullable().optional(), category: z.string().trim().min(1).max(100),
  type: z.nativeEnum(PlatformExpenseType), billingCycle: z.nativeEnum(PlatformExpenseCycle), amountUsd: z.coerce.number().min(0),
  active: z.boolean().default(true), effectiveFrom: z.coerce.date(), effectiveTo: z.coerce.date().nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(), metadata: z.record(z.string(), z.unknown()).optional(), allocationMethod: z.string().trim().optional(),
});
router.get('/expenses', route(async (req, res) => {
  const filters = filtersFromQuery(req.query);
  const [summary, expenses, rules] = await Promise.all([
    getPlatformExpenseSummary(filters),
    prisma.platformExpense.findMany({ orderBy: [{ active: 'desc' }, { category: 'asc' }, { name: 'asc' }] }),
    prisma.costAllocationRule.findMany({ where: { active: true } }),
  ]);
  const ruleMap = new Map(rules.map((item) => [item.expenseCategory, item.allocationMethod]));
  res.json({ ...summary, items: expenses.map((expense) => ({
    ...expense, amountUsd: Number(expense.amountUsd), normalizedMonthlyUsd: normalizedMonthlyExpense(expense),
    periodCostUsd: expense.active ? expenseCostForPeriod(expense, filters) : 0,
    allocationMethod: ruleMap.get(expense.category) ?? 'ACTIVE_USERS', allocationBasis: 'CURRENT_RULE_RECOMPUTATION',
  })) });
}));
router.post('/expenses', route(async (req, res) => {
  const { allocationMethod, ...value } = expenseSchema.parse(req.body);
  if (value.effectiveTo && value.effectiveTo <= value.effectiveFrom) throw new Error('Effective to must be later than effective from');
  const created = await prisma.platformExpense.create({ data: { ...value, metadata: value.metadata as Prisma.InputJsonValue } });
  if (allocationMethod) await prisma.costAllocationRule.create({ data: { expenseCategory: value.category, allocationMethod } });
  res.status(201).json({ ...created, normalizedMonthlyUsd: normalizedMonthlyExpense(created) });
}));
router.put('/expenses/:id', route(async (req, res) => {
  const { allocationMethod, ...value } = expenseSchema.parse(req.body);
  if (value.effectiveTo && value.effectiveTo <= value.effectiveFrom) throw new Error('Effective to must be later than effective from');
  const updated = await prisma.platformExpense.update({ where: { id: req.params.id }, data: { ...value, metadata: value.metadata as Prisma.InputJsonValue } });
  if (allocationMethod) {
    await prisma.costAllocationRule.updateMany({ where: { expenseCategory: value.category, active: true }, data: { active: false } });
    await prisma.costAllocationRule.create({ data: { expenseCategory: value.category, allocationMethod } });
  }
  res.json({ ...updated, normalizedMonthlyUsd: normalizedMonthlyExpense(updated) });
}));

const allocationMethods = new Set(['DIRECT', 'ACTIVE_USERS', 'PAID_USERS', 'AI_ACTIVE_USERS', 'REQUEST_WEIGHTED', 'MANUAL']);
router.get('/allocation-rules', route(async (_req, res) => res.json(await prisma.costAllocationRule.findMany({ orderBy: { expenseCategory: 'asc' } }))));
router.put('/allocation-rules/:category', route(async (req, res) => {
  const allocationMethod = String(req.body?.allocationMethod ?? '');
  if (!allocationMethods.has(allocationMethod)) throw new Error('Unsupported allocation method');
  await prisma.costAllocationRule.updateMany({ where: { expenseCategory: req.params.category, active: true }, data: { active: false } });
  res.json(await prisma.costAllocationRule.create({ data: { expenseCategory: req.params.category, allocationMethod } }));
}));

const scenarioSchema = z.object({
  name: z.string(), projectedUsers: z.coerce.number(), monthlyUserGrowthRate: z.coerce.number(), activeUserRate: z.coerce.number(),
  trialToPaidRate: z.coerce.number(), monthlyChurnRate: z.coerce.number(), averageAiUsageMultiplier: z.coerce.number().optional(),
  horizonMonths: z.coerce.number().optional(), assumptions: z.record(z.string(), z.unknown()).optional(),
});
router.get('/scenarios', route(async (_req, res) => res.json(await prisma.costProjectionScenario.findMany({ orderBy: { createdAt: 'desc' } }))));
router.post('/scenarios', route(async (req, res) => res.status(201).json(await createScenario(scenarioSchema.parse(req.body) as any, req.user.id))));
router.put('/scenarios/:id', route(async (req, res) => res.json(await updateScenario(req.params.id, scenarioSchema.parse(req.body) as any))));
router.delete('/scenarios/:id', route(async (req, res) => { await prisma.costProjectionScenario.delete({ where: { id: req.params.id } }); res.status(204).send(); }));
router.get('/forecast', route(async (req, res) => {
  const scenario = req.query.scenarioId
    ? await prisma.costProjectionScenario.findUnique({ where: { id: String(req.query.scenarioId) } })
    : validateScenarioInput({ name: 'Expected', projectedUsers: Number(req.query.projectedUsers ?? 0), monthlyUserGrowthRate: Number(req.query.monthlyUserGrowthRate ?? 0.05), activeUserRate: Number(req.query.activeUserRate ?? 0.6), trialToPaidRate: Number(req.query.trialToPaidRate ?? 0.15), monthlyChurnRate: Number(req.query.monthlyChurnRate ?? 0.04), averageAiUsageMultiplier: Number(req.query.averageAiUsageMultiplier ?? 1), horizonMonths: Number(req.query.horizonMonths ?? 12) });
  if (!scenario) throw new Error('Projection scenario not found');
  res.json(await buildForecast(scenario, typeof req.query.regionId === 'string' ? req.query.regionId : undefined));
}));

router.get('/settings', route(async (_req, res) => {
  const [pricing, allocationRules] = await Promise.all([getPricingSettings(), prisma.costAllocationRule.findMany({ where: { active: true } })]);
  const forecast = await prisma.platformSetting.findFirst({ where: { scope: 'GLOBAL', regionId: null, key: 'COST_INTELLIGENCE_FORECAST' } });
  res.json({ pricing, allocationRules, forecast: forecast?.value ?? { defaultForecastHorizon: 12, defaultAiUsageMultiplier: 1 } });
}));
router.put('/settings', route(async (req, res) => {
  const pricing = await savePricingSettings({
    targetGrossMargin: Number(req.body?.targetGrossMargin), minimumAcceptableMargin: Number(req.body?.minimumAcceptableMargin),
    pricingPercentileBasis: req.body?.pricingPercentileBasis,
  });
  const forecastValue = { defaultForecastHorizon: Number(req.body?.defaultForecastHorizon ?? 12), defaultAiUsageMultiplier: Number(req.body?.defaultAiUsageMultiplier ?? 1) };
  const existing = await prisma.platformSetting.findFirst({ where: { scope: 'GLOBAL', regionId: null, key: 'COST_INTELLIGENCE_FORECAST' }, select: { id: true } });
  const forecast = existing
    ? await prisma.platformSetting.update({ where: { id: existing.id }, data: { value: forecastValue } })
    : await prisma.platformSetting.create({ data: { scope: 'GLOBAL', regionId: null, key: 'COST_INTELLIGENCE_FORECAST', value: forecastValue } });
  res.json({ pricing: pricing.value, forecast: forecast.value });
}));

export default router;
