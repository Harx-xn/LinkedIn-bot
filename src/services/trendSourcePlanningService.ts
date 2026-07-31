import type { BatchDiscoveryPlan, DiscoveryIntent, EvidenceRole, NicheExpansionPlan, NicheSourcePlan } from './generationTypes';
import { getSubredditsForNiche } from '../config/redditDomainFeeds';

export type SourceMode = 'automatic' | 'manual';
export type TrendSourceConfig = { mode: SourceMode; enabled: string[] };
export type SourceQueryRequest = { source: string; query: string; intent: DiscoveryIntent; sourceRole: EvidenceRole; confidence: number; domain?: string };

export const INTENT_SOURCES: Record<DiscoveryIntent, string[]> = {
  recent_development: ['google', 'official'], official_update: ['official', 'google'], industry_change: ['google', 'web', 'official'],
  recurring_problem: ['reddit', 'quora', 'google', 'medium'], audience_question: ['quora', 'google'], common_mistake: ['web', 'medium', 'quora', 'google'], misconception: ['quora', 'reddit', 'web', 'google'],
  verified_solution: ['official', 'web', 'google'], case_study: ['web', 'official', 'medium', 'google'], research_or_data: ['official', 'web', 'google'], beginner_guidance: ['quora', 'medium', 'google'],
  comparison_or_debate: ['web', 'reddit', 'medium', 'google'], risk_or_failure: ['google', 'web', 'reddit'], practical_implication: ['medium', 'linkedin', 'google'], emerging_opportunity: ['google', 'web', 'medium'],
};

const SOURCE_ROLES: Record<string, EvidenceRole> = {
  official: 'primary', google: 'strong_secondary', web: 'strong_secondary', medium: 'practitioner', linkedin: 'practitioner', reddit: 'problem_discovery', quora: 'question_discovery',
};

function clean(values: Array<string | undefined | null>): string[] {
  return [...new Map(values.filter((value): value is string => Boolean(value?.trim())).map((value) => [value.toLowerCase().trim(), value.trim()])).values()];
}

function domainFrom(value: string): string | null {
  try { return new URL(value.startsWith('http') ? value : `https://${value}`).hostname.replace(/^www\./, ''); } catch { return null; }
}

export function parseTrendSourceConfig(raw: string | null | undefined): TrendSourceConfig {
  void raw;
  return { mode: 'automatic', enabled: [] };
}

export type SourceAvailability = { operationalSources: string[]; unavailableSources: Array<{ source: string; reason: string }> };

export function resolveSourceAvailability(
  profile: NicheExpansionPlan,
  env: Record<string, string | undefined> = process.env,
): SourceAvailability {
  const sourcePlan = buildNicheSourcePlan(profile);
  const checks: Array<[string, boolean, string]> = [
    ['google', true, ''], ['medium', true, ''], ['linkedin', true, ''], ['quora', true, ''],
    ['web', Boolean(env.WEB_SEARCH_ENDPOINT), 'web_search_not_configured'],
    ['official', sourcePlan.officialDomains.length > 0, 'no_official_domains'],
    ['reddit', Boolean(env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET), 'reddit_oauth_not_configured'],
  ];
  return {
    operationalSources: checks.filter(([, available]) => available).map(([source]) => source),
    unavailableSources: checks.filter(([, available]) => !available).map(([source, , reason]) => ({ source, reason })),
  };
}

export function resolveAutomaticProviderJobs(
  profile: NicheExpansionPlan,
  batch: BatchDiscoveryPlan,
  env: Record<string, string | undefined> = process.env,
): { preferredSources: string[]; operationalSources: string[]; unavailableSources: Array<{ source: string; reason: string }>; jobs: SourceQueryRequest[]; intentsWithoutJobs: DiscoveryIntent[] } {
  const availability = resolveSourceAvailability(profile, env);
  const allRequests = buildSourceQueryRequests(profile, batch, { mode: 'automatic', enabled: [] });
  const jobs: SourceQueryRequest[] = [];
  const intentsWithoutJobs: DiscoveryIntent[] = [];
  for (const target of batch.intentTargets) {
    const compatible = INTENT_SOURCES[target.intent];
    const operational = compatible.filter((source) => availability.operationalSources.includes(source));
    const selectedSources = operational.slice(0, 2);
    const candidates = allRequests.filter((request) => request.intent === target.intent && selectedSources.includes(request.source));
    jobs.push(...candidates);
    if (!candidates.length) intentsWithoutJobs.push(target.intent);
  }
  return {
    preferredSources: [...new Set(batch.intentTargets.flatMap((target) => INTENT_SOURCES[target.intent]))],
    ...availability,
    jobs: [...new Map(jobs.map((job) => [`${job.intent}:${job.source}:${job.query}`, job])).values()],
    intentsWithoutJobs,
  };
}

