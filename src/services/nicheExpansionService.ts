import OpenAI from 'openai';
import { z } from 'zod';
import { prisma } from '../prismaClient';
import { createHash } from 'node:crypto';
import { NICHE_EXPANSION_PLAN_VERSION } from '../config/topicDiversityConfig';
import type { NicheExpansionPlan, NicheQueryBuckets } from './generationTypes';
import { buildNicheSourcePlan } from './trendSourcePlanningService';

export const NICHE_EXPANSION_SYSTEM_PROMPT = `
You create structured content-discovery plans from user-provided niches.

Given a niche:
- infer the broad domain
- create narrower subtopics when useful
- generate event-oriented and insight-oriented search queries for Google News and RSS
- prefer notable events, organizational changes, sector reports, regulation, policy updates, documented incidents, research publications, evidence-based practice, and expert analysis
- avoid generic SEO phrases like "custom X development", "build X product", or "X services"
- generate concise Medium tags separately (1-3 words, hyphen-safe) — never use full news queries as Medium tags
- keep all queries relevant to the niche
- normalize ambiguous niche meanings and list required context plus excluded interpretations
- create niche-native content categories and search intents; never use a fixed global category list
- identify domain terminology, entities, audience problems, and desired outcomes
- never assume the niche is technology, medical, legal, financial, or commercial unless appropriate
- avoid jobs, hiring, internships, agencies, directories, promotional services, pricing pages, and press-release content
- return valid JSON only
`;

const nicheExpansionSchema = z.object({
  niche: z.string().min(1).max(120),
  domain: z.string().min(2).max(80),
  confidence: z.number().min(0).max(1),
  subtopics: z.array(z.string().min(2).max(120)).min(3).max(10),
  queries: z.array(z.string().min(5).max(180)).min(12).max(20),
  exclusions: z.array(z.string().min(2).max(120)).max(20),
  normalizedNiche: z.string().min(1).max(120),
  nicheDescription: z.string().min(2).max(500),
  audienceTypes: z.array(z.string()).max(12),
  commonProblems: z.array(z.string()).max(12),
  desiredOutcomes: z.array(z.string()).max(12),
  importantEntities: z.array(z.string()).max(20),
  terminology: z.array(z.string()).max(30),
  requiredContextTerms: z.array(z.string()).max(15),
  preferredTerms: z.array(z.string()).max(20),
  excludedTerms: z.array(z.string()).max(20),
  excludedInterpretations: z.array(z.string()).max(12),
  contentCategories: z.array(z.object({ id: z.string(), label: z.string(), terms: z.array(z.string()).max(12) })).min(3).max(15),
  searchIntents: z.array(z.object({ id: z.string(), label: z.string(), terms: z.array(z.string()).max(10) })).min(3).max(12),
  sourcePlan: z.object({
    officialEntities: z.array(z.string()).max(20), officialDomains: z.array(z.string()).max(20),
    regulatorsAndAssociations: z.array(z.object({ name: z.string(), domain: z.string().nullable().transform((value) => value ?? undefined) })).max(15),
    researchSources: z.array(z.object({ name: z.string(), domain: z.string().nullable().transform((value) => value ?? undefined), sourceType: z.string() })).max(15),
    specialistPublications: z.array(z.object({ name: z.string(), domain: z.string().nullable().transform((value) => value ?? undefined) })).max(15),
    communitySources: z.array(z.string()).max(20), relevantSubreddits: z.array(z.string()).max(20),
    questionSources: z.array(z.string()).max(10), excludedDomains: z.array(z.string()).max(20), confidence: z.number().min(0).max(1),
  }),
});

