import { createHash } from 'node:crypto';
import { prisma } from '../prismaClient';
import type { AuthorContext, RankedTrendCandidate, SourceReference, TopicFingerprint, TrendCandidate } from './generationTypes';
import type { EffectiveBotStrategy } from './botStrategyService';
import { evaluateBatchTopicSimilarity, evaluateTopicNovelty } from './topicNoveltyService';
import { loadRecentTopicHistory } from './topicHistoryService';

export const TOPIC_EXPIRY_DAYS: Record<string, number> = {
  recent_development: 14, industry_change: 30, practical_implication: 30,
  audience_question: 90, recurring_problem: 120, verified_solution: 90, beginner_guidance: 180,
};
export const INVENTORY_LOW_WATERMARK = Math.max(0, Number(process.env.TOPIC_INVENTORY_LOW_WATERMARK ?? 5) || 5);
export const INVENTORY_TARGET = Math.max(INVENTORY_LOW_WATERMARK, Number(process.env.TOPIC_INVENTORY_TARGET ?? 12) || 12);
export const INVENTORY_RESERVATION_MINUTES = Math.max(5, Number(process.env.TOPIC_INVENTORY_RESERVATION_MINUTES ?? 30) || 30);

export function inventoryFingerprint(fingerprint: TopicFingerprint): string {
  return createHash('sha256').update([
    fingerprint.normalizedTopic, fingerprint.topicCluster, fingerprint.coreClaim,
    [...fingerprint.mechanisms].sort().join('|'),
  ].join('\n').toLowerCase()).digest('hex');
}

export function unselectedQualifiedTopics(qualified: RankedTrendCandidate[], selected: RankedTrendCandidate[]): RankedTrendCandidate[] {
  const selectedFingerprints = new Set(selected.map((item) => inventoryFingerprint(item.fingerprint)));
  return qualified.filter((item) => !selectedFingerprints.has(inventoryFingerprint(item.fingerprint)));
}

export function combineFreshAndInventoryTopics(
  fresh: RankedTrendCandidate[], inventory: RankedTrendCandidate[], requested: number,
): { freshSelected: RankedTrendCandidate[]; inventorySelected: RankedTrendCandidate[]; selected: RankedTrendCandidate[] } {
  const freshSelected = fresh.slice(0, requested);
  const inventorySelected = inventory.slice(0, Math.max(0, requested - freshSelected.length));
  return { freshSelected, inventorySelected, selected: [...freshSelected, ...inventorySelected] };
}

function expiryFor(candidate: RankedTrendCandidate): Date {
  const days = TOPIC_EXPIRY_DAYS[candidate.trend.discoveryIntent ?? ''] ?? 60;
  return new Date(Date.now() + days * 86_400_000);
}

export async function storeQualifiedTopics(userId: string, topics: RankedTrendCandidate[]): Promise<number> {
  const safe = topics.filter((item) => item.novelty.allowed && item.trend.selectionMode !== 'zero_result_fallback'
    && Boolean(item.trend.link) && Boolean(item.fingerprint.normalizedTopic));
  if (!safe.length) return 0;
  const result = await prisma.topicInventory.createMany({
    data: safe.map((item) => ({
      userId, niche: item.trend.originNiche ?? item.trend.niche ?? 'unknown', title: item.trend.topic,
      normalizedTopic: item.fingerprint.normalizedTopic, coreClaim: item.fingerprint.coreClaim,
      semanticCluster: item.fingerprint.topicCluster, mechanism: JSON.stringify(item.fingerprint.mechanisms),
      intent: item.trend.discoveryIntent, relevanceScore: item.relevanceScore,
      strategyScore: item.trend.strategyScore ?? item.relevanceScore, confidenceScore: item.trend.qualificationConfidence ?? Math.min(1, item.relevanceScore / 100),
      sourceQualityScore: item.sourceQualityScore, noveltyScore: item.noveltyScore,
      recencyScore: item.recencyScore, finalScore: item.totalScore, sourceUrl: item.trend.link,
      sourceName: item.trend.publisher ?? item.trend.source, discoverySource: item.trend.discoverySource,
      evidenceRole: item.trend.evidenceRole, evidenceSummary: item.trend.summary,
      supportingSources: item.trend.supportingSources ?? undefined, fingerprint: inventoryFingerprint(item.fingerprint),
      profileFingerprint: item.trend.profileFingerprint, sourcePublishedAt: item.trend.publishedAt ? new Date(item.trend.publishedAt) : null,
      expiresAt: expiryFor(item),
    })),
    skipDuplicates: true,
  });
  return result.count;
}

