/** Publisher tiers for source-quality scoring (0–100 scale). */
export const TREND_SOURCE_SCORES = {
  authoritativePublisher: 92,
  knownIndustryPublisher: 82,
  customTrustedRss: 78,
  unknownPublisher: 58,
  medium: 52,
  linkedInPost: 48,
  reddit: 42,
  customLink: 50,
  quora: 45,
} as const;

/** Known authoritative publishers (domain-neutral starter set). */
export const AUTHORITATIVE_PUBLISHERS = new Set([
  'reuters', 'ap news', 'associated press', 'bbc', 'nature', 'science',
  'the wall street journal', 'financial times', 'harvard business review',
  'mit technology review', 'techcrunch', 'the verge', 'arstechnica', 'ars technica',
  'infoq', 'ieee', 'nejm', 'the lancet', 'who', 'cdc',
]);

export const KNOWN_INDUSTRY_PUBLISHERS = new Set([
  'infoworld', 'cio', 'computerworld', 'network world', 'zdnet', 'cnet',
  'fast company', 'forbes', 'bloomberg', 'venturebeat', 'the register',
  'health affairs', 'stat news', 'medscape', 'law360', 'education week',
]);

export const TREND_PREVIEW_CAPS = {
  maxPerPublisher: 2,
  maxMediumResults: 3,
  maxLinkedInResults: 2,
  maxRedditResults: 3,
  maxPerSemanticCluster: 2,
} as const;

export const TREND_PREVIEW_COMPOSITION = {
  minTimelyNews: 6,
  minAnalysis: 3,
  maxEvergreen: 5,
  maxCommunity: 4,
} as const;

export const HEADLINE_QUALITY_LIMITS = {
  maxHeadlineLength: 280,
  maxSentenceCount: 4,
  socialPostMinLength: 120,
} as const;