const NICHE_EXPANSION_OPENAI_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['niche', 'domain', 'confidence', 'subtopics', 'queries', 'exclusions', 'normalizedNiche', 'nicheDescription', 'audienceTypes', 'commonProblems', 'desiredOutcomes', 'importantEntities', 'terminology', 'requiredContextTerms', 'preferredTerms', 'excludedTerms', 'excludedInterpretations', 'contentCategories', 'searchIntents', 'sourcePlan'],
  properties: {
    niche: { type: 'string', minLength: 1, maxLength: 120 },
    domain: { type: 'string', minLength: 2, maxLength: 80 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    subtopics: { type: 'array', items: { type: 'string', minLength: 2, maxLength: 120 }, minItems: 3, maxItems: 10 },
    queries: { type: 'array', items: { type: 'string', minLength: 5, maxLength: 180 }, minItems: 12, maxItems: 20 },
    exclusions: { type: 'array', items: { type: 'string', minLength: 2, maxLength: 120 }, maxItems: 20 },
    normalizedNiche: { type: 'string', minLength: 1, maxLength: 120 },
    nicheDescription: { type: 'string', minLength: 2, maxLength: 500 },
    audienceTypes: { type: 'array', items: { type: 'string' }, maxItems: 12 },
    commonProblems: { type: 'array', items: { type: 'string' }, maxItems: 12 },
    desiredOutcomes: { type: 'array', items: { type: 'string' }, maxItems: 12 },
    importantEntities: { type: 'array', items: { type: 'string' }, maxItems: 20 },
    terminology: { type: 'array', items: { type: 'string' }, maxItems: 30 },
    requiredContextTerms: { type: 'array', items: { type: 'string' }, maxItems: 15 },
    preferredTerms: { type: 'array', items: { type: 'string' }, maxItems: 20 },
    excludedTerms: { type: 'array', items: { type: 'string' }, maxItems: 20 },
    excludedInterpretations: { type: 'array', items: { type: 'string' }, maxItems: 12 },
    contentCategories: { type: 'array', minItems: 3, maxItems: 15, items: { type: 'object', additionalProperties: false, required: ['id', 'label', 'terms'], properties: { id: { type: 'string' }, label: { type: 'string' }, terms: { type: 'array', items: { type: 'string' }, maxItems: 12 } } } },
    searchIntents: { type: 'array', minItems: 3, maxItems: 12, items: { type: 'object', additionalProperties: false, required: ['id', 'label', 'terms'], properties: { id: { type: 'string' }, label: { type: 'string' }, terms: { type: 'array', items: { type: 'string' }, maxItems: 10 } } } },
    sourcePlan: { type: 'object', additionalProperties: false, required: ['officialEntities', 'officialDomains', 'regulatorsAndAssociations', 'researchSources', 'specialistPublications', 'communitySources', 'relevantSubreddits', 'questionSources', 'excludedDomains', 'confidence'], properties: {
      officialEntities: { type: 'array', items: { type: 'string' }, maxItems: 20 }, officialDomains: { type: 'array', items: { type: 'string' }, maxItems: 20 },
      regulatorsAndAssociations: { type: 'array', maxItems: 15, items: { type: 'object', additionalProperties: false, required: ['name', 'domain'], properties: { name: { type: 'string' }, domain: { type: ['string', 'null'] } } } },
      researchSources: { type: 'array', maxItems: 15, items: { type: 'object', additionalProperties: false, required: ['name', 'domain', 'sourceType'], properties: { name: { type: 'string' }, domain: { type: ['string', 'null'] }, sourceType: { type: 'string' } } } },
      specialistPublications: { type: 'array', maxItems: 15, items: { type: 'object', additionalProperties: false, required: ['name', 'domain'], properties: { name: { type: 'string' }, domain: { type: ['string', 'null'] } } } },
      communitySources: { type: 'array', items: { type: 'string' }, maxItems: 20 }, relevantSubreddits: { type: 'array', items: { type: 'string' }, maxItems: 20 }, questionSources: { type: 'array', items: { type: 'string' }, maxItems: 10 }, excludedDomains: { type: 'array', items: { type: 'string' }, maxItems: 20 }, confidence: { type: 'number', minimum: 0, maximum: 1 },
    } },
  },
} as const;

const JOB_QUERY_PATTERNS = [
  /\bhiring\b/i,
  /\bjob(s)?\b/i,
  /\bintern(ship)?\b/i,
  /\bagency\b/i,
  /\bpricing\b/i,
  /\bcost\b/i,
  /\bpress release\b/i,
];

