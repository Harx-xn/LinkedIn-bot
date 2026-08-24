export type TopicCluster = string;
/* Legacy cluster names remain valid persisted values. */
export type LegacyTopicCluster =
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

export type DiscoveryIntent =
  | 'recent_development' | 'official_update' | 'industry_change'
  | 'recurring_problem' | 'audience_question' | 'common_mistake' | 'misconception'
  | 'verified_solution' | 'case_study' | 'research_or_data' | 'beginner_guidance'
  | 'comparison_or_debate' | 'risk_or_failure' | 'practical_implication' | 'emerging_opportunity';

export type EvidenceRole = 'primary' | 'strong_secondary' | 'practitioner' | 'problem_discovery' | 'question_discovery' | 'idea_only';

export type NicheSourcePlan = {
  officialEntities: string[];
  officialDomains: string[];
  regulatorsAndAssociations: Array<{ name: string; domain?: string }>;
  researchSources: Array<{ name: string; domain?: string; sourceType: string }>;
  specialistPublications: Array<{ name: string; domain?: string }>;
  communitySources: string[];
  relevantSubreddits: string[];
  questionSources: string[];
  excludedDomains: string[];
  confidence: number;
};

export type BatchDiscoveryPlan = {
  requestedPosts: number;
  intentTargets: Array<{ intent: DiscoveryIntent; desiredCount: number; allowedSources: string[] }>;
  minimumPrimaryOrStrongSources: number;
  maximumCommunityOnlyTopics: number;
  maximumAnglesPerSource: number;
};

export type SourceReference = { url: string; publisher?: string; source: string; evidenceRole: EvidenceRole };

export type TrendSource = string;

export type CandidateProvenance = {
  originNiche: string;
  profileFingerprint: string;
  originatingQuery: string;
  queryIntent: DiscoveryIntent;
  originatingSource: TrendSource;
};

export type NicheQueryBuckets = {
  newsQueries: string[];
  marketQueries: string[];
  technicalQueries: string[];
  researchQueries: string[];
  evergreenQueries: string[];
  mediumTags: string[];
};

export type TrendCandidate = {
  inventoryId?: string;
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
  qualificationConfidence?: number;
  sourceType?: 'searched' | 'strategy_derived' | 'source_derived_angle';
  ideaOrigin?: IdeaOrigin;
  territory?: string;
  ideaFamily?: string;
  authorityMode?: import('./contentIntelligenceService').AuthorityMode;
  searchRequired?: boolean;
  ideaQualityScore?: number;
  saturationPenalty?: number;
  selectionMode?: 'normal' | 'zero_result_fallback';
  discoveryIntent?: DiscoveryIntent;
  evidenceRole?: EvidenceRole;
  supportingSources?: SourceReference[];
  parentSourceId?: string;
  angleType?: string;
  sourceUrl?: string;
  /** Immutable discovery ownership. Optional only for legacy/stored candidates. */
  originNiche?: string;
  profileFingerprint?: string;
  originatingQuery?: string;
  queryIntent?: DiscoveryIntent;
  originatingSource?: TrendSource;
};

export type IdeaOrigin = 'STRATEGY_DERIVED' | 'AUDIENCE_PROBLEM' | 'EVERGREEN' | 'SEARCH_DISCOVERED' | 'RECENT_DEVELOPMENT' | 'CROSS_PILLAR' | 'PERFORMANCE_DERIVED' | 'USER_REQUESTED';

export type NormalizedContentPillar = {
  originalPillar: string;
  normalizedPillar: string;
  description: string;
  subtopics: string[];
  relatedEntities: string[];
  searchTerms: string[];
  excludedTopics: string[];
};

export type NicheContentCategory = {
  id: string;
  label: string;
  terms: string[];
};

export type NicheSearchIntent = {
  id: string;
  label: string;
  terms: string[];
};

export type NicheProfileQuery = {
  query: string;
  intent: string;
  dynamicCategory: string | null;
  relatedEntity: string | null;
  relatedPillar: string | null;
  confidence: number;
  origin: 'niche_profile' | 'strategy_enriched' | 'retry_regenerated' | 'first_party';
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
  originalNiche?: string;
  normalizedNiche?: string;
  parentIndustry?: string;
  nicheDescription?: string;
  audienceTypes?: string[];
  commonProblems?: string[];
  desiredOutcomes?: string[];
  importantEntities?: string[];
  entityAliases?: string[];
  productsAndPlatforms?: string[];
  terminology?: string[];
  adjacentTopics?: string[];
  requiredContextTerms?: string[];
  preferredTerms?: string[];
  excludedTerms?: string[];
  excludedInterpretations?: string[];
  contentCategories?: NicheContentCategory[];
  normalizedPillars?: NormalizedContentPillar[];
  searchIntents?: NicheSearchIntent[];
  inputFingerprint?: string;
  queryOrigin?: 'niche_profile' | 'strategy_enriched' | 'retry_regenerated' | 'legacy_fallback';
  profileQueries?: NicheProfileQuery[];
  sourcePlan?: NicheSourcePlan;
  selectedDiscoveryIntents?: DiscoveryIntent[];
  repairMetrics?: { attempted: number; accepted: number; rejected: number };
};

