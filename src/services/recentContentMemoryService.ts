import { prisma } from '../prismaClient';
import { normalizeTrendTitle } from './trendTitleUtils';
import type { RankedTrendCandidate } from './generationTypes';
import { areHardBatchDuplicates } from './trendRankingService';
import { classifyHookType } from './finalPostFingerprintClassifier';
import { createHash } from 'node:crypto';
import { classifyConceptualMotif } from './conceptualMotifService';

export type RecentContentFingerprint = {
  pillar?: string | null;
  territory?: string | null;
  topic: string;
  coreClaim: string;
  mechanism?: string | null;
  perspective?: string | null;
  ideaFamily?: string | null;
  argumentPattern?: string | null;
  structure?: string | null;
  hookType?: string | null;
  endingType?: string | null;
  ctaType?: string | null;
  contentIntent?: string | null;
  conceptualMotif?: string | null;
  reasoningArchetype?: string | null;
  candidateId?: string | null;
  authorityMode?: string | null;
  origin?: 'HISTORICAL' | 'REJECTED_DUPLICATE_ONLY' | 'CURRENT_BATCH' | 'SEARCH_DERIVED' | 'STRATEGY_DERIVED';
};

export type RecentContentMemory = {
  fingerprints: RecentContentFingerprint[];
  recentPillarUsage: Map<string, number>;
  recentTerritoryUsage: Map<string, number>;
  recentMechanisms: Map<string, number>;
  recentPerspectives: Map<string, number>;
  recentArgumentPatterns: Map<string, number>;
  recentHooks: Map<string, number>;
  recentEndings: Map<string, number>;
};

export type ContentMemoryPenalty = {
  total: number;
  strong: string[];
  medium: string[];
  light: string[];
  maxClaimSimilarity: number;
  maxMechanismSimilarity: number;
  motifSimilarity: number;
  motifPenalty: number;
  motifCollisionCandidateId: string | null;
};

const TOKEN_EQUIVALENTS: Record<string, string> = {
  checks: 'check', checking: 'check', checked: 'check', validates: 'validate', validated: 'validate', validation: 'validate',
  verifies: 'verify', verified: 'verify', verification: 'verify', enforcing: 'enforce', enforced: 'enforce',
  entitlements: 'entitlement', decisions: 'decision', constraints: 'constraint', mechanisms: 'mechanism',
  clients: 'client', users: 'user', patients: 'patient', candidates: 'candidate', outcomes: 'outcome',
  servers: 'server', authoritative: 'authority', ownership: 'owner', owns: 'owner', owned: 'owner',
  requires: 'require', required: 'require', requiring: 'require', belongs: 'require', should: 'require', must: 'require',
  named: 'explicit', naming: 'explicit', repeats: 'duplicate', repeated: 'duplicate', repeating: 'duplicate', duplicates: 'duplicate',
  prevents: 'remove', prevented: 'remove', prevent: 'remove', disappears: 'remove', disappeared: 'remove', disappear: 'remove',
};
const MEMORY_STOP_WORDS = new Set('a an and are as at be because been but by can do does for from had has have if in into is it its may more most of on or our should so than that the their them then there these they this to under was we when where which while will with without rather instead'.split(' '));

function key(value?: string | null): string {
  return normalizeTrendTitle(value ?? '');
}

function semanticTokens(value?: string | null): Set<string> {
  const tokens = key(value).match(/[a-z0-9]+/g) ?? [];
  return new Set(tokens
    .filter((token) => token.length > 2 && !MEMORY_STOP_WORDS.has(token))
    .map((token) => TOKEN_EQUIVALENTS[token] ?? token.replace(/(?:ing|ed|es|s)$/i, ''))
    .filter((token) => token.length > 2));
}

export function semanticMemorySimilarity(a?: string | null, b?: string | null): number {
  const left = semanticTokens(a);
  const right = semanticTokens(b);
  if (!left.size || !right.size) return 0;
  const intersection = [...left].filter((token) => right.has(token)).length;
  return intersection / Math.min(left.size, right.size);
}

function increment(map: Map<string, number>, value?: string | null): void {
  const normalized = key(value);
  if (normalized) map.set(normalized, (map.get(normalized) ?? 0) + 1);
}