const DOMAIN_MISMATCH_PAIRS: Array<{ nicheHint: RegExp; badPhrase: RegExp }> = [
  { nicheHint: /\b(diseases?|health|medical|clinical)\b/i, badPhrase: /\b(developer tools?|saas|software deployment|api design)\b/i },
  { nicheHint: /\b(real estate|property|housing)\b/i, badPhrase: /\b(clinical|disease|vaccine|diagnosis)\b/i },
  { nicheHint: /\b(fitness|workout|exercise)\b/i, badPhrase: /\b(legal compliance|tax law|mortgage)\b/i },
];

export function normalizeNicheKey(niche: string): string {
  return niche.trim().toLowerCase().replace(/\s+/g, ' ');
}

function slug(value: string): string {
  return normalizeNicheKey(value).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'unclassified';
}

function uniqueText(values: string[]): string[] {
  return [...new Map(values.map((value) => [normalizeNicheKey(value), value.trim()])).values()].filter(Boolean);
}

function deriveEntityAliases(values: string[]): string[] {
  const removableSuffix = /\s+(technologies|technology|corporation|corp|incorporated|inc|company|platform|engine|foundation|association|institute|group)$/i;
  return uniqueText(values.flatMap((value) => {
    const trimmed = value.trim();
    const withoutSuffix = trimmed.replace(removableSuffix, '').trim();
    const words = trimmed.split(/[^A-Za-z0-9]+/).filter(Boolean);
    const acronym = words.length >= 2 ? words.map((word) => word[0]).join('') : '';
    return [trimmed, ...(withoutSuffix !== trimmed && withoutSuffix.length >= 3 ? [withoutSuffix] : []), ...(acronym.length >= 2 ? [acronym] : [])];
  }));
}

/** Upgrade legacy expansion plans into the cached generic niche profile. */
export function enrichNicheExpansionPlan(plan: NicheExpansionPlan): NicheExpansionPlan {
  const normalizedNiche = plan.normalizedNiche?.trim() || plan.niche.trim();
  const categories = plan.contentCategories?.length
    ? plan.contentCategories
    : uniqueText(plan.subtopics).map((label) => ({ id: slug(label), label, terms: uniqueText([label]) }));
  const intents = plan.searchIntents?.length
    ? plan.searchIntents
    : [
        { id: 'current_change', label: 'Current change', terms: ['update', 'change', 'announcement'] },
        { id: 'research_evidence', label: 'Research and evidence', terms: ['research', 'study', 'report', 'evidence'] },
        { id: 'practice_outcomes', label: 'Practice and outcomes', terms: ['case study', 'outcomes', 'lessons'] },
      ];
  const required = plan.requiredContextTerms?.length
    ? plan.requiredContextTerms
    : normalizedNiche.split(/\s+/).filter((term) => term.length >= 3);
  const profileQueries = plan.profileQueries?.length
    ? plan.profileQueries
    : plan.queries.map((query) => {
        const lower = query.toLowerCase();
        const intent = intents.find((item) => item.terms.some((term) => lower.includes(term.toLowerCase())));
        const category = categories.find((item) => [item.label, ...item.terms].some((term) => lower.includes(term.toLowerCase())));
        const entity = plan.importantEntities?.find((item) => lower.includes(item.toLowerCase())) ?? null;
        return { query, intent: intent?.id ?? 'unclassified_intent', dynamicCategory: category?.id ?? null, relatedEntity: entity, relatedPillar: null, confidence: intent && (category || entity) ? 0.9 : 0.55, origin: 'niche_profile' as const };
      });
  const profile = {
    ...plan,
    originalNiche: plan.originalNiche || plan.niche,
    normalizedNiche,
    parentIndustry: plan.parentIndustry || plan.domain,
    nicheDescription: plan.nicheDescription || `${normalizedNiche} topics and developments`,
    audienceTypes: plan.audienceTypes ?? [],
    commonProblems: plan.commonProblems ?? [],
    desiredOutcomes: plan.desiredOutcomes ?? [],
    importantEntities: plan.importantEntities ?? [],
    entityAliases: deriveEntityAliases([
      ...(plan.entityAliases ?? []),
      ...(plan.importantEntities ?? []),
      ...(plan.productsAndPlatforms ?? []),
    ]),
    productsAndPlatforms: plan.productsAndPlatforms ?? [],
    terminology: uniqueText(plan.terminology ?? plan.subtopics),
    adjacentTopics: plan.adjacentTopics ?? [],
    requiredContextTerms: uniqueText(required),
    preferredTerms: uniqueText(plan.preferredTerms ?? plan.subtopics),
    excludedTerms: uniqueText([...(plan.excludedTerms ?? []), ...plan.exclusions]),
    excludedInterpretations: plan.excludedInterpretations ?? [],
    contentCategories: categories,
    normalizedPillars: plan.normalizedPillars ?? [],
    searchIntents: intents,
    profileQueries,
    queryOrigin: plan.version === NICHE_EXPANSION_PLAN_VERSION ? 'niche_profile' : 'legacy_fallback',
  } satisfies NicheExpansionPlan;
  return {
    ...profile,
    sourcePlan: buildNicheSourcePlan(profile),
    inputFingerprint: createHash('sha256').update(JSON.stringify({
      niche: profile.normalizedNiche,
      categories: profile.contentCategories,
      pillars: profile.normalizedPillars,
      excluded: profile.excludedTerms,
    })).digest('hex').slice(0, 20),
  };
}

