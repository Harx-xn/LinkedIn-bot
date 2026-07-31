import OpenAI from 'openai';
import { z } from 'zod';
import type { NicheExpansionPlan, TopicCluster, TopicFingerprint, TrendCandidate } from './generationTypes';
import { normalizeTrendTitle } from './trendTitleUtils';

const fingerprintSchema = z.object({
  normalizedTopic: z.string().min(2).max(200),
  topicCluster: z.string(),
  coreClaim: z.string().min(2).max(300),
  entities: z.array(z.string()).max(8),
  mechanisms: z.array(z.string()).max(8),
});

const FINGERPRINT_OPENAI_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['normalizedTopic', 'topicCluster', 'coreClaim', 'entities', 'mechanisms'],
  properties: {
    normalizedTopic: { type: 'string', minLength: 2, maxLength: 200 },
    topicCluster: { type: 'string' },
    coreClaim: { type: 'string', minLength: 2, maxLength: 300 },
    entities: { type: 'array', items: { type: 'string' }, maxItems: 8 },
    mechanisms: { type: 'array', items: { type: 'string' }, maxItems: 8 },
  },
} as const;

const VALID_CLUSTERS = new Set<TopicCluster>([
  'authentication_authorization', 'tenant_isolation', 'billing_entitlements', 'queues_jobs',
  'deployment_infrastructure', 'observability', 'database_integrity', 'api_design',
  'frontend_architecture', 'performance', 'developer_tooling', 'ai_automation',
  'product_engineering', 'security', 'research', 'health', 'finance', 'legal',
  'education', 'marketing', 'operations', 'other',
]);

const CLUSTER_KEYWORDS: Array<{ cluster: TopicCluster; keywords: string[] }> = [
  { cluster: 'authentication_authorization', keywords: ['authentication', 'authorization', 'auth', 'jwt', 'oauth', 'permission', 'token', 'login'] },
  { cluster: 'tenant_isolation', keywords: ['tenant', 'multi-tenant', 'isolation', 'cross-tenant'] },
  { cluster: 'billing_entitlements', keywords: ['billing', 'subscription', 'entitlement', 'usage', 'quota', 'plan limit', 'pricing tier'] },
  { cluster: 'queues_jobs', keywords: ['queue', 'job', 'retry', 'backoff', 'idempotency', 'dead-letter', 'worker', 'cron'] },
  { cluster: 'deployment_infrastructure', keywords: ['deploy', 'container', 'docker', 'kubernetes', 'infrastructure', 'environment', 'config drift'] },
  { cluster: 'observability', keywords: ['observability', 'logging', 'metrics', 'tracing', 'correlation', 'monitor'] },
  { cluster: 'database_integrity', keywords: ['database', 'transaction', 'constraint', 'migration', 'schema', 'sql'] },
  { cluster: 'api_design', keywords: ['api', 'rest', 'graphql', 'endpoint', 'webhook', 'rate limit'] },
  { cluster: 'frontend_architecture', keywords: ['frontend', 'react', 'ui', 'component', 'client-side'] },
  { cluster: 'performance', keywords: ['performance', 'latency', 'throughput', 'cache', 'scalability'] },
  { cluster: 'developer_tooling', keywords: ['tooling', 'sdk', 'cli', 'framework', 'library'] },
  { cluster: 'ai_automation', keywords: ['ai', 'automation', 'llm', 'machine learning', 'model'] },
  { cluster: 'product_engineering', keywords: ['product', 'roadmap', 'feature', 'user experience'] },
  { cluster: 'security', keywords: ['security', 'vulnerability', 'encryption', 'breach'] },
  { cluster: 'research', keywords: ['research', 'study', 'clinical', 'trial', 'findings'] },
  { cluster: 'health', keywords: ['health', 'disease', 'medical', 'patient', 'diagnosis', 'treatment'] },
  { cluster: 'finance', keywords: ['finance', 'investment', 'market', 'economy', 'banking'] },
  { cluster: 'legal', keywords: ['legal', 'compliance', 'regulation', 'law', 'gdpr'] },
  { cluster: 'education', keywords: ['education', 'learning', 'curriculum', 'student', 'teaching'] },
  { cluster: 'marketing', keywords: ['marketing', 'brand', 'campaign', 'seo', 'content strategy'] },
  { cluster: 'operations', keywords: ['operations', 'process', 'workflow', 'supply chain'] },
];

const fingerprintCache = new Map<string, TopicFingerprint>();

function cacheKey(trend: TrendCandidate, profile?: NicheExpansionPlan): string {
  const title = normalizeTrendTitle(trend.topic);
  const link = (trend.link ?? '').trim().toLowerCase();
  const profileKey = profile?.inputFingerprint ?? trend.profileFingerprint ?? trend.originNiche ?? trend.niche ?? 'legacy';
  return `${link ? `${title}|${link}` : title}|${profileKey}`;
}

function coerceCluster(value: string): TopicCluster {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, '_') as TopicCluster;
  return VALID_CLUSTERS.has(normalized) ? normalized : 'other';
}

export function classifyTopicCluster(text: string): TopicCluster {
  const lower = text.toLowerCase();
  let best: TopicCluster = 'other';
  let bestHits = 0;
  for (const entry of CLUSTER_KEYWORDS) {
    const hits = entry.keywords.filter((k) => lower.includes(k)).length;
    if (hits > bestHits) {
      bestHits = hits;
      best = entry.cluster;
    }
  }
  return best;
}

