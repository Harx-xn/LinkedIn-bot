import { createHash, randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../prismaClient';
import type { CandidateCoherence } from './candidateCoherenceService';

export const GENERATION_TRACE_VERSION = 6;
export const GENERATION_TRACE_RETENTION_DAYS = 30;
export const MAX_TRACE_CANDIDATES = 200;
export const MAX_TRACE_ALTERNATIVES_PER_SLOT = 5;
export const MAX_TRACE_DRAFTS = 100;
export const MAX_TRACE_SELECTION_EVALUATIONS = 500;

export type DiagnosticCandidateOrigin =
  | 'SEMANTIC_STRATEGY'
  | 'DETERMINISTIC_STRATEGY_FALLBACK'
  | 'SEARCH_DISCOVERED'
  | 'SEARCH_EVIDENCE_ENRICHMENT'
  | 'RECENT_DEVELOPMENT'
  | 'INVENTORY'
  | 'LEGACY_DISCOVERY'
  | 'USER_REQUESTED'
  | 'UNKNOWN';

export type CandidateDisposition =
  | 'SELECTED'
  | 'HARD_REJECTED'
  | 'BATCH_DUPLICATE'
  | 'LOST_RANKING'
  | 'NOT_NEEDED_AFTER_BATCH_FILLED'
  | 'ALTERNATE'
  | 'EVIDENCE_ONLY';

export type GenerationTraceCandidate = {
  candidateTraceId: string;
  sourceType?: string | null;
  ideaOrigin?: string | null;
  selectedClaim?: string | null;
  selectedMechanism?: string | null;
  origin: DiagnosticCandidateOrigin;
  generationMode: string | null;
  pillar: string | null;
  territory: string | null;
  topicNormalized: string | null;
  ideaFamily: string | null;
  authorityMode: string | null;
  ideaQuality: number | null;
  strategyFit: number | null;
  audienceValue: number | null;
  practicalValue: number | null;
  discussionPotential: number | null;
  specificity: number | null;
  nonObviousness: number | null;
  fallbackFamily: string | null;
  subjectRelevance: number | null;
  sourceClaimTransformability: number | null;
  searchDisposition: string | null;
  searchRejectionReason: string | null;
  evidenceOnly: boolean;
  searchRelevanceBreakdown: Record<string, number> | null;
  conceptualMotif: string | null;
  reasoningArchetype: string | null;
  motifSimilarity: number | null;
  motifPenalty: number | null;
  motifCollisionCandidateId: string | null;
  authorityFit: number | null;
  audienceIdeaNaturalness?: number | null;
  creatorContentFit?: number | null;
  candidateCoherence?: CandidateCoherence | null;
  coherencePenalty?: number | null;
  coherenceRejectionReason?: string | null;
  resolvedAudience?: string[];
  sourceQuality: number | null;
  freshness: number | null;
  novelty: number | null;
  saturationPenalty: number | null;
  memoryPenalty: number | null;
  performanceAdjustment: number | null;
  unifiedQuality: number | null;
  adjustedScore: number | null;
  tier: string | null;
  rejectionReason: string | null;
  selected: boolean;
  selectionOrder: number | null;
  disposition: CandidateDisposition;
  collisionCandidateTraceId: string | null;
};

export type GenerationTraceDraft = {
  draftAttemptId: string;
  slotTraceId: string;
  candidateTraceId: string;
  ideaAttemptId: string;
  ideaAttemptIndex: number;
  origin: string;
  charLength: number;
  deterministicScore: number;
  specificityScore: number;
  reviewerPassed: boolean;
  claimFidelity: number | null;
  informationDensity: number | null;
  progressionQuality: number | null;
  redundancyRisk: number | null;
  genericDiscourseRisk: number | null;
  issueCodes: string[];
  effectiveBlockingCodes?: string[];
  reviewerStatus?: string;
  candidateTier: string;
  becameBestCandidate: boolean;
  acceptedNormally: boolean;
  returnedAsFallback: boolean;
};

export type GenerationTraceSlot = {
  slotTraceId: string;
  slotIndex: number;
  candidateTraceId: string | null;
  selectedCentralClaim: string | null;
  claimSource: string | null;
  depth: {
    depthClass: string;
    targetLengthRange: { min: number; max: number };
    depthScore: number;
    rawDepthSignals: string[];
    independentSubstanceUnits: Array<{ signal: string; type: string; weight: number }>;
    discountedRedundantSignals: Array<{
      signal: string;
      redundantWith: string;
      similarity: number;
      reason: string;
    }>;
    signalsContributing: Record<string, boolean | number>;
  } | null;
  editorial: {
    shareabilityPotential: number | null;
    valueType: string | null;
    recommendedPresentation: string | null;
    contentObjective: string | null;
    conversionObjective: string | null;
    hookFamily: string | null;
    rhetoricalStructure: string | null;
    endingIntent: string | null;
  } | null;
  alternateCandidateTraceIds: string[];
  ideaExhausted: boolean;
  exhaustionReason: string | null;
  replacementCandidateTraceId: string | null;
  replacementSelectionReason: string | null;
  finalCandidateTraceId: string | null;
  finalProvenance: string[];
};

export type GenerationTraceSnapshot = {
  version: number;
  batchTraceId: string;
  createdAt: string;
  completedAt: string | null;
  strategyContext: {
    strategyFingerprint: string;
    contentIntelligenceFingerprint: string | null;
    contentIntelligenceVersion: number | null;
    authorityProfileFingerprint: string | null;
    recentMemoryWindowSize: number;
    performanceLearningAvailable: boolean;
    performanceLearningConfidence: number | null;
    requestedPostCount: number;
  };
  metrics: {
    semanticStrategySelected: number;
    deterministicStrategySelected: number;
    searchSelected: number;
    inventorySelected: number;
    legacySelected: number;
    emptyPlanCount: number;
  };
  candidates: GenerationTraceCandidate[];
  selectionSteps: Array<{
    selectionStep: number;
    candidateTraceId: string;
    adjustedScore: number;
    memoryPenalty: number;
    performanceAdjustment: number;
    tier: number;
    disposition: string;
    collisionCandidateTraceId: string | null;
    motifSimilarity?: number;
    motifPenalty?: number;
    motifCollisionCandidateId?: string | null;
  }>;
  slots: GenerationTraceSlot[];
  draftAttempts: GenerationTraceDraft[];
};

const FORBIDDEN_KEY = /(?:prompt|api.?key|access.?token|refresh.?token|secret|password|rawText|personalExperience|experienceBank)/i;

function stable(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/g, '[REDACTED_SECRET]')
      .replace(/\bBearer\s+[a-zA-Z0-9._~+\/-]{12,}\b/gi, 'Bearer [REDACTED_SECRET]')
      .slice(0, 1000);
  }
  if (Array.isArray(value)) return value.slice(0, 200).map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !FORBIDDEN_KEY.test(key))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, stable(child)]));
  }
  return value;
}