export function buildEventOrientedFallbackQueries(niche: string): string[] {
  return buildProfileGroundedQueries({
    niche,
    domain: niche,
    confidence: 0.4,
    subtopics: [niche],
    queries: [],
    exclusions: [],
    version: NICHE_EXPANSION_PLAN_VERSION,
    contentCategories: [{ id: slug(niche), label: niche, terms: [niche] }],
    requiredContextTerms: [niche],
  });
}

const DISCOVERY_INTENTS = ['release update', 'benchmark study', 'case study', 'policy update', 'adoption report', 'practitioner analysis'] as const;

/** Build executable searches only from the current profile; no shared niche vocabulary is injected. */
export function buildProfileGroundedQueries(profile: Partial<NicheExpansionPlan>): string[] {
  const niche = profile.normalizedNiche?.trim() || profile.niche?.trim() || '';
  const subjects = uniqueText([
    ...(profile.importantEntities ?? []),
    ...(profile.productsAndPlatforms ?? []),
    ...(profile.contentCategories?.flatMap((category) => [category.label, ...category.terms]) ?? []),
    ...(profile.normalizedPillars?.flatMap((pillar) => [pillar.normalizedPillar, ...pillar.searchTerms, ...pillar.relatedEntities]) ?? []),
    ...(profile.commonProblems ?? []),
    ...(profile.subtopics ?? []),
    niche,
  ]).filter((value) => value.length >= 3);
  const context = uniqueText([...(profile.requiredContextTerms ?? []), niche]).find(Boolean) ?? niche;
  if (!subjects.length || !context) return [];

  const queries: string[] = [];
  for (let index = 0; index < Math.max(12, subjects.length); index++) {
    const subject = subjects[index % subjects.length];
    const intent = DISCOVERY_INTENTS[index % DISCOVERY_INTENTS.length];
    const contextualized = normalizeNicheKey(subject).includes(normalizeNicheKey(context))
      ? `${subject} ${intent}`
      : `${subject} ${intent} ${context}`;
    queries.push(contextualized);
  }
  return uniqueText(queries).slice(0, 20);
}