export type CandidateNicheMatch = {
  relevant: boolean;
  relevanceScore: number;
  confidence: number;
  matchedCategory: string | null;
  categoryConfidence: number;
  matchedPillar: string | null;
  pillarConfidence: number;
  matchedMonitorTopic: string | null;
  avoidTopicMatch: string | null;
  reasons: string[];
  rejectionCodes: string[];
  directEvidence?: string[];
  matchedTerms?: string[];
  matchedPlatform?: string | null;
  matchedEntity?: string | null;
  matchedAlias?: string | null;
  matchedForeignPillars?: string[];
  queryIntent?: string | null;
  ambiguityResolved?: boolean;
  activeNicheEvidence?: ActiveNicheEvidence;
};

export interface ActiveNicheEvidence {
  activeNiche: string;
  matchedPillar: string | null;
  matchedEntities: string[];
  matchedAliases: string[];
  matchedPlatforms: string[];
  matchedCategories: string[];
  matchedProfileTerms: string[];
  matchedQueryContext: string[];
  directEvidence: string[];
  pillarSatisfied: boolean;
  pillarSatisfiedBy: 'literal_pillar' | 'pillar_keyword' | 'entity' | 'alias' | 'platform' | 'category_plus_context' | null;
  ambiguityResolved: boolean;
  ambiguityResolutionReason: string | null;
  strength: number;
}

export type CandidateEligibility = {
  eligible: boolean;
  rejectionCodes: string[];
  acceptancePath?: 'direct_evidence' | 'strategy_match' | 'high_confidence_classification';
  hardRejectionCodes?: string[];
  softSignals?: string[];
  failedAcceptancePaths?: string[];
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
  strategyAccepted?: number;
  historyApproved?: number;
  noveltyApproved?: number;
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
  contentIntelligence?: import('./contentIntelligenceService').ContentIntelligenceProfile;
};

export type ExpressionMode = 'direct' | 'analytical' | 'diagnostic' | 'conversational' | 'opinionated' | 'walkthrough' | 'reflective';

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

export type EndingStyle = 'natural' | 'takeaway' | 'specific_question' | 'summary' | 'action';

export type PostLayout =
  | 'short_observation'
  | 'story_then_lesson'
  | 'problem_mechanism_fix'
  | 'opinion_with_reasoning'
  | 'mini_checklist'
  | 'comparison'
  | 'technical_walkthrough';

export type PostDepthPlan = {
  centralClaim: string;
  whyThisClaimIsInteresting: string | null;
  strongestObservations: string[];
  underlyingCauseOrMechanism: string | null;
  deeperInterpretation: string | null;
  meaningfulConsequence: string | null;
  usefulTensionOrQualification: string | null;
  personalPerspective: { supported: boolean; insight: string | null };
  endingInsight: string | null;
  avoidIdeas: string[];
};

export type PostDepth = 'COMPACT' | 'STANDARD' | 'DEEP';

export type PostTargetLengthRange = {
  min: number;
  max: number;
};

export type ClaimSource =
  | 'STRATEGY_SELECTED'
  | 'SEARCH_DISCOVERED'
  | 'LEGACY_TOPIC'
  | 'FALLBACK';

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
  centralClaim?: string;
  /** Where the pre-planning claim came from and therefore how strongly it should be preserved. */
  claimSource?: ClaimSource;
  /** Immutable semantic reference used to detect or restore planner drift. */
  selectedCentralClaim?: string;
  mechanismFocus?: string[];
  matchedPillar?: string;
  suggestedAngle?: string;
  audienceRelevance?: string;
  expressionMode?: ExpressionMode;
  depthPlan?: PostDepthPlan;
  /** Runtime-only execution metadata. It is derived from the idea/plan, not user configuration. */
  depthClass?: PostDepth;
  /** Soft drafting range. Only LinkedIn's 3,000-character maximum is a universal hard maximum. */
  targetLengthRange?: PostTargetLengthRange;
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
  | 'REDUNDANT_EXPLANATION'
  | 'LOW_INFORMATION_DENSITY'
  | 'GENERIC_SCENARIO_STRUCTURE'
  | 'GENERIC_CHECKLIST_EXPANSION'
  | 'THESIS_RESTATEMENT'
  | 'WEAK_ARGUMENT_PROGRESSION'
  | 'GENERIC_ENGAGEMENT_ENDING'
  | 'CLAIM_DRIFT'
  | 'other';

export type TechnicalReviewIssue = {
  code: TechnicalReviewIssueCode;
  severity: 'warning' | 'error';
  excerpt: string;
  explanation: string;
  repairInstruction: string;
};

export type TechnicalReviewResult = {
  /** False means the model response could not be parsed; deterministic checks remain authoritative. */
  available?: boolean;
  passed: boolean;
  confidence: number;
  informationDensity?: number;
  progressionQuality?: number;
  redundancyRisk?: number;
  genericDiscourseRisk?: number;
  claimFidelity?: number;
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