export function classifyAgainstNicheProfile(
  trend: TrendCandidate,
  profile?: NicheExpansionPlan,
): { category: string; confidence: number } {
  if (!profile?.contentCategories?.length) return { category: 'unclassified', confidence: 0 };
  const text = normalizeTrendTitle([trend.topic, trend.summary, ...(trend.keyPoints ?? [])].filter(Boolean).join(' '));
  let best = { category: 'unclassified', confidence: 0 };
  for (const category of profile.contentCategories) {
    const terms = [category.label, ...category.terms].map(normalizeTrendTitle).filter(Boolean);
    const hits = terms.filter((term) => text.includes(term)).length;
    const confidence = terms.length ? hits / Math.min(3, terms.length) : 0;
    if (confidence > best.confidence) best = { category: category.id, confidence: Math.min(1, confidence) };
  }
  return best.confidence >= 0.34 ? best : { category: 'unclassified', confidence: best.confidence };
}

export function buildFallbackFingerprint(trend: TrendCandidate, profile?: NicheExpansionPlan): TopicFingerprint {
  const normalizedTopic = normalizeTrendTitle(trend.topic) || trend.topic.toLowerCase().trim();
  const cluster = classifyAgainstNicheProfile(trend, profile).category;
  return {
    normalizedTopic,
    topicCluster: cluster,
    coreClaim: `Topic relates to ${normalizedTopic}`,
    entities: trend.niche ? [trend.niche] : [],
    mechanisms: [],
  };
}

export function fingerprintFromBody(
  body: string,
  sourceTitle?: string,
  _angle?: string,
): TopicFingerprint {
  const text = `${sourceTitle ?? ''} ${body}`.slice(0, 2000);
  const normalizedTopic = normalizeTrendTitle(sourceTitle ?? body.slice(0, 120));
  const cluster = classifyTopicCluster(text);
  const mechanisms = CLUSTER_KEYWORDS
    .find((c) => c.cluster === cluster)?.keywords
    .filter((k) => text.toLowerCase().includes(k))
    .slice(0, 4) ?? [];

  return {
    normalizedTopic: normalizedTopic || 'generated post topic',
    topicCluster: cluster,
    coreClaim: normalizeTrendTitle(body.split('\n').filter(Boolean).slice(0, 2).join(' ')) || normalizedTopic,
    entities: [],
    mechanisms,
  };
}

export class TopicFingerprintService {
  private openai: OpenAI | null;

  constructor(openaiApiKey?: string | null) {
    const key = openaiApiKey || process.env.OPENAI_API_KEY;
    this.openai = key ? new OpenAI({ apiKey: key }) : null;
  }

  getCached(trend: TrendCandidate, profile?: NicheExpansionPlan): TopicFingerprint | undefined {
    const cached = fingerprintCache.get(cacheKey(trend, profile));
    if (cached && profile) {
      const dynamic = classifyAgainstNicheProfile(trend, profile);
      return { ...cached, topicCluster: dynamic.category };
    }
    if (!cached || cached.topicCluster !== 'other') return cached;
    const deterministicCluster = classifyTopicCluster(`${trend.topic} ${trend.niche ?? ''}`);
    if (deterministicCluster === 'other') return cached;
    const corrected = { ...cached, topicCluster: deterministicCluster };
    fingerprintCache.set(cacheKey(trend, profile), corrected);
    return corrected;
  }

  cacheFingerprint(trend: TrendCandidate, fingerprint: TopicFingerprint, profile?: NicheExpansionPlan): TopicFingerprint {
    fingerprintCache.set(cacheKey(trend, profile), fingerprint);
    return fingerprint;
  }

  async fingerprintTrend(trend: TrendCandidate, profile?: NicheExpansionPlan): Promise<TopicFingerprint> {
    const cached = this.getCached(trend, profile);
    if (cached) return cached;

    if (!this.openai) {
      return this.cacheFingerprint(trend, buildFallbackFingerprint(trend, profile), profile);
    }

    try {
      const response = await this.openai.chat.completions.create({
        model: process.env.OPENAI_CONTENT_MODEL || 'gpt-4o-mini',
        temperature: 0.2,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'topic_fingerprint',
            strict: true,
            schema: FINGERPRINT_OPENAI_SCHEMA,
          },
        },
        messages: [
          {
            role: 'system',
            content: 'Extract a conservative topic fingerprint from a trend title. Do not invent facts not implied by the title. Return JSON only.',
          },
          {
            role: 'user',
            content: `Title: ${trend.topic}
Niche: ${trend.niche ?? 'unknown'}
Source: ${trend.source ?? 'unknown'}
Summary: ${trend.summary ?? ''}`,
          },
        ],
      });

      const raw = response.choices[0].message.content || '';
      const parsed = fingerprintSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        return this.cacheFingerprint(trend, buildFallbackFingerprint(trend, profile), profile);
      }

      const dynamic = classifyAgainstNicheProfile(trend, profile);
      const fp: TopicFingerprint = {
        normalizedTopic: parsed.data.normalizedTopic,
        topicCluster: dynamic.category,
        coreClaim: parsed.data.coreClaim,
        entities: parsed.data.entities.slice(0, 8),
        mechanisms: parsed.data.mechanisms.slice(0, 8),
      };
      return this.cacheFingerprint(trend, fp, profile);
    } catch {
      return this.cacheFingerprint(trend, buildFallbackFingerprint(trend, profile), profile);
    }
  }

  async fingerprintTrends(
    trends: TrendCandidate[],
    concurrency = 4,
    profile?: NicheExpansionPlan,
  ): Promise<Map<string, TopicFingerprint>> {
    const out = new Map<string, TopicFingerprint>();
    let index = 0;
    const worker = async () => {
      while (index < trends.length) {
        const i = index++;
        const trend = trends[i];
        const fp = await this.fingerprintTrend(trend, profile);
        out.set(cacheKey(trend, profile), fp);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, Math.max(1, trends.length)) }, () => worker()),
    );
    return out;
  }
}