export function repairExpansionQuery(
  query: string,
  reasons: string[],
  profile: Partial<NicheExpansionPlan>,
  attempt: number,
): string | null {
  if (attempt < 1 || attempt > 2) return null;
  const candidates = buildProfileGroundedQueries(profile);
  if (!candidates.length) return null;
  const reasonOffset = reasons.join('|').length % candidates.length;
  return normalizeNicheKey(candidates[(reasonOffset + attempt - 1) % candidates.length]) === normalizeNicheKey(query)
    ? candidates[(reasonOffset + attempt) % candidates.length]
    : candidates[(reasonOffset + attempt - 1) % candidates.length];
}

/** @deprecated use buildEventOrientedFallbackQueries */
export function buildFallbackQueries(niche: string): string[] {
  return buildEventOrientedFallbackQueries(niche);
}

export function buildFallbackQueryBuckets(niche: string): NicheQueryBuckets {
  const tag = niche.toLowerCase().trim().replace(/[^a-z0-9\s-]/g, '').split(/\s+/).slice(0, 2).join('-');
  return {
    newsQueries: [
      `"${niche}" announcement`,
      `"${niche}" current developments`,
      `"${niche}" organizations update`,
    ],
    marketQueries: [
      `"${niche}" market report`,
      `"${niche}" industry outlook`,
    ],
    technicalQueries: [
      `"${niche}" methods practice change`,
      `"${niche}" applied lessons`,
    ],
    researchQueries: [
      `"${niche}" research study`,
      `"${niche}" clinical findings`,
    ],
    evergreenQueries: [
      `"${niche}" best practices`,
      `"${niche}" lessons learned`,
    ],
    mediumTags: tag ? [tag] : [],
  };
}

export function flattenExpansionQueries(plan: NicheExpansionPlan): string[] {
  if (plan.queryBuckets) {
    const b = plan.queryBuckets;
    return [
      ...b.newsQueries,
      ...b.marketQueries,
      ...b.technicalQueries,
      ...b.researchQueries,
      ...b.evergreenQueries,
    ].filter(Boolean);
  }
  return plan.queries;
}

export function getMediumTagsForPlan(plan: NicheExpansionPlan): string[] {
  if (plan.queryBuckets?.mediumTags?.length) {
    return plan.queryBuckets.mediumTags;
  }
  const tag = plan.niche
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-');
  if (!tag || tag.length > 40) return [];
  return [tag, ...plan.subtopics.slice(0, 2).map((s) => s.toLowerCase().replace(/\s+/g, '-'))].slice(0, 3);
}

export function buildQueryBucketsFromQueries(queries: string[], niche: string): NicheQueryBuckets {
  const fallback = buildFallbackQueryBuckets(niche);
  const buckets: NicheQueryBuckets = {
    newsQueries: [],
    marketQueries: [],
    technicalQueries: [],
    researchQueries: [],
    evergreenQueries: [],
    mediumTags: fallback.mediumTags,
  };

  for (const q of queries) {
    const lower = q.toLowerCase();
    if (/\b(research|study|clinical|trial|findings)\b/.test(lower)) buckets.researchQueries.push(q);
    else if (/\b(market|outlook|forecast|report)\b/.test(lower)) buckets.marketQueries.push(q);
    else if (/\b(engineering|implementation|architecture|technical)\b/.test(lower)) buckets.technicalQueries.push(q);
    else if (/\b(best practices|lessons|guide|evergreen)\b/.test(lower)) buckets.evergreenQueries.push(q);
    else if (/\b(launch|funding|acquisition|announcement|regulation|incident|policy)\b/.test(lower)) buckets.newsQueries.push(q);
    else buckets.newsQueries.push(q);
  }

  return buckets;
}

export function buildFallbackExpansionPlan(niche: string): NicheExpansionPlan {
  const raw: NicheExpansionPlan = {
    niche,
    domain: niche,
    confidence: 0.4,
    subtopics: [niche],
    queries: [],
    exclusions: ['hiring', 'jobs', 'internship', 'agency', 'press release', 'how much does', 'best company', 'development company', 'seo services'],
    version: NICHE_EXPANSION_PLAN_VERSION,
    generatedAt: new Date(),
    normalizedNiche: niche,
    requiredContextTerms: [niche],
    contentCategories: [{ id: slug(niche), label: niche, terms: [niche] }],
  };
  const queries = buildProfileGroundedQueries(raw);
  return enrichNicheExpansionPlan({ ...raw, queries, queryBuckets: buildQueryBucketsFromQueries(queries, niche) });
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
}