function parseMechanisms(value: string | null): string[] {
  try { return value ? JSON.parse(value) : []; } catch { return []; }
}

function inventoryToRanked(row: any): RankedTrendCandidate {
  const fingerprint: TopicFingerprint = {
    normalizedTopic: row.normalizedTopic, topicCluster: row.semanticCluster ?? 'unclassified',
    coreClaim: row.coreClaim ?? row.title, entities: [], mechanisms: parseMechanisms(row.mechanism),
  };
  const trend: TrendCandidate = {
    inventoryId: row.id, topic: row.title, link: row.sourceUrl ?? undefined, source: row.sourceName ?? undefined,
    publisher: row.sourceName ?? undefined, discoverySource: row.discoverySource ?? undefined,
    publishedAt: row.sourcePublishedAt, niche: row.niche, originNiche: row.niche,
    profileFingerprint: row.profileFingerprint ?? undefined, discoveryIntent: row.intent ?? undefined,
    evidenceRole: row.evidenceRole ?? undefined, summary: row.evidenceSummary ?? undefined,
    supportingSources: (row.supportingSources as SourceReference[] | null) ?? undefined, fingerprint,
  };
  return {
    trend, fingerprint, relevanceScore: row.relevanceScore, sourceQualityScore: row.sourceQualityScore,
    recencyScore: row.recencyScore, technicalDepthScore: 0, noveltyScore: row.noveltyScore,
    totalScore: row.finalScore, novelty: { allowed: true, score: row.noveltyScore, reasons: [] },
  };
}

export async function recoverStaleTopicReservations(): Promise<number> {
  const cutoff = new Date(Date.now() - INVENTORY_RESERVATION_MINUTES * 60_000);
  const result = await prisma.topicInventory.updateMany({
    where: { status: 'RESERVED', reservedAt: { lt: cutoff }, OR: [
      { reservedByJobId: null },
      { reservedByJobId: { not: null }, NOT: { reservedByJobId: { in: (await prisma.botGenerationJob.findMany({ where: { status: 'RUNNING' }, select: { id: true } })).map((job) => job.id) } } },
    ] },
    data: { status: 'AVAILABLE', reservedByJobId: null, reservedAt: null },
  });
  return result.count;
}