function metadataFromKeywords(value: unknown): { endingType?: string; ideaFamily?: string; conceptualMotif?: string; reasoningArchetype?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const data = value as Record<string, unknown>;
  return {
    endingType: typeof data.endingType === 'string' ? data.endingType : undefined,
    ideaFamily: typeof data.ideaFamily === 'string' ? data.ideaFamily : undefined,
    conceptualMotif: typeof data.finalConceptualMotif === 'string' ? data.finalConceptualMotif
      : typeof data.conceptualMotif === 'string' ? data.conceptualMotif : undefined,
    reasoningArchetype: typeof data.finalReasoningArchetype === 'string' ? data.finalReasoningArchetype
      : typeof data.reasoningArchetype === 'string' ? data.reasoningArchetype : undefined,
  };
}

export function createRecentContentMemory(fingerprints: RecentContentFingerprint[] = []): RecentContentMemory {
  const memory: RecentContentMemory = {
    fingerprints: [], recentPillarUsage: new Map(), recentTerritoryUsage: new Map(), recentMechanisms: new Map(),
    recentPerspectives: new Map(), recentArgumentPatterns: new Map(), recentHooks: new Map(), recentEndings: new Map(),
  };
  for (const fingerprint of fingerprints) updateRecentContentMemory(memory, fingerprint);
  return memory;
}

export function updateRecentContentMemory(memory: RecentContentMemory, fingerprint: RecentContentFingerprint): void {
  memory.fingerprints.push(fingerprint);
  increment(memory.recentPillarUsage, fingerprint.pillar);
  increment(memory.recentTerritoryUsage, fingerprint.territory);
  increment(memory.recentMechanisms, fingerprint.mechanism);
  increment(memory.recentPerspectives, fingerprint.perspective);
  increment(memory.recentArgumentPatterns, fingerprint.argumentPattern);
  increment(memory.recentHooks, fingerprint.hookType);
  increment(memory.recentEndings, fingerprint.endingType ?? fingerprint.ctaType);
}

export function scoreAgainstRecentContentMemory(
  candidate: RecentContentFingerprint,
  memory: RecentContentMemory,
): ContentMemoryPenalty {
  let maxClaimSimilarity = 0;
  let maxMechanismSimilarity = 0;
  let sameClaimPerspective = false;
  let motifSimilarity = 0;
  let motifPenalty = 0;
  let motifCollisionCandidateId: string | null = null;
  for (const recent of memory.fingerprints) {
    const claimSimilarity = semanticMemorySimilarity(candidate.coreClaim, recent.coreClaim);
    const mechanismSimilarity = semanticMemorySimilarity(candidate.mechanism, recent.mechanism);
    maxClaimSimilarity = Math.max(maxClaimSimilarity, claimSimilarity);
    maxMechanismSimilarity = Math.max(maxMechanismSimilarity, mechanismSimilarity);
    if (claimSimilarity >= 0.58 && key(candidate.perspective) && key(candidate.perspective) === key(recent.perspective)) {
      sameClaimPerspective = true;
    }
    const sameMotif = key(candidate.conceptualMotif)
      && key(candidate.conceptualMotif) === key(recent.conceptualMotif);
    const sameArchetype = key(candidate.reasoningArchetype)
      && key(candidate.reasoningArchetype) === key(recent.reasoningArchetype);
    const samePerspective = key(candidate.perspective)
      && key(candidate.perspective) === key(recent.perspective);
    const candidateMotifPenalty = sameMotif
      ? samePerspective ? 28 : mechanismSimilarity < .45 ? 16 : 20
      : sameArchetype && samePerspective ? 3 : 0;
    const candidateMotifSimilarity = sameMotif ? 1 : sameArchetype ? .55 : 0;
    if (candidateMotifPenalty > motifPenalty || (candidateMotifPenalty === motifPenalty && candidateMotifSimilarity > motifSimilarity)) {
      motifPenalty = candidateMotifPenalty;
      motifSimilarity = candidateMotifSimilarity;
      motifCollisionCandidateId = recent.candidateId ?? null;
    }
  }

  const strong: string[] = [];
  const medium: string[] = [];
  const light: string[] = [];
  let total = 0;
  if (maxClaimSimilarity >= 0.62) { total += 36; strong.push('recent_core_claim'); }
  if (maxMechanismSimilarity >= 0.45) { total += 40; strong.push('recent_mechanism'); }
  if (sameClaimPerspective) { total += 12; strong.push('recent_claim_and_perspective'); }
  if (motifPenalty >= 28) { total += motifPenalty; strong.push('conceptual_motif_and_perspective'); }
  else if (motifPenalty >= 16) { total += motifPenalty; medium.push('conceptual_motif_reuse'); }
  else if (motifPenalty > 0) { total += motifPenalty; light.push('reasoning_archetype_reuse'); }

  const territoryCount = memory.recentTerritoryUsage.get(key(candidate.territory)) ?? 0;
  const pillarCount = memory.recentPillarUsage.get(key(candidate.pillar)) ?? 0;
  const familyCount = memory.fingerprints.filter((item) => key(item.ideaFamily) === key(candidate.ideaFamily) && key(candidate.ideaFamily)).length;
  const patternCount = memory.recentArgumentPatterns.get(key(candidate.argumentPattern)) ?? 0;
  const structureCount = memory.fingerprints.filter((item) => key(item.structure) === key(candidate.structure) && key(candidate.structure)).length;
  const intentCount = memory.fingerprints.filter((item) => key(item.contentIntent) === key(candidate.contentIntent) && key(candidate.contentIntent)).length;
  if (territoryCount) { total += Math.min(20, territoryCount * 4); medium.push(`territory_saturation:${territoryCount}`); }
  if (familyCount) { total += Math.min(24, familyCount * 8); medium.push(`idea_family_reuse:${familyCount}`); }
  if (patternCount) { total += Math.min(24, patternCount * 8); medium.push(`argument_pattern_reuse:${patternCount}`); }
  if (structureCount) { total += Math.min(9, structureCount * 3); medium.push(`structure_reuse:${structureCount}`); }
  if (intentCount) { total += Math.min(9, intentCount * 3); medium.push(`content_intent_reuse:${intentCount}`); }

  const hookCount = memory.recentHooks.get(key(candidate.hookType)) ?? 0;
  const endingCount = memory.recentEndings.get(key(candidate.endingType ?? candidate.ctaType)) ?? 0;
  const perspectiveCount = memory.recentPerspectives.get(key(candidate.perspective)) ?? 0;
  const authorityCount = memory.fingerprints.filter((item) => key(item.authorityMode) === key(candidate.authorityMode) && key(candidate.authorityMode)).length;
  if (pillarCount) { total += Math.min(8, pillarCount * 2); light.push(`pillar_reuse:${pillarCount}`); }
  if (hookCount) { total += Math.min(6, hookCount * 2); light.push(`hook_reuse:${hookCount}`); }
  if (endingCount) { total += Math.min(6, endingCount * 2); light.push(`ending_reuse:${endingCount}`); }
  if (perspectiveCount) { total += Math.min(6, perspectiveCount * 2); light.push(`perspective_reuse:${perspectiveCount}`); }
  if (authorityCount) { total += Math.min(4, authorityCount); light.push(`authority_mode_reuse:${authorityCount}`); }

  return { total: Math.min(90, total), strong, medium, light, maxClaimSimilarity, maxMechanismSimilarity, motifSimilarity, motifPenalty, motifCollisionCandidateId };
}