function querySimilarity(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  const inter = [...ta].filter((x) => tb.has(x)).length;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 0 : inter / union;
}

function hasDomainMismatch(niche: string, query: string): boolean {
  for (const pair of DOMAIN_MISMATCH_PAIRS) {
    if (pair.nicheHint.test(niche) && pair.badPhrase.test(query)) return true;
  }
  return false;
}

export function validateExpansionQuery(
  query: string,
  niche: string,
  subtopics: string[],
  seen: string[],
  profile?: Partial<NicheExpansionPlan>,
): { valid: boolean; confidence: number; reasons: string[]; reason?: string } {
  const reject = (reason: string, confidence = 0): { valid: false; confidence: number; reasons: string[]; reason: string } => ({
    valid: false, confidence, reasons: [reason], reason,
  });
  const trimmed = query.trim();
  if (trimmed.length < 5 || trimmed.length > 180) {
    return reject('length');
  }

  const lower = trimmed.toLowerCase();
  const nicheLower = niche.toLowerCase();
  const nicheTokens = normalizeNicheKey(niche).split(' ').filter((term) => term.length >= 3);
  const referencesNiche = lower.includes(nicheLower)
    || subtopics.some((s) => lower.includes(s.toLowerCase()))
    || nicheTokens.some((term) => lower.includes(term));
  const contextTerms = profile?.requiredContextTerms ?? [];
  const hasRequiredContext = contextTerms.length === 0
    || contextTerms.some((term) => lower.includes(term.toLowerCase()));
  if (!referencesNiche || !hasRequiredContext) return reject('insufficient_niche_context', 0.2);

  const excluded = [...(profile?.excludedTerms ?? []), ...(profile?.excludedInterpretations ?? [])]
    .find((term) => term.trim() && lower.includes(term.toLowerCase()));
  if (excluded) return reject(`excluded_term:${excluded}`);

  const genericOnly = /^(latest |recent )?(news|trends|best practices|updates|insights)$/i.test(trimmed);
  if (genericOnly) return reject('generic_query');
  const alwaysGenericPattern = /\b(audience growth|methods practice innovation|adoption outcomes trends|notable announcement update|organizations institutions developments)\b/i;
  if (alwaysGenericPattern.test(trimmed)) return reject('generic_query', 0.2);
  const vaguePattern = /\b(expert analysis|sector reports?|success stories|trends in (?:the )?industry|market position|practitioner perspectives|research and evidence)\b/i;
  const specificTerms = [
    ...(profile?.importantEntities ?? []), ...(profile?.productsAndPlatforms ?? []),
    ...(profile?.contentCategories?.flatMap((item) => [item.label, ...item.terms]) ?? []),
    ...(profile?.normalizedPillars?.flatMap((item) => item.searchTerms) ?? []),
    ...(profile?.commonProblems ?? []), ...(profile?.audienceTypes ?? []),
  ].filter((term) => term.length >= 3);
  const hasSpecificTerm = specificTerms.some((term) => lower.includes(term.toLowerCase()));
  if (vaguePattern.test(trimmed) && !hasSpecificTerm) return reject('generic_query', 0.2);

  const evidenceIntent = /\b(release|update|study|research|report|benchmark|incident|policy|regulation|case study|postmortem|comparison|adoption|measured|survey|trial|guidance|standard|practitioner analysis|struggling|questions?|common mistakes?|misconception|beginner guidance|debate|failure risk|practical implementation|emerging opportunity)\b/i.test(trimmed);
  if (profile?.version === NICHE_EXPANSION_PLAN_VERSION && (!hasSpecificTerm || !evidenceIntent)) {
    return reject('insufficient_query_specificity', 0.2);
  }

  for (const re of JOB_QUERY_PATTERNS) {
    if (re.test(trimmed)) return reject('promotional_query');
  }

  if (hasDomainMismatch(niche, trimmed)) return reject('domain_mismatch');

  for (const prev of seen) {
    if (querySimilarity(trimmed, prev) >= 0.7) return reject('near_duplicate_query', 0.1);
  }

  return { valid: true, confidence: 0.9, reasons: [] };
}