export async function reserveValidInventoryTopics(params: {
  userId: string; generationJobId: string; count: number; activeNiches: string[];
  selectedFreshTopics: RankedTrendCandidate[];
  activeProfileFingerprints?: Map<string, string>;
}): Promise<RankedTrendCandidate[]> {
  if (params.count <= 0) return [];
  await recoverStaleTopicReservations();
  const now = new Date();
  await prisma.topicInventory.updateMany({ where: { userId: params.userId, status: 'AVAILABLE', expiresAt: { lte: now } }, data: { status: 'EXPIRED' } });
  const history = await loadRecentTopicHistory(params.userId);
  const freshFingerprints = params.selectedFreshTopics.map((item) => item.fingerprint);
  const candidates = await prisma.topicInventory.findMany({
    where: { userId: params.userId, niche: { in: params.activeNiches }, status: 'AVAILABLE', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    orderBy: { finalScore: 'desc' }, take: Math.max(params.count * 5, 20),
  });
  const diagnostics = {
    availableRows: candidates.length, expiredRows: 0, reservedRows: 0, consumedRows: 0,
    profileMismatchRows: 0, historyRejectedRows: 0, batchDuplicateRows: 0,
    missingEvidenceRows: 0, missingLinkRows: 0, successfullyReservedRows: 0,
  };
  const statusCounts = await prisma.topicInventory.groupBy({ by: ['status'], where: { userId: params.userId, niche: { in: params.activeNiches } }, _count: true });
  diagnostics.expiredRows = statusCounts.find((row) => row.status === 'EXPIRED')?._count ?? 0;
  diagnostics.reservedRows = statusCounts.find((row) => row.status === 'RESERVED')?._count ?? 0;
  diagnostics.consumedRows = statusCounts.find((row) => row.status === 'CONSUMED')?._count ?? 0;
  const valid: RankedTrendCandidate[] = [];
  for (const row of candidates) {
    const activeProfile = params.activeProfileFingerprints?.get(row.niche);
    if (activeProfile && row.profileFingerprint && activeProfile !== row.profileFingerprint) { diagnostics.profileMismatchRows++; continue; }
    const item = inventoryToRanked(row);
    const novelty = evaluateTopicNovelty(item.fingerprint, history);
    if (!novelty.allowed) { diagnostics.historyRejectedRows++; continue; }
    if (evaluateBatchTopicSimilarity(item.fingerprint, [...freshFingerprints, ...valid.map((x) => x.fingerprint)]).duplicate) { diagnostics.batchDuplicateRows++; continue; }
    if (!item.trend.link) { diagnostics.missingLinkRows++; continue; }
    if (item.trend.evidenceRole === 'primary' && !item.trend.summary && !(item.trend.supportingSources?.length)) { diagnostics.missingEvidenceRows++; continue; }
    item.novelty = novelty; item.noveltyScore = novelty.score;
    valid.push(item);
    if (valid.length >= params.count) break;
  }
  const ids = valid.map((item) => item.trend.inventoryId!);
  if (!ids.length) { console.info('[topic-inventory] reservation funnel', { ...diagnostics, userId: params.userId, niches: params.activeNiches }); return []; }
  return prisma.$transaction(async (tx) => {
    await tx.topicInventory.updateMany({
      where: { id: { in: ids }, status: 'AVAILABLE' },
      data: { status: 'RESERVED', reservedByJobId: params.generationJobId, reservedAt: now },
    });
    const reserved = await tx.topicInventory.findMany({ where: { id: { in: ids }, status: 'RESERVED', reservedByJobId: params.generationJobId } });
    const reservedIds = new Set(reserved.map((row) => row.id));
    const selected = valid.filter((item) => reservedIds.has(item.trend.inventoryId!));
    diagnostics.successfullyReservedRows = selected.length;
    console.info('[topic-inventory] reservation funnel', { ...diagnostics, userId: params.userId, niches: params.activeNiches });
    return selected;
  });
}

export async function consumeInventoryTopic(inventoryId: string, generationJobId: string): Promise<void> {
  await prisma.topicInventory.updateMany({ where: { id: inventoryId, status: 'RESERVED', reservedByJobId: generationJobId }, data: { status: 'CONSUMED', consumedAt: new Date() } });
}

export async function releaseInventoryTopic(inventoryId: string, generationJobId: string): Promise<void> {
  await prisma.topicInventory.updateMany({ where: { id: inventoryId, status: 'RESERVED', reservedByJobId: generationJobId }, data: { status: 'AVAILABLE', reservedByJobId: null, reservedAt: null } });
}

export async function availableInventoryByNiche(userId: string, niches: string[]): Promise<Record<string, number>> {
  const rows = await prisma.topicInventory.groupBy({ by: ['niche'], where: { userId, niche: { in: niches }, status: 'AVAILABLE', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, _count: true });
  return Object.fromEntries(niches.map((niche) => [niche, rows.find((row) => row.niche === niche)?._count ?? 0]));
}

const activeReplenishments = new Set<string>();
export function enqueueLowInventoryReplenishment(params: {
  userId: string; niches: string[]; author: AuthorContext; strategy?: EffectiveBotStrategy;
  sources: string[]; openaiApiKey?: string | null;
}): void {
  for (const niche of params.niches) {
    const key = `${params.userId}|${niche.toLowerCase()}`;
    if (activeReplenishments.has(key)) continue;
    activeReplenishments.add(key);
    void (async () => {
      try {
        const before = (await availableInventoryByNiche(params.userId, [niche]))[niche] ?? 0;
        if (before >= INVENTORY_LOW_WATERMARK) return;
        const { TrendOrchestrationService } = await import('./trendOrchestrationService');
        const orchestrator = new TrendOrchestrationService(params.openaiApiKey);
        const pool = await orchestrator.getRankedTrendPool({
          userId: params.userId, niches: [niche], author: { ...params.author, niches: [niche] },
          strategy: params.strategy, sources: params.sources, limit: INVENTORY_TARGET - before, mode: 'generation',
        });
        const newlyQualified = pool.qualifiedRanked?.length ?? pool.ranked.length;
        const newlyStored = await storeQualifiedTopics(params.userId, pool.qualifiedRanked ?? pool.ranked);
        const after = (await availableInventoryByNiche(params.userId, [niche]))[niche] ?? 0;
        console.info('[topic-inventory] replenishment completed', {
          userId: params.userId, niche, availableBefore: before, lowWatermark: INVENTORY_LOW_WATERMARK,
          targetInventory: INVENTORY_TARGET, newlyQualified, newlyStored, availableAfter: after,
        });
      } catch (error) {
        console.error('[topic-inventory] replenishment failed', { userId: params.userId, niche, message: error instanceof Error ? error.message : String(error) });
      } finally { activeReplenishments.delete(key); }
    })();
  }
}
