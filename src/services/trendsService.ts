import Parser from 'rss-parser';
import axios from 'axios';
import {
  getPipelineConfig,
  targetCandidateCount,
  type GoogleFreshnessLayer,
  type TrendPipelineMode,
} from '../config/trendPipelineConfig';
import { getSubredditsForNiche } from '../config/redditDomainFeeds';
import type { DiscoveryIntent, EvidenceRole, NicheExpansionPlan, SourceReference } from './generationTypes';
import { extractPublisherFromGoogleNewsTitle } from './trendPublisherUtils';
import { flattenExpansionQueries, getMediumTagsForPlan, validateExpansionQuery } from './nicheExpansionService';
import { selectPreviewQueries } from './trendPreviewQuerySelection';
import {
  buildTrendCacheKey,
  fetchTrendsWithCache,
  getTrendCacheStats,
  resetTrendCacheStats,
  type TrendFetchCachePolicy,
} from './trendFetchCache';
import {
  filterRedditFromSources,
  isRedditCircuitOpen,
  isRedditConfigured,
  logRedditSkippedOnce,
  noteRedditHttpFailure,
  resetRedditSkipLog,
} from './redditCircuit';
import {
  selectPreviewLinkedInQuery,
  selectPreviewMediumQuery,
  sourcesForPreviewQuery,
} from './trendPreviewQuerySelection';
import { mapWithConcurrency } from './concurrencyUtils';
import { countUsableTrends } from './trendSelectionService';
import { buildBatchDiscoveryPlan, buildNicheSourcePlan, resolveAutomaticProviderJobs, type ValidatedExpansionQuery } from './trendSourcePlanningService';

export function buildProviderRequestKey(params: { niche: string; source: string; providerQuery: string; freshness: string; intent: DiscoveryIntent }): string {
  const normalize = (value: string) => value.toLowerCase().trim().replace(/\s+/g, ' ');
  return [normalize(params.niche), normalize(params.source), normalize(params.providerQuery), normalize(params.freshness), params.intent].join('|');
}

export function calculateProviderResultLimit(remainingNeeded: number, executableJobs: number): number {
  return Math.max(5, Math.min(10, Math.ceil(Math.max(0, remainingNeeded) / Math.max(1, executableJobs))));
}

function batchIntentForQuery(index: number): DiscoveryIntent {
  const intents: DiscoveryIntent[] = ['recent_development', 'industry_change', 'recurring_problem', 'audience_question', 'verified_solution', 'beginner_guidance', 'practical_implication'];
  return intents[index % intents.length];
}

const OBVIOUS_LOW_VALUE = /\b(log[ -]?in|sign[ -]?in|privacy policy|terms of (use|service)|careers?|jobs?|vacanc(?:y|ies)|home page|homepage|contact us|about us)\b/i;

function normalizedTerms(plan: NicheExpansionPlan): string[] {
  return [...new Set([
    plan.normalizedNiche ?? plan.niche,
    ...(plan.importantEntities ?? []), ...(plan.entityAliases ?? []),
    ...(plan.productsAndPlatforms ?? []), ...(plan.commonProblems ?? []),
    ...(plan.contentCategories?.flatMap((category) => [category.label, ...category.terms]) ?? []),
    ...(plan.normalizedPillars?.flatMap((pillar) => [pillar.originalPillar, pillar.normalizedPillar, ...pillar.searchTerms, ...pillar.relatedEntities]) ?? []),
  ].map((value) => value.toLowerCase().trim()).filter((value) => value.length >= 3))];
}

export function preselectPlausibleTrends(
  trends: Trend[],
  plan: NicheExpansionPlan,
  limit: number,
): { selected: Trend[]; eligibleCount: number } {
  const terms = normalizedTerms(plan);
  const plausible = trends.filter((trend) => {
    const title = trend.title?.trim() ?? '';
    if (title.length < 18 || OBVIOUS_LOW_VALUE.test(title)) return false;
    const evidence = `${title} ${trend.summary ?? ''} ${trend.publisher ?? ''} ${trend.link ?? ''}`.toLowerCase();
    return terms.some((term) => evidence.includes(term));
  });
  const ranked = plausible.sort((a, b) => {
    const aEvidence = `${a.title} ${a.summary ?? ''}`.toLowerCase();
    const bEvidence = `${b.title} ${b.summary ?? ''}`.toLowerCase();
    const relevanceDelta = terms.filter((term) => bEvidence.includes(term)).length - terms.filter((term) => aEvidence.includes(term)).length;
    return relevanceDelta || Date.parse(b.pubDate || '') - Date.parse(a.pubDate || '');
  });
  const selected: Trend[] = [];
  const seenDimensions = new Set<string>();
  for (const trend of ranked) {
    const dimension = `${trend.discoveryIntent ?? 'unknown'}|${trend.originatingSource ?? trend.source}|${terms.find((term) => `${trend.title} ${trend.summary ?? ''}`.toLowerCase().includes(term)) ?? 'uncategorized'}`;
    if (!seenDimensions.has(dimension)) {
      selected.push(trend);
      seenDimensions.add(dimension);
    }
    if (selected.length >= limit) break;
  }
  for (const trend of ranked) {
    if (selected.length >= limit) break;
    if (!selected.includes(trend)) selected.push(trend);
  }
  return { selected, eligibleCount: plausible.length };
}