export async function loadRecentContentMemory(userId: string, limit = 80): Promise<RecentContentMemory> {
  const [rows, rejectedHistory] = await Promise.all([prisma.postContentFingerprint.findMany({
    where: { userId, post: { status: { in: ['REVIEW', 'SCHEDULED', 'PUBLISHED', 'REJECTED'] } } },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      postId: true, primaryTopic: true, pillar: true, territory: true, coreClaim: true, mechanism: true, perspective: true,
      argumentPattern: true, structure: true, hookType: true, ctaType: true, authorityMode: true, contentIntent: true, keywords: true,
      post: { select: { status: true } },
    },
  }), prisma.generatedTopicHistory.findMany({
    where: {
      userId,
      status: 'REJECTED',
      generatedAt: { gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) },
    },
    orderBy: { generatedAt: 'desc' },
    take: Math.min(20, limit),
    select: { id: true, postId: true, normalizedTopic: true, coreClaim: true, angle: true, topicCluster: true },
  })]);
  const accepted = rows.map((row) => {
    const metadata = metadataFromKeywords(row.keywords);
    return {
      topic: row.primaryTopic,
      pillar: row.pillar,
      territory: row.territory,
      coreClaim: row.coreClaim,
      mechanism: row.mechanism,
      perspective: row.perspective,
      ideaFamily: metadata.ideaFamily ?? row.contentIntent,
      argumentPattern: row.argumentPattern,
      structure: row.structure,
      hookType: row.hookType,
      endingType: metadata.endingType ?? row.ctaType,
      ctaType: row.ctaType,
      authorityMode: row.authorityMode,
      contentIntent: row.contentIntent,
      conceptualMotif: metadata.conceptualMotif,
      reasoningArchetype: metadata.reasoningArchetype,
      candidateId: `post:${row.postId}`,
      origin: row.post.status === 'REJECTED' ? 'REJECTED_DUPLICATE_ONLY' as const : 'HISTORICAL' as const,
    };
  });
  const loadedPostIds = new Set(rows.map((row) => row.postId));
  const rejected: RecentContentFingerprint[] = rejectedHistory.filter((row) => !row.postId || !loadedPostIds.has(row.postId)).map((row) => ({
    topic: row.normalizedTopic,
    territory: row.topicCluster,
    coreClaim: row.coreClaim?.trim() || row.normalizedTopic,
    ideaFamily: row.angle,
    candidateId: `rejected-history:${row.id}`,
    origin: 'REJECTED_DUPLICATE_ONLY',
  }));
  return createRecentContentMemory([...accepted, ...rejected]);
}