export function sanitizeExpansionPlan(raw: NicheExpansionPlan): NicheExpansionPlan {
  const subtopics = [...new Set(raw.subtopics.map((s) => s.trim()).filter(Boolean))].slice(0, 10);
  const exclusions = [...new Set(raw.exclusions.map((s) => s.trim()).filter(Boolean))].slice(0, 20);
  const validQueries: string[] = [];

  const candidates = uniqueText([...raw.queries, ...buildProfileGroundedQueries(raw)]);
  for (const q of candidates) {
    let current = q.trim();
    for (let attempt = 0; attempt <= 2; attempt++) {
      const check = validateExpansionQuery(current, raw.niche, subtopics.length ? subtopics : [raw.niche], validQueries, raw);
      if (check.valid) {
        validQueries.push(current);
        break;
      }
      const repaired = repairExpansionQuery(current, check.reasons, raw, attempt + 1);
      if (!repaired) break;
      console.info('[niche-query] repairing generated query', {
        niche: raw.niche,
        originalQuery: q,
        rejectedQuery: current,
        rejectionReasons: check.reasons,
        repairAttempt: attempt + 1,
        repairedQuery: repaired,
      });
      current = repaired;
    }
    if (validQueries.length >= 20) break;
  }

  const queries = validQueries.slice(0, 20);

  const queryBuckets = raw.queryBuckets ?? buildQueryBucketsFromQueries(queries, raw.niche);

  return enrichNicheExpansionPlan({
    ...raw,
    niche: raw.niche,
    domain: raw.domain.trim() || raw.niche,
    confidence: Math.max(0, Math.min(1, raw.confidence)),
    subtopics: subtopics.length ? subtopics : [raw.niche],
    queries,
    queryBuckets,
    exclusions: exclusions.length ? exclusions : buildFallbackExpansionPlan(raw.niche).exclusions,
    version: NICHE_EXPANSION_PLAN_VERSION,
    generatedAt: new Date(),
  });
}

function rowToPlan(row: {
  niche: string;
  domain: string;
  confidence: number;
  subtopics: unknown;
  queries: unknown;
  exclusions: unknown;
  version: number;
  generatedAt: Date;
}): NicheExpansionPlan {
  const stored = row.queries && typeof row.queries === 'object' && !Array.isArray(row.queries)
    ? row.queries as { items?: unknown; profile?: Partial<NicheExpansionPlan> }
    : null;
  const queries = Array.isArray(row.queries)
    ? (row.queries as string[])
    : Array.isArray(stored?.items) ? stored!.items as string[] : [];
  const plan: NicheExpansionPlan = {
    niche: row.niche,
    domain: row.domain,
    confidence: row.confidence,
    subtopics: Array.isArray(row.subtopics) ? (row.subtopics as string[]) : [],
    queries,
    exclusions: Array.isArray(row.exclusions) ? (row.exclusions as string[]) : [],
    queryBuckets: buildQueryBucketsFromQueries(queries, row.niche),
    version: row.version,
    generatedAt: row.generatedAt,
    ...(stored?.profile ?? {}),
  };
  return sanitizeExpansionPlan(plan);
}

export class NicheExpansionService {
  private openai: OpenAI | null;

  constructor(openaiApiKey?: string | null) {
    const key = openaiApiKey || process.env.OPENAI_API_KEY;
    this.openai = key ? new OpenAI({ apiKey: key }) : null;
  }