export function diagnosticFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

export function diagnosticTraceId(scope: string, ...parts: unknown[]): string {
  return `${scope}_${diagnosticFingerprint(parts).slice(0, 20)}`;
}

export function createBatchTraceId(jobId?: string): string {
  return jobId || `batch_${randomUUID()}`;
}

export function diagnosticCandidateOrigin(input: {
  ideaGenerationMode?: string | null;
  ideaOrigin?: string | null;
  sourceType?: string | null;
  inventoryId?: string | null;
  provenance?: string | null;
  evidenceEnriched?: boolean;
}): DiagnosticCandidateOrigin {
  if (input.inventoryId) return 'INVENTORY';
  if (input.provenance === 'LEGACY_DISCOVERY') return 'LEGACY_DISCOVERY';
  if (input.evidenceEnriched) return 'SEARCH_EVIDENCE_ENRICHMENT';
  if (input.ideaOrigin === 'USER_REQUESTED') return 'USER_REQUESTED';
  if (input.ideaOrigin === 'RECENT_DEVELOPMENT') return 'RECENT_DEVELOPMENT';
  if (input.sourceType === 'searched' || input.sourceType === 'source_derived_angle' || input.ideaOrigin === 'SEARCH_DISCOVERED') return 'SEARCH_DISCOVERED';
  if (input.ideaGenerationMode === 'SEMANTIC') return 'SEMANTIC_STRATEGY';
  if (input.ideaGenerationMode === 'DETERMINISTIC_FALLBACK') return 'DETERMINISTIC_STRATEGY_FALLBACK';
  return 'UNKNOWN';
}

export class BatchGenerationTraceRecorder {
  private readonly trace: GenerationTraceSnapshot;
  private readonly candidates = new Map<string, GenerationTraceCandidate>();
  private readonly slots = new Map<string, GenerationTraceSlot>();
  private readonly drafts = new Map<string, GenerationTraceDraft>();
  private readonly selectionSteps: GenerationTraceSnapshot['selectionSteps'] = [];