function rankedToMemoryFingerprint(candidate: RankedTrendCandidate): RecentContentFingerprint {
  const motif = candidate.trend.conceptualMotif || candidate.trend.reasoningArchetype
    ? { conceptualMotif: candidate.trend.conceptualMotif ?? null, reasoningArchetype: candidate.trend.reasoningArchetype ?? null }
    : classifyConceptualMotif({
      claim: candidate.fingerprint.coreClaim,
      mechanism: candidate.fingerprint.mechanisms.join(' '),
      perspective: candidate.trend.audienceRelevance,
      audienceConsequence: candidate.trend.audienceConsequence,
      ideaFamily: candidate.trend.ideaFamily ?? candidate.trend.suggestedAngle,
    });
  return {
    topic: candidate.fingerprint.normalizedTopic,
    pillar: candidate.trend.matchedPillar ?? candidate.trend.originNiche ?? candidate.trend.niche,
    territory: candidate.trend.territory ?? candidate.fingerprint.topicCluster,
    coreClaim: candidate.fingerprint.coreClaim,
    mechanism: candidate.fingerprint.mechanisms.join(' '),
    perspective: candidate.trend.audienceRelevance,
    ideaFamily: candidate.trend.ideaFamily ?? candidate.trend.suggestedAngle,
    argumentPattern: candidate.trend.ideaFamily ?? candidate.trend.suggestedAngle,
    contentIntent: candidate.trend.ideaFamily ?? candidate.trend.discoveryIntent,
    authorityMode: candidate.trend.authorityMode,
    hookType: classifyHookType(candidate.fingerprint.coreClaim),
    origin: candidate.trend.sourceType === 'strategy_derived' ? 'STRATEGY_DERIVED' : 'SEARCH_DERIVED',
    ...motif,
    candidateId: `candidate:${createHash('sha256').update(`${candidate.trend.sourceType ?? ''}|${candidate.fingerprint.normalizedTopic}|${candidate.fingerprint.coreClaim}`).digest('hex').slice(0, 16)}`,
  };
}

/** Greedy soft-memory selection; each chosen candidate immediately affects the next score. */
export function selectRankedCandidatesWithMemory(
  candidates: RankedTrendCandidate[],
  count: number,
  memory: RecentContentMemory,
): RankedTrendCandidate[] {
  const selected: RankedTrendCandidate[] = [];
  const remaining = [...candidates];
  while (selected.length < count && remaining.length) {
    const ranked = remaining.map((candidate) => {
      const fingerprint = rankedToMemoryFingerprint(candidate);
      const penalty = scoreAgainstRecentContentMemory(fingerprint, memory);
      return { candidate, fingerprint, penalty, adjusted: candidate.totalScore - penalty.total };
    }).sort((a, b) => b.adjusted - a.adjusted);
    const choice = ranked.find(({ candidate }) => !selected.some((prior) => areHardBatchDuplicates(prior, candidate)));
    if (!choice) break;
    selected.push({
      ...choice.candidate,
      totalScore: choice.adjusted,
      noveltyScore: Math.max(0, choice.candidate.noveltyScore - choice.penalty.total),
      trend: {
        ...choice.candidate.trend,
        saturationPenalty: (choice.candidate.trend.saturationPenalty ?? 0) + choice.penalty.total,
        strategyReasons: [
          ...(choice.candidate.trend.strategyReasons ?? []),
          ...choice.penalty.strong.map((reason) => `content_memory_strong:${reason}`),
          ...choice.penalty.medium.map((reason) => `content_memory_medium:${reason}`),
          ...choice.penalty.light.map((reason) => `content_memory_light:${reason}`),
        ],
      },
    });
    updateRecentContentMemory(memory, { ...choice.fingerprint, origin: 'CURRENT_BATCH' });
    remaining.splice(remaining.indexOf(choice.candidate), 1);
  }
  return selected;
}
