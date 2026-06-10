import OpenAI from 'openai';
import { z } from 'zod';
import { prisma } from '../prismaClient';
import { NICHE_EXPANSION_PLAN_VERSION } from '../config/topicDiversityConfig';
import type { NicheExpansionPlan, NicheQueryBuckets } from './generationTypes';

export const NICHE_EXPANSION_SYSTEM_PROMPT = `
You create structured content-discovery plans from user-provided niches.

Given a niche:
- infer the broad domain
- create narrower subtopics when useful
- generate event-oriented and insight-oriented search queries for Google News and RSS
- prefer product launches, funding, acquisitions, market reports, regulation, security incidents, platform announcements, research publications, and contrarian analysis
- avoid generic SEO phrases like "custom X development", "build X product", or "X services"
- generate concise Medium tags separately (1-3 words, hyphen-safe) — never use full news queries as Medium tags
- keep all queries relevant to the niche
- never assume the niche is technology, medical, legal, financial, or commercial unless appropriate
- avoid jobs, hiring, internships, agencies, directories, promotional services, pricing pages, and press-release content
- return valid JSON only
`;

const nicheExpansionSchema = z.object({
  niche: z.string().min(1).max(120),
  domain: z.string().min(2).max(80),
  confidence: z.number().min(0).max(1),
  subtopics: z.array(z.string().min(2).max(120)).min(3).max(10),
  queries: z.array(z.string().min(5).max(180)).min(4).max(15),
  exclusions: z.array(z.string().min(2).max(120)).max(20),
});