export function buildNicheSourcePlan(profile: NicheExpansionPlan): NicheSourcePlan {
  const entities = clean(profile.importantEntities ?? []);
  const possibleDomains = clean([
    ...entities, ...(profile.productsAndPlatforms ?? []),
  ].map(domainFrom));
  const communityTerms = clean([
    profile.normalizedNiche ?? profile.niche,
    ...(profile.contentCategories?.map((category) => category.label) ?? []),
  ]).map((value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '')).filter((value) => value.length >= 3);
  return {
    officialEntities: entities,
    officialDomains: clean([
      ...(profile.sourcePlan?.officialDomains ?? []), ...possibleDomains,
      ...(profile.sourcePlan?.regulatorsAndAssociations.map((item) => item.domain) ?? []),
      ...(profile.sourcePlan?.researchSources.map((item) => item.domain) ?? []),
      ...(profile.sourcePlan?.specialistPublications.map((item) => item.domain) ?? []),
    ]),
    regulatorsAndAssociations: profile.sourcePlan?.regulatorsAndAssociations ?? [],
    researchSources: profile.sourcePlan?.researchSources ?? [],
    specialistPublications: profile.sourcePlan?.specialistPublications ?? [],
    communitySources: clean(profile.sourcePlan?.communitySources ?? communityTerms),
    relevantSubreddits: clean([...getSubredditsForNiche(profile.parentIndustry ?? profile.domain, profile.niche), ...(profile.sourcePlan?.relevantSubreddits ?? []), ...communityTerms]),
    questionSources: clean(profile.sourcePlan?.questionSources ?? ['quora']),
    excludedDomains: clean(profile.sourcePlan?.excludedDomains ?? []),
    confidence: Math.max(0, Math.min(1, profile.sourcePlan?.confidence ?? profile.confidence)),
  };
}

export function buildBatchDiscoveryPlan(requestedPosts: number): BatchDiscoveryPlan {
  const targets: Array<[DiscoveryIntent, number]> = [
    ['recent_development', 1], ['industry_change', 1], ['recurring_problem', 1], ['audience_question', 1],
    ['verified_solution', 1], ['beginner_guidance', 1], ['practical_implication', 1],
  ];
  return {
    requestedPosts,
    intentTargets: targets.slice(0, Math.max(1, requestedPosts)).map(([intent, desiredCount]) => ({ intent, desiredCount, allowedSources: INTENT_SOURCES[intent] })),
    minimumPrimaryOrStrongSources: Math.min(3, requestedPosts), maximumCommunityOnlyTopics: Math.min(2, requestedPosts), maximumAnglesPerSource: 2,
  };
}

function subjectFor(profile: NicheExpansionPlan, index: number): string {
  const subjects = clean([
    ...(profile.importantEntities ?? []), ...(profile.productsAndPlatforms ?? []),
    ...(profile.contentCategories?.flatMap((category) => [category.label, ...category.terms]) ?? []),
    ...(profile.commonProblems ?? []), ...(profile.normalizedPillars?.flatMap((pillar) => pillar.searchTerms) ?? []),
    profile.normalizedNiche ?? profile.niche,
  ]);
  return subjects[index % Math.max(1, subjects.length)] ?? profile.niche;
}

function intentQuery(intent: DiscoveryIntent, subject: string, profile: NicheExpansionPlan): string {
  const problem = profile.commonProblems?.[0] ?? subject;
  const audience = profile.audienceTypes?.[0] ?? profile.niche;
  let query: string;
  switch (intent) {
    case 'recent_development': query = `${subject} release update`; break;
    case 'official_update': query = `${subject} official guidance update`; break;
    case 'industry_change': query = `${subject} industry change report`; break;
    case 'recurring_problem': query = `${audience} struggling with ${problem}`; break;
    case 'audience_question': query = `${audience} questions about ${subject}`; break;
    case 'common_mistake': query = `${subject} common mistakes`; break;
    case 'misconception': query = `${subject} common misconception`; break;
    case 'verified_solution': query = `${problem} official guidance case study`; break;
    case 'case_study': query = `${subject} measured case study`; break;
    case 'research_or_data': query = `${subject} benchmark study report`; break;
    case 'beginner_guidance': query = `${audience} beginner guidance ${subject}`; break;
    case 'comparison_or_debate': query = `${subject} comparison debate`; break;
    case 'risk_or_failure': query = `${subject} failure risk postmortem`; break;
    case 'practical_implication': query = `${subject} practical implementation analysis`; break;
    case 'emerging_opportunity': query = `${subject} emerging opportunity report`; break;
  }
  return query.toLowerCase().includes(profile.niche.toLowerCase()) ? query : `${query} ${profile.niche}`;
}

export function buildSourceQueryRequests(profile: NicheExpansionPlan, batch: BatchDiscoveryPlan, config: TrendSourceConfig): SourceQueryRequest[] {
  const sourcePlan = buildNicheSourcePlan(profile);
  const requests: SourceQueryRequest[] = [];
  batch.intentTargets.forEach((target, index) => {
    const subject = subjectFor(profile, index);
    const baseQuery = intentQuery(target.intent, subject, profile);
    const sources = config.mode === 'manual' ? target.allowedSources.filter((source) => config.enabled.includes(source)) : target.allowedSources;
    for (const source of sources) {
      if (source === 'official') {
        for (const domain of sourcePlan.officialDomains.slice(0, 2)) requests.push({ source, query: `${baseQuery} site:${domain}`, domain, intent: target.intent, sourceRole: 'primary', confidence: sourcePlan.confidence });
      } else {
        requests.push({ source, query: baseQuery, intent: target.intent, sourceRole: SOURCE_ROLES[source] ?? 'idea_only', confidence: profile.confidence });
      }
    }
  });
  return requests;
}

export function evidenceRoleForSource(source: string): EvidenceRole { return SOURCE_ROLES[source.toLowerCase()] ?? 'idea_only'; }