export interface Trend {
  title: string;
  link: string;
  pubDate: string;
  source: string;
  publisher?: string;
  discoverySource?: string;
  rawTitle?: string;
  niche?: string;
  searchQuery?: string;
  summary?: string;
  keyPoints?: string[];
  discoveryIntent?: DiscoveryIntent;
  evidenceRole?: EvidenceRole;
  supportingSources?: SourceReference[];
  originNiche?: string;
  profileFingerprint?: string;
  originatingQuery?: string;
  queryIntent?: DiscoveryIntent;
  originatingSource?: string;
}

export type TrendFetchInput = {
  niche: string;
  queries?: string[];
  exclusions?: string[];
  sources?: string[];
  limit?: number;
  expansionPlan?: NicheExpansionPlan;
  pipelineMode?: TrendPipelineMode;
  candidateTarget?: number;
  requestedCount?: number;
  cachePolicy?: TrendFetchCachePolicy;
  generationSearchRun?: GenerationSearchRun;
  freshnessLayers?: GoogleFreshnessLayer[];
};

export interface GenerationSearchRun {
  runId: string;
  executedRequestKeys: Set<string>;
  exhaustedQueries: Set<string>;
  currentRunFetches: Map<string, Promise<Trend[]>>;
  hardEligibleByNiche: Map<string, Trend[]>;
  hardEligibleCountsByNiche: Map<string, number>;
}

export type TrendFetchMetrics = {
  sourceRequestCount: number;
  cacheHits: number;
  cacheMisses: number;
  queriesGenerated: number;
  queriesRejected: number;
  queriesExecuted: number;
  queriesRejectedLowConfidence: number;
  queriesRejectedGeneric: number;
  queriesRejectedAmbiguous: number;
  freshProviderRequests: number;
  sameRunRequestsReused: number;
  skippedExhaustedRequests: number;
  freshResultsFetched: number;
  cachedResultsUsed: number;
  providerRequestsPlanned: number;
  providerRequestsUnavailable: number;
  rawProviderResults: number;
  plausibleCandidates: number;
};

export const DEFAULT_TREND_SOURCES = ['automatic'] as const;

/** Parse bot config `sources` JSON; empty/missing arrays fall back to Google News. */
export function parseTrendSources(raw: string | null | undefined): string[] {
  void raw;
  return [...DEFAULT_TREND_SOURCES];
}

export class TrendsService {
  private parser: Parser;
  private redditAccessToken: { value: string; expiresAt: number } | null = null;
  private lastFetchMetrics: TrendFetchMetrics = {
    sourceRequestCount: 0,
    cacheHits: 0,
    cacheMisses: 0,
    queriesGenerated: 0, queriesRejected: 0, queriesExecuted: 0,
    queriesRejectedLowConfidence: 0, queriesRejectedGeneric: 0, queriesRejectedAmbiguous: 0,
    freshProviderRequests: 0, sameRunRequestsReused: 0, skippedExhaustedRequests: 0, freshResultsFetched: 0, cachedResultsUsed: 0, providerRequestsPlanned: 0, providerRequestsUnavailable: 0, rawProviderResults: 0, plausibleCandidates: 0,
  };

  constructor() {
    this.parser = new Parser();
  }

  getLastFetchMetrics(): TrendFetchMetrics {
    return { ...this.lastFetchMetrics };
  }

  async fetchTrends(
    niche: string,
    sources: string[] = ['google'],
       limit: number = 10,
  ): Promise<Trend[]> {
    return this.fetchTrendsWithInput({
      niche,
      sources,
      limit,
      pipelineMode: 'generation',
    });
  }

  async fetchTrendsWithInput(input: TrendFetchInput): Promise<Trend[]> {
    const pipelineMode = input.pipelineMode ?? 'generation';
    if (pipelineMode === 'preview') {
      return this.fetchPreviewTrends(input);
    }
    return this.fetchGenerationTrends(input);
  }

  private resolveCandidateTarget(input: TrendFetchInput, mode: TrendPipelineMode): number {
    if (input.candidateTarget) return input.candidateTarget;
    const requested = input.requestedCount ?? input.limit ?? 12;
    return targetCandidateCount(mode, requested);
  }

  private beginFetchMetrics(): void {
    resetTrendCacheStats();
    this.lastFetchMetrics = { sourceRequestCount: 0, cacheHits: 0, cacheMisses: 0, queriesGenerated: 0, queriesRejected: 0, queriesExecuted: 0, queriesRejectedLowConfidence: 0, queriesRejectedGeneric: 0, queriesRejectedAmbiguous: 0, freshProviderRequests: 0, sameRunRequestsReused: 0, skippedExhaustedRequests: 0, freshResultsFetched: 0, cachedResultsUsed: 0, providerRequestsPlanned: 0, providerRequestsUnavailable: 0, rawProviderResults: 0, plausibleCandidates: 0 };
    resetRedditSkipLog();
  }

  private endFetchMetrics(): void {
    const cache = getTrendCacheStats();
    this.lastFetchMetrics.cacheHits = cache.hits;
    this.lastFetchMetrics.cacheMisses = cache.misses;
  }