const NICHE_EXPANSION_OPENAI_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['niche', 'domain', 'confidence', 'subtopics', 'queries', 'exclusions'],
  properties: {
    niche: { type: 'string', minLength: 1, maxLength: 120 },
    domain: { type: 'string', minLength: 2, maxLength: 80 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    subtopics: { type: 'array', items: { type: 'string', minLength: 2, maxLength: 120 }, minItems: 3, maxItems: 10 },
    queries: { type: 'array', items: { type: 'string', minLength: 5, maxLength: 180 }, minItems: 4, maxItems: 15 },
    exclusions: { type: 'array', items: { type: 'string', minLength: 2, maxLength: 120 }, maxItems: 20 },
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

export function buildEventOrientedFallbackQueries(niche: string): string[] {
  return [
    `"${niche}" product launch announcement`,
    `"${niche}" funding OR acquisition`,
    `"${niche}" market report analysis`,
    `"${niche}" regulation OR policy update`,
    `"${niche}" security incident OR breach`,
    `"${niche}" research publication study`,
    `"${niche}" platform announcement update`,
    `"${niche}" industry adoption trends`,
  ];
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
      `"${niche}" launch`,
      `"${niche}" funding`,
    ],
    marketQueries: [
      `"${niche}" market report`,
      `"${niche}" industry outlook`,
    ],
    technicalQueries: [
      `"${niche}" engineering change`,
      `"${niche}" implementation lessons`,
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
  const queryBuckets = buildFallbackQueryBuckets(niche);
  return {
    niche,
    domain: niche,
    confidence: 0.4,
    subtopics: [niche],
    queries: flattenExpansionQueries({ niche, domain: niche, confidence: 0.4, subtopics: [niche], queries: [], exclusions: [], queryBuckets }),
    queryBuckets,
    exclusions: ['hiring', 'jobs', 'internship', 'agency', 'press release', 'how much does', 'best company', 'development company', 'seo services'],
    version: NICHE_EXPANSION_PLAN_VERSION,
    generatedAt: new Date(),
  };
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
): { valid: boolean; reason?: string } {
  const trimmed = query.trim();
  if (trimmed.length < 5 || trimmed.length > 180) {
    return { valid: false, reason: 'length' };
  }

  const lower = trimmed.toLowerCase();
  const nicheLower = niche.toLowerCase();
  const referencesNiche = lower.includes(nicheLower)
    || subtopics.some((s) => lower.includes(s.toLowerCase()));
  if (!referencesNiche) return { valid: false, reason: 'niche_mismatch' };

  for (const re of JOB_QUERY_PATTERNS) {
    if (re.test(trimmed)) return { valid: false, reason: 'promotional_query' };
  }

  if (hasDomainMismatch(niche, trimmed)) return { valid: false, reason: 'domain_mismatch' };

  for (const prev of seen) {
    if (querySimilarity(trimmed, prev) >= 0.9) return { valid: false, reason: 'duplicate_query' };
  }

  return { valid: true };
}

export function sanitizeExpansionPlan(raw: NicheExpansionPlan): NicheExpansionPlan {
  const subtopics = [...new Set(raw.subtopics.map((s) => s.trim()).filter(Boolean))].slice(0, 10);
  const exclusions = [...new Set(raw.exclusions.map((s) => s.trim()).filter(Boolean))].slice(0, 20);
  const validQueries: string[] = [];

  for (const q of raw.queries) {
    const check = validateExpansionQuery(q, raw.niche, subtopics.length ? subtopics : [raw.niche], validQueries);
    if (check.valid) validQueries.push(q.trim());
  }

  const queries = validQueries.length >= 4
    ? validQueries.slice(0, 15)
    : buildFallbackQueries(raw.niche);

  const queryBuckets = raw.queryBuckets ?? buildQueryBucketsFromQueries(queries, raw.niche);

  return {
    niche: raw.niche,
    domain: raw.domain.trim() || raw.niche,
    confidence: Math.max(0, Math.min(1, raw.confidence)),
    subtopics: subtopics.length ? subtopics : [raw.niche],
    queries,
    queryBuckets,
    exclusions: exclusions.length ? exclusions : buildFallbackExpansionPlan(raw.niche).exclusions,
    version: NICHE_EXPANSION_PLAN_VERSION,
    generatedAt: new Date(),
  };
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
  const queries = Array.isArray(row.queries) ? (row.queries as string[]) : [];
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
  };
  return sanitizeExpansionPlan(plan);
}

export class NicheExpansionService {
  private openai: OpenAI | null;

  constructor(openaiApiKey?: string | null) {
    const key = openaiApiKey || process.env.OPENAI_API_KEY;
    this.openai = key ? new OpenAI({ apiKey: key }) : null;
  }

  async generatePlanWithAI(niche: string): Promise<NicheExpansionPlan> {
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

Return one domain, confidence 0-1, 4-8 subtopics, 6-12 event-oriented queries (launches, funding, reports, regulation, incidents, research, announcements — NOT agency/SEO phrasing), and 5-15 exclusion patterns.`,
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

  async getOrCreatePlan(userId: string, niche: string, forceRefresh = false): Promise<NicheExpansionPlan> {
    const key = normalizeNicheKey(niche);

    if (!forceRefresh) {
      const existing = await prisma.userNicheSearchPlan.findUnique({
        where: { userId_niche: { userId, niche: key } },
      });
      if (existing && existing.version === NICHE_EXPANSION_PLAN_VERSION) {
        return rowToPlan(existing);
      }
    }

    const plan = await this.generatePlanWithAI(niche);
    const sanitized = sanitizeExpansionPlan(plan);

    await prisma.userNicheSearchPlan.upsert({
      where: { userId_niche: { userId, niche: key } },
      create: {
        userId,
        niche: key,
        domain: sanitized.domain,
        confidence: sanitized.confidence,
        subtopics: sanitized.subtopics,
        queries: sanitized.queries,
        exclusions: sanitized.exclusions,
        version: NICHE_EXPANSION_PLAN_VERSION,
      },
      update: {
        domain: sanitized.domain,
        confidence: sanitized.confidence,
        subtopics: sanitized.subtopics,
        queries: sanitized.queries,
        exclusions: sanitized.exclusions,
        version: NICHE_EXPANSION_PLAN_VERSION,
        generatedAt: new Date(),
      },
    });

    return sanitized;
  }
}