  constructor(input: {
    batchTraceId: string;
    strategyFingerprint: string;
    requestedPostCount: number;
    recentMemoryWindowSize?: number;
    contentIntelligenceFingerprint?: string | null;
    contentIntelligenceVersion?: number | null;
    authorityProfileFingerprint?: string | null;
    performanceLearningAvailable?: boolean;
    performanceLearningConfidence?: number | null;
    createdAt?: Date;
  }) {
    this.trace = {
      version: GENERATION_TRACE_VERSION,
      batchTraceId: input.batchTraceId,
      createdAt: (input.createdAt ?? new Date()).toISOString(),
      completedAt: null,
      strategyContext: {
        strategyFingerprint: input.strategyFingerprint,
        contentIntelligenceFingerprint: input.contentIntelligenceFingerprint ?? null,
        contentIntelligenceVersion: input.contentIntelligenceVersion ?? null,
        authorityProfileFingerprint: input.authorityProfileFingerprint ?? null,
        recentMemoryWindowSize: input.recentMemoryWindowSize ?? 0,
        performanceLearningAvailable: input.performanceLearningAvailable ?? false,
        performanceLearningConfidence: input.performanceLearningConfidence ?? null,
        requestedPostCount: input.requestedPostCount,
      },
      metrics: {
        semanticStrategySelected: 0,
        deterministicStrategySelected: 0,
        searchSelected: 0,
        inventorySelected: 0,
        legacySelected: 0,
        emptyPlanCount: 0,
      },
      candidates: [], selectionSteps: [], slots: [], draftAttempts: [],
    };
  }

  get batchTraceId(): string { return this.trace.batchTraceId; }

  updateStrategyContext(input: Partial<GenerationTraceSnapshot['strategyContext']>): void {
    Object.assign(this.trace.strategyContext, input);
  }

  recordCandidate(candidate: GenerationTraceCandidate): void {
    if (!this.candidates.has(candidate.candidateTraceId) && this.candidates.size >= MAX_TRACE_CANDIDATES) {
      if (!candidate.selected) return;
      const evictable = [...this.candidates.values()].reverse().find((item) => !item.selected);
      if (!evictable) return;
      this.candidates.delete(evictable.candidateTraceId);
    }
    const prior = this.candidates.get(candidate.candidateTraceId);
    this.candidates.set(candidate.candidateTraceId, prior ? {
      ...prior, ...candidate,
      selected: prior.selected || candidate.selected,
      selectionOrder: prior.selectionOrder ?? candidate.selectionOrder,
      disposition: prior.selected ? 'SELECTED' : candidate.disposition,
    } : candidate);
  }

  recordSlot(slot: Omit<GenerationTraceSlot, 'alternateCandidateTraceIds' | 'ideaExhausted' | 'exhaustionReason' | 'replacementCandidateTraceId' | 'replacementSelectionReason' | 'finalCandidateTraceId' | 'finalProvenance'> & Partial<GenerationTraceSlot>): void {
    const prior = this.slots.get(slot.slotTraceId);
    const alternateCandidateTraceIds = (slot.alternateCandidateTraceIds ?? prior?.alternateCandidateTraceIds ?? [])
      .slice(0, MAX_TRACE_ALTERNATIVES_PER_SLOT);
    this.slots.set(slot.slotTraceId, {
      ideaExhausted: false, exhaustionReason: null,
      replacementCandidateTraceId: null, replacementSelectionReason: null,
      finalCandidateTraceId: null, finalProvenance: [],
      ...prior, ...slot,
      alternateCandidateTraceIds,
    });
  }

  recordDraft(draft: GenerationTraceDraft): void {
    if (!this.drafts.has(draft.draftAttemptId) && this.drafts.size >= MAX_TRACE_DRAFTS) return;
    const prior = this.drafts.get(draft.draftAttemptId);
    this.drafts.set(draft.draftAttemptId, prior ? {
      ...prior, ...draft,
      becameBestCandidate: prior.becameBestCandidate || draft.becameBestCandidate,
      acceptedNormally: prior.acceptedNormally || draft.acceptedNormally,
      returnedAsFallback: prior.returnedAsFallback || draft.returnedAsFallback,
    } : draft);
  }

  recordIdeaReplacement(slotTraceId: string, input: {
    exhaustionReason: string | null;
    replacementCandidateTraceId: string | null;
    replacementSelectionReason: string | null;
    replacementDepth?: NonNullable<GenerationTraceSlot['depth']>;
  }): void {
    const slot = this.slots.get(slotTraceId);
    if (!slot) return;
    const { replacementDepth, ...replacement } = input;
    this.slots.set(slotTraceId, {
      ...slot,
      ideaExhausted: true,
      ...replacement,
      depth: replacementDepth ?? slot.depth,
    });
  }

