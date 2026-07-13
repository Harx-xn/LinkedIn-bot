export type TopicCluster =
  | 'authentication_authorization'
  | 'tenant_isolation'
  | 'billing_entitlements'
  | 'queues_jobs'
  | 'deployment_infrastructure'
  | 'observability'
  | 'database_integrity'
  | 'api_design'
  | 'frontend_architecture'
  | 'performance'
  | 'developer_tooling'
  | 'ai_automation'
  | 'product_engineering'
  | 'security'
  | 'research'
  | 'health'
  | 'finance'
  | 'legal'
  | 'education'
  | 'marketing'
  | 'operations'
  | 'other';

export type TopicFingerprint = {
  normalizedTopic: string;
  topicCluster: TopicCluster;
  coreClaim: string;
  entities: string[];
  mechanisms: string[];
};

export type TrendContentType =
  | 'breaking_news'
  | 'industry_news'
  | 'market_analysis'
  | 'technical_analysis'
  | 'research'
  | 'evergreen'
  | 'community_discussion';

export type NicheQueryBuckets = {
  newsQueries: string[];
  marketQueries: string[];
  technicalQueries: string[];
  researchQueries: string[];
  evergreenQueries: string[];
  mediumTags: string[];
};

export type TrendCandidate = {
  topic: string;
  link?: string;
  source?: string;
  publisher?: string;
  discoverySource?: string;
  rawTitle?: string;
  publishedAt?: string | Date | null;
  niche?: string;
  searchQuery?: string;
  exclusions?: string[];
  summary?: string;
  keyPoints?: string[];
  contentType?: TrendContentType;
  fingerprint?: TopicFingerprint;
  // Runtime strategy metadata for previews, selection, and generation prompts.
  // GeneratedTopicHistory persists normalized topic/cluster/core claim/angle only.
  matchedPillar?: string;
  suggestedAngle?: string;
  audienceRelevance?: string;
  strategyScore?: number;
  strategyReasons?: string[];
  strategyRiskFlags?: string[];
};

export type NicheExpansionPlan = {
  niche: string;
  domain: string;
  confidence: number;
  subtopics: string[];
  queries: string[];
  exclusions: string[];
  queryBuckets?: NicheQueryBuckets;
  generatedAt?: Date;
  version?: number;
};

export type NoveltyEvaluation = {
  allowed: boolean;
  score: number;
  reasons: string[];
  closestMatch?: {
    historyId: string;
    similarity: number;
    generatedAt: Date;
    topicCluster: string;
    status: string;
  };
};

export type RankedTrendCandidate = {
  trend: TrendCandidate;
  fingerprint: TopicFingerprint;
  relevanceScore: number;
  sourceQualityScore: number;
  recencyScore: number;
  technicalDepthScore: number;
  noveltyScore: number;
  totalScore: number;
  novelty: NoveltyEvaluation;
  contentType?: TrendContentType;
  matchedPillar?: string;
  suggestedAngle?: string;
  audienceRelevance?: string;
};

export type TrendPoolStats = {
  rawCount: number;
  rejectedLowValue: number;
  rejectedByExclusions: number;
  exactDuplicatesRemoved: number;
  nearDuplicatesRemoved: number;
  historyMatchesRemoved: number;
  fingerprinted: number;
  selected: number;
  evergreenFilled: number;
  openAiCalls?: number;
  sourceRequestCount?: number;
  cacheHits?: number;
  cacheMisses?: number;
};

export type PreviewTrendItem = {
  title: string;
  link: string;
  pubDate?: string;
  source?: string;
  publisher?: string;
  discoverySource?: string;
  niche?: string;
  searchQuery?: string;
  score?: number;
  relevanceScore?: number;
  recencyScore?: number;
  sourceQualityScore?: number;
  noveltyScore?: number;
  contentType?: string;
  cluster?: string;
  matchedPillar?: string;
  suggestedAngle?: string;
  audienceRelevance?: string;
};

export type PreviewTrendsResponse = {
  trends: PreviewTrendItem[];
  previewId?: string;
  stats?: TrendPoolStats;
  timingMs?: {
    configurationMs: number;
    searchPlanMs: number;
    sourceFetchMs: number;
    filteringMs: number;
    deduplicationMs: number;
    rankingMs: number;
    previewPersistenceMs: number;
    totalMs: number;
  };
};

export type TopicHistoryStatus =
  | 'GENERATED'
  | 'APPROVED'
  | 'SCHEDULED'
  | 'PUBLISHED'
  | 'REJECTED';