  async generatePlanWithAI(
    niche: string,
    failedQueryDiagnostics: Array<{ query: string; reasons: string[] }> = [],
  ): Promise<NicheExpansionPlan> {
    if (!this.openai) return buildFallbackExpansionPlan(niche);

    try {
      const response = await this.openai.chat.completions.create({
        model: process.env.OPENAI_CONTENT_MODEL || 'gpt-4o-mini',
        temperature: 0.3,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'niche_expansion_plan',
            strict: true,
            schema: NICHE_EXPANSION_OPENAI_SCHEMA,
          },
        },
        messages: [
          { role: 'system', content: NICHE_EXPANSION_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Niche: "${niche}"

Return one domain, confidence 0-1, 4-8 subtopics, 12-20 specific queries distributed across only relevant intents. Every query must combine a niche entity, platform, category, or problem with a concrete discovery intent and enough niche context to disambiguate it. Include a niche-specific source plan with real official domains, regulators or associations, research sources, specialist publications, community sources, subreddit suggestions, question sources, excluded domains, and confidence. Never invent a domain when unsure; use an empty array. Avoid generic analysis wording. Return 5-15 exclusion patterns.
${failedQueryDiagnostics.length ? `Previous queries failed validation. Correct these failures and do not repeat them:\n${JSON.stringify(failedQueryDiagnostics.slice(0, 20))}` : ''}`,
          },
        ],
      });

      const raw = response.choices[0].message.content || '';
      const parsed = nicheExpansionSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        console.warn('[niche-expansion] schema validation failed; using fallback', { niche });
        return buildFallbackExpansionPlan(niche);
      }

      return sanitizeExpansionPlan({ ...parsed.data, version: NICHE_EXPANSION_PLAN_VERSION, generatedAt: new Date() });
    } catch (err) {
      console.warn('[niche-expansion] OpenAI failed; using fallback', {
        niche,
        message: err instanceof Error ? err.message : String(err),
      });
      return buildFallbackExpansionPlan(niche);
    }
  }

  async getOrCreatePlan(
    userId: string,
    niche: string,
    forceRefresh = false,
    failedQueryDiagnostics: Array<{ query: string; reasons: string[] }> = [],
  ): Promise<NicheExpansionPlan> {
    const key = normalizeNicheKey(niche);
    let storedPlanVersion: number | null = null;

    if (!forceRefresh) {
      const existing = await prisma.userNicheSearchPlan.findUnique({
        where: { userId_niche: { userId, niche: key } },
      });
      storedPlanVersion = existing?.version ?? null;
      if (existing && existing.version === NICHE_EXPANSION_PLAN_VERSION) {
        const loaded = rowToPlan(existing);
        if (loaded.queries.length >= 4 || loaded.confidence < 0.7) {
          console.info('[niche-profile] cache resolution', { userId, niche, storedPlanVersion, loadedPlanVersion: loaded.version, cacheHit: true, regenerated: false, inputFingerprint: loaded.inputFingerprint, queryCount: loaded.queries.length });
          return loaded;
        }
      }
    }

    const plan = await this.generatePlanWithAI(niche, failedQueryDiagnostics);
    const sanitized = sanitizeExpansionPlan(plan);

    await prisma.userNicheSearchPlan.upsert({
      where: { userId_niche: { userId, niche: key } },
      create: {
        userId,
        niche: key,
        domain: sanitized.domain,
        confidence: sanitized.confidence,
        subtopics: sanitized.subtopics,
        queries: { items: sanitized.queries, profile: sanitized },
        exclusions: sanitized.exclusions,
        version: NICHE_EXPANSION_PLAN_VERSION,
      },
      update: {
        domain: sanitized.domain,
        confidence: sanitized.confidence,
        subtopics: sanitized.subtopics,
        queries: { items: sanitized.queries, profile: sanitized },
        exclusions: sanitized.exclusions,
        version: NICHE_EXPANSION_PLAN_VERSION,
        generatedAt: new Date(),
      },
    });

    console.info('[niche-profile] cache resolution', { userId, niche, storedPlanVersion, loadedPlanVersion: sanitized.version, cacheHit: false, regenerated: true, inputFingerprint: sanitized.inputFingerprint, queryCount: sanitized.queries.length });

    return sanitized;
  }
}