  recordCollision(candidateTraceId: string, collisionCandidateTraceId: string | null): void {
    const candidate = this.candidates.get(candidateTraceId);
    if (!candidate) return;
    this.candidates.set(candidateTraceId, { ...candidate, collisionCandidateTraceId });
  }

  recordSelectionEvaluation(event: GenerationTraceSnapshot['selectionSteps'][number]): void {
    if (this.selectionSteps.length >= MAX_TRACE_SELECTION_EVALUATIONS) return;
    this.selectionSteps.push(event);
  }

  recordFinal(slotTraceId: string, candidateTraceId: string | null, provenance: string[]): void {
    const slot = this.slots.get(slotTraceId);
    if (!slot) return;
    this.slots.set(slotTraceId, { ...slot, finalCandidateTraceId: candidateTraceId, finalProvenance: [...new Set(provenance)] });
  }

  snapshot(completed = false): GenerationTraceSnapshot {
    const candidates = [...this.candidates.values()];
    const slots = [...this.slots.values()].sort((a, b) => a.slotIndex - b.slotIndex);
    const selected = candidates.filter((candidate) => candidate.selected);
    const metrics = {
      semanticStrategySelected: selected.filter((item) => item.generationMode === 'SEMANTIC').length,
      deterministicStrategySelected: selected.filter((item) => item.generationMode === 'DETERMINISTIC_FALLBACK').length,
      searchSelected: selected.filter((item) => ['SEARCH_DISCOVERED', 'RECENT_DEVELOPMENT'].includes(item.origin)).length,
      inventorySelected: selected.filter((item) => item.origin === 'INVENTORY').length,
      legacySelected: selected.filter((item) => item.origin === 'LEGACY_DISCOVERY').length,
      emptyPlanCount: slots.filter((slot) => !slot.selectedCentralClaim).length,
    };
    return JSON.parse(JSON.stringify(stable({
      ...this.trace,
      completedAt: completed ? new Date().toISOString() : this.trace.completedAt,
      metrics, candidates, selectionSteps: this.selectionSteps, slots, draftAttempts: [...this.drafts.values()],
    }))) as GenerationTraceSnapshot;
  }
}

type TraceStore = {
  update: (args: unknown) => Promise<unknown>;
  findUnique: (args: unknown) => Promise<unknown>;
  updateMany?: (args: unknown) => Promise<unknown>;
};

function defaultStore(): TraceStore {
  return prisma.botGenerationJob as unknown as TraceStore;
}

export async function persistGenerationTraceSafe(
  jobId: string | undefined,
  recorder: BatchGenerationTraceRecorder,
  options: { completed?: boolean; now?: Date; store?: TraceStore } = {},
): Promise<boolean> {
  if (!jobId) return false;
  try {
    const now = options.now ?? new Date();
    const expiresAt = new Date(now.getTime() + GENERATION_TRACE_RETENTION_DAYS * 86_400_000);
    await (options.store ?? defaultStore()).update({
      where: { id: jobId },
      data: {
        batchTraceId: recorder.batchTraceId,
        generationTraceVersion: GENERATION_TRACE_VERSION,
        generationTraceExpiresAt: expiresAt,
        generationTrace: recorder.snapshot(options.completed) as unknown as Prisma.InputJsonValue,
      },
    });
    return true;
  } catch (error) {
    console.warn('[generation-trace] persistence failed; generation continues', {
      batchTraceId: recorder.batchTraceId,
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function getGenerationTrace(
  batchTraceId: string,
  store: TraceStore = defaultStore(),
): Promise<GenerationTraceSnapshot | null> {
  const row = await store.findUnique({
    where: { batchTraceId },
    select: { generationTrace: true },
  }) as { generationTrace?: unknown } | null;
  return row?.generationTrace ? row.generationTrace as GenerationTraceSnapshot : null;
}

export async function clearExpiredGenerationTraces(
  now = new Date(),
  store: TraceStore = defaultStore(),
): Promise<number> {
  if (!store.updateMany) return 0;
  const result = await store.updateMany({
    where: { generationTraceExpiresAt: { lt: now }, generationTrace: { not: Prisma.DbNull } },
    data: { generationTrace: Prisma.DbNull, generationTraceVersion: null, generationTraceExpiresAt: null },
  }) as { count?: number };
  return result.count ?? 0;
}

export async function clearExpiredGenerationTracesSafe(now = new Date()): Promise<number> {
  try {
    return await clearExpiredGenerationTraces(now);
  } catch (error) {
    console.warn('[generation-trace] retention cleanup failed; generation continues', {
      message: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}