export type GeneratedJsonParseResult =
  | {
      ok: true;
      data: {
        headline: string;
        subheadline: string;
        bulletPoints: string[];
        body: string;
        hashtags: string;
        sourceTopic?: string | null;
        angle?: string;
        layout?: string;
        confidence?: number;
        warnings?: string[];
      };
    }
  | {
      ok: false;
      stage: 'json_parse' | 'json_extraction' | 'normalization' | 'schema_validation';
      message: string;
      issues?: string[];
      extracted?: unknown;
    };

export type SlotAcceptanceDecision = {
  accepted: boolean;
  deterministicScore: number;
  specificityScore: number;
  qualityScore: number;
  technicalPassed: boolean;
  blockingIssueCodes: string[];
  warningIssueCodes: string[];
};

export type AuthorContext = {
  description: string;
  tone: string;
  niches?: string[];
  targetAudience?: string[];
  strategy?: import('./botStrategyService').EffectiveBotStrategy;
};

export type PostAngle =
  | 'technical_mistake'
  | 'practical_tutorial'
  | 'architecture_tradeoff'
  | 'defensible_opinion'
  | 'debugging_story'
  | 'product_lesson'
  | 'reflection';

export type HookStyle =
  | 'observation'
  | 'contrarian'
  | 'mistake'
  | 'story'
  | 'question'
  | 'lesson'
  | 'comparison';

export type EndingStyle = 'takeaway' | 'specific_question' | 'summary' | 'action';

export type PostLayout =
  | 'short_observation'
  | 'story_then_lesson'
  | 'problem_mechanism_fix'
  | 'opinion_with_reasoning'
  | 'mini_checklist'
  | 'comparison'
  | 'technical_walkthrough';

export type BatchPostPlan = {
  trendIndex: number | null;
  sourceTopic: string | null;
  angle: PostAngle;
  hookStyle: HookStyle;
  endingStyle: EndingStyle;
  layout: PostLayout;
  rationale: string;
  evergreen?: boolean;
  topicCluster?: TopicCluster;
  normalizedTopic?: string;
  coreClaim?: string;
  mechanismFocus?: string[];
  matchedPillar?: string;
  suggestedAngle?: string;
  audienceRelevance?: string;
};

export type ImageContentMode =
  | 'quote'
  | 'single_insight'
  | 'checklist'
  | 'comparison'
  | 'none';

export type ImageContent = {
  mode: ImageContentMode;
  headline: string;
  supportingText?: string;
  bulletPoints?: string[];
};

export type GeneratedPostContent = {
  headline: string;
  subheadline: string;
  bulletPoints: string[];
  body: string;
  hashtags: string;
  sourceTopic?: string | null;
  angle?: string;
  layout?: PostLayout;
  confidence?: number;
  warnings?: string[];
  imageContent?: ImageContent;
};

export type TrendQualityResult = {
  accepted: boolean;
  score: number;
  reasons: string[];
};

export type QualityIssue = {
  code: string;
  severity: 'warning' | 'error';
  evidence?: string[];
  instruction?: string;
};

export type TechnicalReviewIssueCode =
  | 'auth_vs_authorization'
  | 'tenant_isolation_confusion'
  | 'token_auth_overclaim'
  | 'frontend_security_claim'
  | 'compliance_overclaim'
  | 'audit_trail_overclaim'
  | 'false_architecture_tradeoff'
  | 'environment_isolation_error'
  | 'idempotency_omitted'
  | 'locking_overclaim'
  | 'atomic_usage_omitted'
  | 'background_job_overclaim'
  | 'guaranteed_outcome'
  | 'unsupported_personal_claim'
  | 'other';

export type TechnicalReviewIssue = {
  code: TechnicalReviewIssueCode;
  severity: 'warning' | 'error';
  excerpt: string;
  explanation: string;
  repairInstruction: string;
};

export type TechnicalReviewResult = {
  passed: boolean;
  confidence: number;
  issues: TechnicalReviewIssue[];
};

export type SpecificityResult = {
  score: number;
  signals: string[];
  missing: string[];
};

export type DeterministicValidationResult = {
  passed: boolean;
  deterministicScore: number;
  /** @deprecated use deterministicScore */
  score: number;
  issues: QualityIssue[];
  specificity?: SpecificityResult;
};

export type PostQualityResult = {
  passed: boolean;
  score: number;
  reasons: string[];
  warnings: string[];
  issues?: QualityIssue[];
  specificity?: SpecificityResult;
};

export type ImageValidationResult = {
  passed: boolean;
  issues: QualityIssue[];
};

export type TopicCombineEvaluation = {
  canCombine: boolean;
  connection: string | null;
  reason: string;
};