  private trackSourceRequest(): void {
    this.lastFetchMetrics.sourceRequestCount += 1;
  }

  private effectiveSources(sources: string[], mode: TrendPipelineMode): string[] {
    const requested = sources.length > 0 ? sources : [...DEFAULT_TREND_SOURCES];
    const normalized = requested.includes('automatic')
      ? ['google', 'web', 'official', 'reddit', 'quora', 'medium', 'linkedin']
      : requested;
    const hadReddit = normalized.some((s) => s.toLowerCase() === 'reddit');
    const filtered = filterRedditFromSources(normalized);
    if (hadReddit && filtered.length < normalized.length) {
      logRedditSkippedOnce({
        mode,
        reason: isRedditConfigured() ? 'reddit_circuit_open' : 'reddit_not_configured',
      });
    }
    return filtered;
  }

  async fetchPreviewTrends(input: TrendFetchInput): Promise<Trend[]> {
    this.beginFetchMetrics();
    const cfg = getPipelineConfig('preview');
    const {
      niche,
      exclusions = [],
      expansionPlan,
      sources: rawSources = [...DEFAULT_TREND_SOURCES],
    } = input;

    const sources = this.effectiveSources(rawSources, 'preview');
    const candidateTarget = this.resolveCandidateTarget(input, 'preview');
    const plan = expansionPlan ?? {
      niche,
      domain: niche,
      confidence: 0.4,
      subtopics: [niche],
      queries: [niche],
      exclusions,
    };

    const previewQueries = selectPreviewQueries(plan, cfg.maxQueriesPerNiche);
    const mediumTags = getMediumTagsForPlan(plan);

    let results: Trend[] = [];
    const exclusionsList = plan.exclusions ?? exclusions;

    const hasEnough = () => countUsableTrends(results, niche, exclusionsList) >= candidateTarget;

    // Phase 1: Google 7d for all preview queries
    await mapWithConcurrency(previewQueries, cfg.sourceConcurrency, async (entry) => {
      if (hasEnough()) return;
      if (!sources.some((s) => s.toLowerCase() === 'google')) return;
      if (!sourcesForPreviewQuery(entry.category).includes('google')) return;
      const perQueryLimit = Math.max(3, Math.ceil(candidateTarget / previewQueries.length));
      const batch = await this.fetchGoogleWithLayers(entry.query, perQueryLimit, ['7d'], input.cachePolicy ?? 'use_cache');
      results.push(...batch.map((t) => ({ ...t, niche, searchQuery: entry.query })));
    });

    // Phase 2: Medium (tags only, one logical fetch)
    if (!hasEnough() && sources.some((s) => s.toLowerCase() === 'medium')) {
      const mediumLimit = Math.min(6, candidateTarget);
      const batch = await this.fetchMediumTrends(niche, mediumLimit, mediumTags, input.cachePolicy ?? 'use_cache');
      results.push(...batch.map((t) => ({ ...t, niche, searchQuery: selectPreviewMediumQuery(previewQueries) ?? niche })));
    }

    // Phase 3: LinkedIn at most one query
    if (!hasEnough() && sources.some((s) => s.toLowerCase() === 'linkedin')) {
      const linkedInQuery = selectPreviewLinkedInQuery(previewQueries) ?? plan.niche;
      const batch = await this.fetchGoogleSearchTrends(linkedInQuery, 'linkedin.com', 4, input.cachePolicy ?? 'use_cache');
      results.push(...batch.map((t) => ({ ...t, niche, searchQuery: linkedInQuery })));
    }

    // Phase 4: limited Google 30d fallback on top queries only
    if (!hasEnough() && sources.some((s) => s.toLowerCase() === 'google')) {
      const shortfall = candidateTarget - countUsableTrends(results, niche, exclusionsList);
      const topQueries = previewQueries.slice(0, 2);
      for (const entry of topQueries) {
        if (countUsableTrends(results, niche, exclusionsList) >= candidateTarget) break;
        const batch = await this.fetchGoogleWithLayers(
          entry.query,
          Math.max(2, Math.ceil(shortfall / topQueries.length)),
          ['30d'], input.cachePolicy ?? 'use_cache',
        );
        results.push(...batch.map((t) => ({ ...t, niche, searchQuery: entry.query })));
      }
    }

 

    const groundedResults = results.map((item) => {
      if (item.evidenceRole !== 'problem_discovery' && item.evidenceRole !== 'question_discovery') return item;
      const itemTokens = new Set(`${item.title} ${item.searchQuery ?? ''}`.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 4));
      const supporting = results.filter((candidate) =>
        candidate !== item
        && (candidate.evidenceRole === 'primary' || candidate.evidenceRole === 'strong_secondary')
        && `${candidate.title} ${candidate.searchQuery ?? ''}`.toLowerCase().split(/[^a-z0-9]+/).some((token) => token.length >= 4 && itemTokens.has(token)),
      ).slice(0, 3).map((candidate) => ({ url: candidate.link, publisher: candidate.publisher, source: candidate.discoverySource ?? candidate.source, evidenceRole: candidate.evidenceRole! }));
      return { ...item, supportingSources: supporting };
    });
    const deduped = this.dedupeTrends(groundedResults);
    const sorted = deduped.sort((a, b) => this.safeTime(b.pubDate) - this.safeTime(a.pubDate));
    this.endFetchMetrics();
    return sorted.slice(0, Math.max(candidateTarget, cfg.maxCandidatesPerNiche));
  }

  async fetchGenerationTrends(input: TrendFetchInput): Promise<Trend[]> {
    this.beginFetchMetrics();
    const cfg = getPipelineConfig('generation');
    const cachePolicy = input.cachePolicy ?? 'refresh';
    const generationSearchRun = input.generationSearchRun ?? {
      runId: `generation-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      executedRequestKeys: new Set<string>(), exhaustedQueries: new Set<string>(), currentRunFetches: new Map<string, Promise<Trend[]>>(),
      hardEligibleByNiche: new Map<string, Trend[]>(),
      hardEligibleCountsByNiche: new Map<string, number>(),
    };
    const {
      niche,
      queries = [niche],
      sources: rawSources = [...DEFAULT_TREND_SOURCES],
       expansionPlan,
    } = input;

    void rawSources; // Deprecated user source choices never override automatic planning.
    const candidateTarget = input.candidateTarget ?? 20;
    const previouslyEligible = generationSearchRun.hardEligibleByNiche.get(niche) ?? [];
    const remainingNeeded = Math.max(0, candidateTarget - previouslyEligible.length);

    const plan: NicheExpansionPlan = expansionPlan ?? {
      niche, domain: niche, confidence: 0, subtopics: [niche], queries, exclusions: [], queryOrigin: 'legacy_fallback',
    };
    const planQueries = [...new Set(flattenExpansionQueries(plan).map((q) => q.trim()).filter(Boolean))];
    const minQueryConfidence = Math.max(0.01, Number(process.env.TREND_MIN_QUERY_CONFIDENCE ?? 0.7) || 0.7);
    this.lastFetchMetrics.queriesGenerated = planQueries.length;
    const activeQueries: ValidatedExpansionQuery[] = [];
    const rejectedQueries: Array<{ query: string; reasons: string[]; confidence: number }> = [];
    for (const query of planQueries) {
      const validation = validateExpansionQuery(query, niche, plan.subtopics, [], plan);
      if (!validation.valid || validation.confidence < minQueryConfidence) {
        rejectedQueries.push({ query, reasons: validation.reasons, confidence: validation.confidence });
        this.lastFetchMetrics.queriesRejected++;
        if (validation.confidence < minQueryConfidence) this.lastFetchMetrics.queriesRejectedLowConfidence++;
        if (validation.reasons.some((reason) => reason.includes('generic'))) this.lastFetchMetrics.queriesRejectedGeneric++;
        if (validation.reasons.some((reason) => /ambiguous|niche_context/.test(reason))) this.lastFetchMetrics.queriesRejectedAmbiguous++;
        continue;
      }
      const matchedIntent = plan.searchIntents?.find((candidate) =>
        candidate.terms.some((term) => query.toLowerCase().includes(term.toLowerCase())),
      );
      const fallbackIntent = batchIntentForQuery(activeQueries.length);
      activeQueries.push({
        text: query,
        niche,
        queryOrigin: plan.queryOrigin ?? 'legacy_fallback',
        searchIntent: (matchedIntent?.id as DiscoveryIntent | undefined) ?? fallbackIntent,
        validationConfidence: validation.confidence,
        profileFingerprint: plan.inputFingerprint ?? '',
      });
      if (activeQueries.length >= cfg.maxQueriesPerNiche) break;
      console.info('[trend-query] provider query', {
        niche,
        planVersion: plan.version ?? null,
        profileFingerprint: plan.inputFingerprint ?? null,
        queryOrigin: plan.queryOrigin ?? 'legacy_fallback',
        searchIntent: matchedIntent?.id ?? fallbackIntent,
        query,
        validationConfidence: validation.confidence,
      });
    }
    this.lastFetchMetrics.queriesExecuted = activeQueries.length;
    if (rejectedQueries.length) console.info('[trend-query] rejected queries', { niche, rejectedQueries, counters: this.lastFetchMetrics });
    if (activeQueries.length === 0) {
      this.endFetchMetrics();
      return [];
    }

    const domain = expansionPlan?.domain ?? niche;
    const mediumTags = expansionPlan ? getMediumTagsForPlan(expansionPlan) : [];
    const layers = input.freshnessLayers ?? cfg.googleFreshnessLayers as GoogleFreshnessLayer[];

    const batchDiscoveryPlan = buildBatchDiscoveryPlan(input.requestedCount ?? input.limit ?? 7);
    const sourcePlan = buildNicheSourcePlan(plan);
    const resolution = resolveAutomaticProviderJobs({ ...plan, sourcePlan }, batchDiscoveryPlan, activeQueries);
    const validRequests = resolution.jobs.filter((request) => {
      const validation = validateExpansionQuery(request.originalQuery, niche, plan.subtopics, [], plan);
      if (validation.valid) return true;
      console.info('[trend-query] planned provider query rejected', { niche, intent: request.intent, source: request.source, query: request.query, reasons: validation.reasons });
      return false;
    });
    this.lastFetchMetrics.providerRequestsPlanned = validRequests.length;
    this.lastFetchMetrics.providerRequestsUnavailable = resolution.unavailableSources.length;
    for (const intent of resolution.intentsWithoutJobs) {
      console.warn('[trend-discovery] intent skipped', { niche, intent, reason: 'no_operational_compatible_source' });
    }
    const providerJobsBySource = validRequests.reduce<Record<string, number>>((counts, request) => {
      counts[request.source] = (counts[request.source] ?? 0) + 1;
      return counts;
    }, {});
    console.info('[trend-discovery] batch source plan', {
      niche, requestedPosts: batchDiscoveryPlan.requestedPosts,
      intentTargets: batchDiscoveryPlan.intentTargets,
      automaticSourcePlan: true,
      preferredSources: resolution.preferredSources,
      operationalSources: resolution.operationalSources,
      unavailableSources: resolution.unavailableSources,
      providerJobsCreated: validRequests.length,
      providerJobsBySource,
      officialDomains: sourcePlan.officialDomains, researchSources: sourcePlan.researchSources,
      communitySources: sourcePlan.communitySources,
    });
    const fetchJobs: Array<{ source: string; requestKey: string; run: () => Promise<Trend[]> }> = [];

    for (const request of validRequests) {
      const freshness = request.source.toLowerCase() === 'google' ? (layers[0] ?? 'fallback') : 'default';
      const freshnessSuffix = freshness === '7d' ? ' when:7d' : freshness === '30d' ? ' when:30d' : '';
      const query = request.source.toLowerCase() === 'google' ? `${request.providerQuery}${freshnessSuffix}`.trim() : request.providerQuery;
      const source = request.source;
      const requestKey = buildProviderRequestKey({ niche, source, providerQuery: query, freshness, intent: request.intent });
      if (generationSearchRun.exhaustedQueries.has(requestKey)) {
        this.lastFetchMetrics.skippedExhaustedRequests += 1;
        console.info('[trend-query] provider job', { niche, attempt: input.freshnessLayers?.[0] ?? 'default', originalValidatedQuery: request.originalQuery, providerQuery: query, queryOrigin: request.queryOrigin, searchIntent: request.searchIntent, source, freshness, requestKey, executionDecision: 'exhausted' });
        continue;
      }
      console.info('[trend-query] provider job', { niche, attempt: input.freshnessLayers?.[0] ?? 'default', originalValidatedQuery: request.originalQuery, providerQuery: query, queryOrigin: request.queryOrigin, searchIntent: request.searchIntent, source, freshness, requestKey, executionDecision: generationSearchRun.currentRunFetches.has(requestKey) ? 'inflight_reused' : 'executed' });
        fetchJobs.push({ source, requestKey, run: () => {
          const existing = generationSearchRun.currentRunFetches.get(requestKey);
          if (existing) {
            this.lastFetchMetrics.sameRunRequestsReused += 1;
            return existing;
          }
          this.lastFetchMetrics.freshProviderRequests += 1;
          generationSearchRun.executedRequestKeys.add(requestKey);
          const pending = this.fetchFromSource({
          source,
          query,
          niche,
          limit: calculateProviderResultLimit(remainingNeeded, validRequests.length),
          searchQuery: request.originalQuery,
          domain,
          mediumTags,
          googleLayers: layers,
          pipelineMode: 'generation',
          discoveryIntent: request.intent,
          evidenceRole: request.sourceRole,
          sourcePlan,
          profileFingerprint: request.profileFingerprint,
          cachePolicy,
        }).then((trends) => {
          this.lastFetchMetrics.freshResultsFetched += trends.length;
          return trends;
        }).finally(() => generationSearchRun.exhaustedQueries.add(requestKey));
          generationSearchRun.currentRunFetches.set(requestKey, pending);
          return pending;
        } });
    }

  

    const results: Trend[] = [];
    const rawResultsBySource: Record<string, number> = {};
    await mapWithConcurrency(fetchJobs, cfg.sourceConcurrency, async (job) => {
      try {
        const batch = await job.run();
        rawResultsBySource[job.source] = (rawResultsBySource[job.source] ?? 0) + batch.length;
        results.push(...batch);
      } catch (error) {
        console.warn('[trends] source fetch failed', {
          niche,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
    console.info('[trend-discovery] provider execution completed', {
      niche, automaticSourcePlan: true, providerJobsCreated: fetchJobs.length,
      providerJobsBySource, rawResultsBySource, totalRawFetched: results.length,
    });
    console.info('[trend-discovery] cache policy summary', {
      niche, mode: 'generation', cachePolicy, providerJobsCreated: fetchJobs.length,
      cachedResultsUsed: this.lastFetchMetrics.cachedResultsUsed,
      freshProviderRequests: this.lastFetchMetrics.freshProviderRequests,
      sameRunRequestsReused: this.lastFetchMetrics.sameRunRequestsReused,
      skippedExhaustedRequests: this.lastFetchMetrics.skippedExhaustedRequests,
      freshResultsFetched: this.lastFetchMetrics.freshResultsFetched,
    });

    const groundedResults = results.map((item) => {
      if (item.evidenceRole !== 'problem_discovery' && item.evidenceRole !== 'question_discovery') return item;
      const itemTokens = new Set(`${item.title} ${item.searchQuery ?? ''}`.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 4));
      const supporting = results.filter((candidate) => candidate !== item
        && (candidate.evidenceRole === 'primary' || candidate.evidenceRole === 'strong_secondary')
        && `${candidate.title} ${candidate.searchQuery ?? ''}`.toLowerCase().split(/[^a-z0-9]+/).some((token) => token.length >= 4 && itemTokens.has(token)))
        .slice(0, 3).map((candidate) => ({ url: candidate.link, publisher: candidate.publisher, source: candidate.discoverySource ?? candidate.source, evidenceRole: candidate.evidenceRole! }));
      return { ...item, supportingSources: supporting };
    });
    const deduped = this.dedupeTrends(groundedResults);
    const preQualificationTarget = candidateTarget * 2;
    const plausible = preselectPlausibleTrends(deduped, plan, preQualificationTarget);
    this.lastFetchMetrics.rawProviderResults = results.length;
    this.lastFetchMetrics.plausibleCandidates = plausible.eligibleCount;
    const cumulativeEligible = this.dedupeTrends([...previouslyEligible, ...plausible.selected]);
    generationSearchRun.hardEligibleByNiche.set(niche, cumulativeEligible);
    console.info('[trend-discovery] niche pool prepared', {
      niche,
      providerResults: results.length,
      exactDuplicatesRemoved: results.length - deduped.length,
      obviousLowValueRemoved: deduped.length - plausible.eligibleCount,
      plausibleCandidatesBeforeCap: plausible.eligibleCount,
      candidatesAfterCap: plausible.selected.length,
      fullyQualified: null,
      cumulativeRaw: previouslyEligible.length + results.length,
      cumulativeHardEligible: cumulativeEligible.length,
      targetHardEligible: candidateTarget,
      remainingNeeded: Math.max(0, candidateTarget - cumulativeEligible.length),
      newRawThisAttempt: results.length,
      newHardEligibleThisAttempt: cumulativeEligible.length - previouslyEligible.length,
      providerJobsPlanned: validRequests.length,
      providerJobsExecuted: fetchJobs.length,
      resultLimitPerJob: calculateProviderResultLimit(remainingNeeded, validRequests.length),
      searchSpaceExhausted: validRequests.length === 0,
      stopReason: cumulativeEligible.length >= candidateTarget ? 'target_hard_eligible_reached' : validRequests.length === 0 ? 'no_provider_jobs_remaining' : null,
    });
    this.endFetchMetrics();
    return cumulativeEligible;
  }

  private async fetchFromSource(params: {
    source: string;
    query: string;
    niche: string;
    limit: number;
    searchQuery: string;
    domain: string;
    mediumTags: string[];
    googleLayers: GoogleFreshnessLayer[];
    pipelineMode: TrendPipelineMode;
    discoveryIntent?: DiscoveryIntent;
    evidenceRole?: EvidenceRole;
    sourcePlan?: ReturnType<typeof buildNicheSourcePlan>;
    profileFingerprint?: string;
    cachePolicy: TrendFetchCachePolicy;
  }): Promise<Trend[]> {
    const { source, query, niche, limit, searchQuery, domain, mediumTags, googleLayers } = params;
    let items: Trend[] = [];
    switch (source.toLowerCase()) {
      case 'reddit':
        if (!isRedditConfigured() || isRedditCircuitOpen()) return [];
        items = await this.fetchRedditTrends(domain, niche, query, limit, params.sourcePlan?.relevantSubreddits);
        break;
      case 'medium':
        items = await this.fetchMediumTrends(niche, limit, mediumTags, params.cachePolicy);
        break;
      case 'google':
        items = await this.fetchGoogleSearchTrends(query, undefined, limit, params.cachePolicy);
        break;
      case 'web':
        items = await this.fetchWebSearchTrends(query, limit);
        break;
      case 'official':
        items = await this.fetchGoogleSearchTrends(query, undefined, limit, params.cachePolicy);
        break;
      case 'linkedin':
        items = await this.fetchGoogleSearchTrends(query, undefined, limit, params.cachePolicy);
        break;
      case 'quora':
        items = await this.fetchGoogleSearchTrends(query, undefined, limit, params.cachePolicy);
        break;
      default:
        items = [];
    }
    return items.map((t) => ({
      ...t,
      niche,
      searchQuery,
      discoveryIntent: params.discoveryIntent,
      evidenceRole: params.evidenceRole,
      originNiche: niche,
      profileFingerprint: params.profileFingerprint,
      originatingQuery: searchQuery,
      queryIntent: params.discoveryIntent,
      originatingSource: source,
    }));
  }

  async fetchRedditTrends(domain: string, niche: string, query: string, limit: number = 5, profileSubreddits: string[] = []): Promise<Trend[]> {
    if (!isRedditConfigured() || isRedditCircuitOpen()) return [];

    const subreddits = [...new Set([...getSubredditsForNiche(domain, niche), ...profileSubreddits])];
    const results: Trend[] = [];

    if (subreddits.length > 0) {
      for (const sub of subreddits.slice(0, 6)) {
        if (isRedditCircuitOpen()) break;
        for (const window of ['week', 'month', 'year'] as const) {
          const url = `https://oauth.reddit.com/r/${sub}/search?q=${encodeURIComponent(query)}&restrict_sr=1&sort=relevance&t=${window}&limit=${Math.min(25, limit)}`;
          const batch = await this.fetchRedditJsonTrends(url, limit);
          const cutoff = window === 'year' ? Date.now() - 90 * 86400000 : 0;
          results.push(...batch.filter((item) => !cutoff || Date.parse(item.pubDate) >= cutoff));
          if (this.dedupeTrends(results).length >= limit) break;
        }
        if (this.dedupeTrends(results).length >= limit) break;
      }
    } else {
      console.debug('[trends] no subreddit mapping; skipping Reddit search', { domain, niche });
    }

    return results.slice(0, limit);
  }

  async fetchRedditJsonTrends(url: string, limit: number = 5): Promise<Trend[]> {
    if (!isRedditConfigured() || isRedditCircuitOpen()) return [];

    try {
      this.trackSourceRequest();
      const token = await this.getRedditAccessToken();
      const { data } = await axios.get(url, {
        headers: {
          'User-Agent': process.env.REDDIT_USER_AGENT || 'VeyraisContentIntelligence/1.0',
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        timeout: 8000,
      });

      if (!data?.data?.children) return [];

      return data.data.children.slice(0, limit).map((child: { data: { title: string; permalink: string; created_utc: number; subreddit_name_prefixed: string; selftext?: string; score?: number; num_comments?: number } }) => ({
        title: child.data.title,
        link: `https://www.reddit.com${child.data.permalink}`,
        pubDate: new Date(child.data.created_utc * 1000).toISOString(),
        source: `Reddit (${child.data.subreddit_name_prefixed})`,
        publisher: child.data.subreddit_name_prefixed,
        discoverySource: 'Reddit',
        summary: child.data.selftext?.slice(0, 1200),
        keyPoints: [`score:${child.data.score ?? 0}`, `comments:${child.data.num_comments ?? 0}`],
        evidenceRole: 'problem_discovery' as const,
      }));
    } catch (error: unknown) {
      const status = (error as { response?: { status?: number } })?.response?.status;
      noteRedditHttpFailure(status);
      if (status !== 404) {
        console.warn('[trends] Reddit fetch failed', {
          url: url.slice(0, 120),
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return [];
    }
  }

  private async getRedditAccessToken(): Promise<string> {
    if (this.redditAccessToken && this.redditAccessToken.expiresAt > Date.now() + 30000) return this.redditAccessToken.value;
    const clientId = process.env.REDDIT_CLIENT_ID;
    const clientSecret = process.env.REDDIT_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error('reddit_not_configured');
    const body = new URLSearchParams({ grant_type: 'client_credentials' });
    const { data } = await axios.post('https://www.reddit.com/api/v1/access_token', body.toString(), {
      auth: { username: clientId, password: clientSecret },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': process.env.REDDIT_USER_AGENT || 'VeyraisContentIntelligence/1.0' },
      timeout: 8000,
    });
    if (!data?.access_token) throw new Error('reddit_oauth_token_missing');
    this.redditAccessToken = { value: data.access_token, expiresAt: Date.now() + Math.max(60, Number(data.expires_in ?? 3600)) * 1000 };
    return data.access_token;
  }

  async fetchWebSearchTrends(query: string, limit: number = 5): Promise<Trend[]> {
    const endpoint = process.env.WEB_SEARCH_ENDPOINT;
    if (!endpoint) {
      console.info('[trends] web search skipped', { reason: 'web_search_not_configured', query: query.slice(0, 100) });
      return [];
    }
    try {
      this.trackSourceRequest();
      const { data } = await axios.get(endpoint, {
        params: { q: query, limit },
        headers: process.env.WEB_SEARCH_API_KEY ? { Authorization: `Bearer ${process.env.WEB_SEARCH_API_KEY}` } : undefined,
        timeout: 10000,
      });
      const items = Array.isArray(data?.results) ? data.results : Array.isArray(data?.items) ? data.items : [];
      return items.slice(0, limit).map((item: any) => ({
        title: String(item.title ?? 'No Title'), link: String(item.url ?? item.link ?? ''),
        pubDate: String(item.publishedAt ?? item.date ?? ''), source: String(item.publisher ?? item.source ?? 'Web Search'),
        publisher: String(item.publisher ?? item.source ?? 'Web Search'), discoverySource: 'Web Search',
        summary: typeof item.snippet === 'string' ? item.snippet : typeof item.description === 'string' ? item.description : undefined,
        evidenceRole: 'strong_secondary' as const,
      }));
    } catch (error) {
      console.warn('[trends] web search failed', { query: query.slice(0, 100), message: error instanceof Error ? error.message : String(error) });
      return [];
    }
  }

  normalizeMediumTag(topic: string): string | null {
    const tag = topic
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-');
    if (!tag || tag.length > 40 || tag.split('-').length > 4) return null;
    return tag;
  }

  async fetchMediumTrends(niche: string, limit: number = 5, mediumTags: string[] = [], cachePolicy: TrendFetchCachePolicy = 'use_cache'): Promise<Trend[]> {
    const tags = mediumTags.length
      ? mediumTags
      : [this.normalizeMediumTag(niche)].filter((t): t is string => !!t);

    if (tags.length === 0) {
      console.debug('[trends] skipping Medium; no valid tags', { niche });
      return [];
    }

    const results: Trend[] = [];
    for (const tag of tags.slice(0, 2)) {
      const cacheKey = buildTrendCacheKey({ source: 'medium', query: tag });
      try {
        const batch = await fetchTrendsWithCache(cacheKey, 'medium', async () => {
          this.trackSourceRequest();
          const url = `https://medium.com/feed/tag/${encodeURIComponent(tag)}`;
          const feed = await this.parser.parseURL(url);
          return (feed.items || []).slice(0, limit).map((item) => ({
            title: item.title || 'No Title',
            link: item.link || '',
            pubDate: item.pubDate || '',
            source: 'Medium',
            publisher: 'Medium',
            discoverySource: 'Medium',
          }));
        }, cachePolicy);
        results.push(...batch);
      } catch (error) {
        console.warn('[trends] Medium fetch failed', {
          tag,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results.slice(0, limit);
  }

  async fetchGoogleWithLayers(
    query: string,
    limit: number = 5,
    layers: GoogleFreshnessLayer[] = ['7d', '30d', 'fallback'],
    cachePolicy: TrendFetchCachePolicy = 'use_cache',
  ): Promise<Trend[]> {
    const merged: Trend[] = [];

    for (const layer of layers) {
      const suffix = layer === '7d' ? ' when:7d' : layer === '30d' ? ' when:30d' : '';
      const cacheKey = buildTrendCacheKey({
        source: 'google',
        query,
        freshness: layer,
      });
      const batch = await fetchTrendsWithCache(cacheKey, 'google', async () => {
        return this.fetchGoogleSearchTrends(`${query}${suffix}`.trim(), undefined, limit, 'bypass');
      }, cachePolicy);
      merged.push(...batch);
      const deduped = this.dedupeTrends(merged);
      if (deduped.length >= limit) return deduped.slice(0, limit);
    }

    return this.dedupeTrends(merged).slice(0, limit);
  }

  async fetchGoogleTrendsLayered(query: string, limit: number = 5): Promise<Trend[]> {
    return this.fetchGoogleWithLayers(query, limit, ['7d', '30d', 'fallback']);
  }

  async fetchGoogleSearchTrends(niche: string, site?: string, limit: number = 5, cachePolicy: TrendFetchCachePolicy = 'use_cache'): Promise<Trend[]> {
    try {
      const query = site ? `${niche} site:${site}` : niche;
      const cacheKey = buildTrendCacheKey({
        source: site ? 'linkedin' : 'google',
        query,
        freshness: 'default',
      });
      return await fetchTrendsWithCache(cacheKey, site ? 'linkedin' : 'google', async () => {
        this.trackSourceRequest();
        const encodedQuery = encodeURIComponent(query);
        const url = `https://news.google.com/rss/search?q=${encodedQuery}&hl=en-US&gl=US&ceid=US:en`;

        const feed = await this.parser.parseURL(url);
        const discoverySource = site ? `Google News (${site})` : 'Google News';

        return (feed.items || []).slice(0, limit).map((item) => {
          const rawTitle = item.title || 'No Title';
          const parsed = extractPublisherFromGoogleNewsTitle(rawTitle, discoverySource);
          return {
            title: parsed.title,
            link: item.link || '',
            pubDate: item.pubDate || '',
            source: parsed.publisher,
            publisher: parsed.publisher,
            discoverySource: parsed.discoverySource,
            rawTitle: parsed.rawTitle,
          };
        });
      }, cachePolicy);
    } catch (error) {
      console.warn('[trends] Google News fetch failed', {
        query: niche.slice(0, 80),
        site,
        message: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  async fetchGoogleTrends(topic: string, limit: number = 5): Promise<Trend[]> {
    return this.fetchGoogleTrendsLayered(topic, limit);
  }

  async fetchCustomTrends(links: string[], limit: number = 5): Promise<Trend[]> {
    return links.slice(0, limit).map((link) => {
      let title = link;
      try {
        const urlObj = new URL(link);

        const keyword = urlObj.searchParams.get('keywords') || urlObj.searchParams.get('q') || urlObj.searchParams.get('tag');

        if (keyword) {
          title = keyword.charAt(0).toUpperCase() + keyword.slice(1);
        } else {
          const segments = urlObj.pathname.split('/').filter((s) => s.length > 0);
          const lastSegment = segments.pop();
          if (lastSegment) {
            title = lastSegment.replace(/[-_]/g, ' ');
            title = title.charAt(0).toUpperCase() + title.slice(1);
          }
        }
      } catch {
        // keep link as title
      }

      return {
        title,
        link,
        pubDate: new Date().toISOString(),
        source: 'Custom Link',
        publisher: 'Custom Link',
        discoverySource: 'Custom Link',
      };
    });
  }

  private safeTime(d: string): number {
    const t = Date.parse(d || '');
    return Number.isFinite(t) ? t : 0;
  }

  private dedupeTrends(trends: Trend[]): Trend[] {
    const map = new Map<string, Trend>();
    for (const t of trends) {
      const key = `${(t.title || '').trim().toLowerCase()}|${(t.link || '').trim().toLowerCase()}`;
      if (!map.has(key)) map.set(key, t);
    }
    return Array.from(map.values());
  }
}
