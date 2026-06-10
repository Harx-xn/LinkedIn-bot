import type {
  AuthorContext,
  BatchPostPlan,
  GeneratedPostContent,
  ImageContent,
  ImageValidationResult,
  PostAngle,
  QualityIssue,
  SpecificityResult,
  DeterministicValidationResult,
} from './generationTypes';
import {
  countWords,
  clampWords,
  clampChars,
  MAX_IMAGE_SUBHEADING_WORDS,
  MAX_IMAGE_SUBHEADING_CHARS,
  MAX_IMAGE_HEADLINE_WORDS,
  MAX_IMAGE_HEADLINE_CHARS,
  MAX_IMAGE_BULLET_WORDS,
} from './ghostwriterTextUtils';
import { endsWithQuestion, isGenericEnding, jaccardSimilarity, tokenSet } from './ghostwriterTextUtils';
import type { TopicFingerprint } from './generationTypes';
import { fingerprintFromBody } from './topicFingerprintService';
import { evaluateBatchTopicSimilarity, evaluateHistoricalPostSimilarity } from './topicNoveltyService';
import type { TopicHistoryRow } from './topicHistoryService';

const VERIFIED_IDENTITY_PATTERNS = [
  /\bI am a\b/i,
  /\bI'm a\b/i,
  /\bI am building\b/i,
  /\bI work with\b/i,
];

const NARRATIVE_FIRST_PERSON = [
  /\bIn building [^,.]+,\s*I\b/i,
  /\bWhile building [^,.]+,\s*I\b/i,
  /\bWhen building [^,.]+,\s*I\b/i,
  /\bI encountered\b/i,
  /\bI implemented\b/i,
  /\bI configured\b/i,
  /\bI realized\b/i,
  /\bI noticed\b/i,
  /\bI fixed\b/i,
  /\bI solved\b/i,
  /\bI changed\b/i,
  /\bI set up\b/i,
  /\bI added\b/i,
  /\bI removed\b/i,
  /\bI was able\b/i,
  /\bI built\b/i,
  /\bI learned\b/i,
  /\bI ignored\b/i,
  /\bI discovered\b/i,
  /\bI tested\b/i,
  /\bwe implemented\b/i,
  /\bwe encountered\b/i,
  /\bwe fixed\b/i,
  /\bour platform experienced\b/i,
  /\bour users reported\b/i,
  /\bmy clients\b/i,
  /\bour customers\b/i,
];

type DeterministicTechnicalRule = {
  pattern: RegExp;
  code: string;
  severity: 'warning' | 'error';
  suggestion: string;
};

const DETERMINISTIC_TECH_RULES: DeterministicTechnicalRule[] = [
  { pattern: /\bdocker\b[^.]{0,40}\bframework\b/i, code: 'docker_framework', severity: 'error', suggestion: 'Docker is a container platform, not a framework.' },
  { pattern: /\bauthentication\b[^.]{0,80}\bprevents?\b[^.]{0,40}\btenant\b/i, code: 'auth_vs_authorization', severity: 'error', suggestion: 'Authentication proves identity; authorization and tenant scoping control access.' },
  { pattern: /\bauthentication\b[^.]{0,80}\b(cross-tenant|another tenant)\b/i, code: 'auth_vs_authorization', severity: 'error', suggestion: 'Authentication identifies users; tenant-aware authorization prevents cross-tenant access.' },
  { pattern: /\btoken(?:-based)? authentication\b[^.]{0,80}\b(simplif|easier|solve).{0,40}\b(tenant|session)\b/i, code: 'token_auth_overclaim', severity: 'error', suggestion: 'Token auth does not automatically solve tenant isolation or session management.' },
  { pattern: /\bfrontend\b[^.]{0,60}\b(security|protect(?:s|ing)? access)\b/i, code: 'frontend_security_claim', severity: 'error', suggestion: 'Frontend restrictions improve UX; they are not a security boundary.' },
  { pattern: /\b(entitlement|api)\b[^.]{0,80}\b(audit trail|ensure compliance|streamline compliance|meet data-protection)\b/i, code: 'compliance_overclaim', severity: 'error', suggestion: 'Server-side enforcement supports access control; auditability requires explicit logging.' },
  { pattern: /\b(environment consistency|consistent environments?)\b[^.]{0,60}\b(limit|oppose|versus|or)\b[^.]{0,40}\bscalab/i, code: 'false_architecture_tradeoff', severity: 'error', suggestion: 'Environment parity and scalability are separate concerns.' },
  { pattern: /\b(one|single|shared)\b[^.]{0,40}\b(database|db)\b[^.]{0,60}\b(all environments|dev.{0,20}staging.{0,20}production)\b/i, code: 'environment_isolation_error', severity: 'error', suggestion: 'Use isolated infrastructure and data per environment.' },
  { pattern: /\b(one|single|shared)\b[^.]{0,20}\b(database|db)\b[^.]{0,40}\b(development|staging|production)\b/i, code: 'environment_isolation_error', severity: 'error', suggestion: 'Do not share one database instance across environments.' },
  { pattern: /\b(lower(?:ing)? concurrency|locking)\b[^.]{0,80}\b(duplicate|prevent.{0,20}publish)\b/i, code: 'locking_overclaim', severity: 'error', suggestion: 'Locks and concurrency help but publishing should be idempotent.' },
  { pattern: /\b(background job|cron job|periodic job)\b[^.]{0,80}\b(enforce|update usage|plan limits?)\b/i, code: 'background_job_overclaim', severity: 'error', suggestion: 'Validate and increment usage atomically during protected actions.' },
  { pattern: /\bguarantee(?:s|d)?\b/i, code: 'guaranteed_outcome', severity: 'warning', suggestion: 'Use qualified language: can, may, often, depending on.' },
  { pattern: /\binstant(?:ly)?\s+scalab/i, code: 'instant_scalability', severity: 'warning', suggestion: 'Scalability depends on architecture and workload.' },
];

const ANGLE_SPECIFICITY_MIN: Record<PostAngle, number> = {
  practical_tutorial: 65,
  technical_mistake: 65,
  architecture_tradeoff: 65,
  debugging_story: 60,
  defensible_opinion: 50,
  product_lesson: 50,
  reflection: 40,
};

export function getSpecificityThreshold(plan: BatchPostPlan): number {
  return ANGLE_SPECIFICITY_MIN[plan.angle] ?? 50;
}

export function isTopicSuitableForAngle(topic: string, angle: PostAngle): boolean {
  const t = topic.toLowerCase();
  if (angle !== 'architecture_tradeoff') return true;
  const hasComparisonCue = /\b(vs\.?|versus|compare|comparison|trade-?off|alternative|or)\b/i.test(topic);
  const hasMultipleApproaches = /\b(queue|cache|sql|nosql|monolith|microservice|sync|async|batch|immediate|server|client)\b/i.test(t);
  return hasComparisonCue || hasMultipleApproaches;
}

export function resolvePlanAngle(topic: string, angle: PostAngle): PostAngle {
  if (isTopicSuitableForAngle(topic, angle)) return angle;
  if (angle === 'architecture_tradeoff') return 'practical_tutorial';
  return angle;
}

const IDEMPOTENCY_SIGNALS = /\b(idempoten|atomic claim|unique constraint|deduplication key|compare-and-set|transactional state)\b/i;
const ATOMIC_USAGE_SIGNALS = /\b(atomically|atomic increment|validate.{0,30}increment|same transaction)\b/i;

function isVerifiedIdentityPhrase(phrase: string, authorDescription: string): boolean {
  const desc = authorDescription.toLowerCase();
  if (!VERIFIED_IDENTITY_PATTERNS.some((p) => p.test(phrase))) return false;
  const normalized = phrase.toLowerCase().replace(/[^a-z\s]/g, ' ').trim();
  return desc.includes(normalized.slice(0, Math.min(normalized.length, 40)));
}

export function detectUnsupportedFirstPersonClaims(body: string, authorDescription: string): string[] {
  const evidence: string[] = [];
  for (const re of NARRATIVE_FIRST_PERSON) {
    const match = body.match(re);
    if (!match) continue;
    const phrase = match[0];
    if (isVerifiedIdentityPhrase(phrase, authorDescription)) continue;
    evidence.push(phrase);
  }
  return [...new Set(evidence)];
}

function shouldSkipTechnicalRule(code: string, text: string): boolean {
  if (code === 'auth_vs_authorization' && /\b(authorization|tenant[- ]scoped|tenant[- ]aware|scoped quer)\b/i.test(text)) {
    return true;
  }
  if (
    code === 'frontend_security_claim' &&
    /\b(not a security|not security|security boundary|UX|user experience|server-side)\b/i.test(text)
  ) {
    return true;
  }
  return false;
}

export function detectDeterministicTechnicalIssues(text: string): QualityIssue[] {
  const issues: QualityIssue[] = [];
  for (const rule of DETERMINISTIC_TECH_RULES) {
    const match = text.match(rule.pattern);
    if (!match) continue;
    if (shouldSkipTechnicalRule(rule.code, text)) continue;
    issues.push({
      code: rule.code,
      severity: rule.severity,
      evidence: [match[0].slice(0, 120)],
      instruction: rule.suggestion,
    });
  }

  if (/\b(queue|concurrency|lock)\b/i.test(text) && /\b(duplicate|publish)\b/i.test(text) && !IDEMPOTENCY_SIGNALS.test(text)) {
    issues.push({
      code: 'idempotency_omitted',
      severity: 'error',
      evidence: ['duplicate publishing discussed without idempotency'],
      instruction: 'Mention idempotency keys, atomic claims, or unique constraints for publish operations.',
    });
  }

  if (/\b(usage|plan limit|entitlement)\b/i.test(text) && /\b(background|periodic|cron)\b/i.test(text) && !ATOMIC_USAGE_SIGNALS.test(text)) {
    issues.push({
      code: 'atomic_usage_omitted',
      severity: 'error',
      evidence: ['background job described as primary usage enforcement'],
      instruction: 'Validate and increment usage atomically during the protected API operation.',
    });
  }

  return issues;
}

export function scoreSpecificity(text: string): SpecificityResult {
  const signals: string[] = [];
  const missing: string[] = [];
  const categories = {
    namedMechanism: 0,
    implementationBoundary: 0,
    failureMode: 0,
    actionableImplementation: 0,
    tradeoffOrCondition: 0,
    causalExplanation: 0,
  };

  if (/use api checks for security/i.test(text)) {
    return { score: 15, signals: [], missing: ['named_mechanism', 'implementation_boundary', 'failure_mode'] };
  }

  if (/\b(tenant|authorization|entitlement|middleware|endpoint|queue|webhook|scheduler|idempoten|transaction|database|handler|route|prisma|postgres|token|subscription)\b/i.test(text)) {
    categories.namedMechanism = 18;
    signals.push('named_mechanism');
  }
  if (/\b(server-side|client-side|api layer|database layer|middleware|boundary|same transaction|tenant-scoped|protected (?:api )?operation)\b/i.test(text)) {
    categories.implementationBoundary = 18;
    signals.push('implementation_boundary');
  }
  if (/\b(failure mode|duplicate|retry|timeout|race condition|drift|leak|cross-tenant|incorrect|fails when|breaks when)\b/i.test(text)) {
    categories.failureMode = 18;
    signals.push('failure_mode');
  }
  if (/\b(step \d|first,|then,|configure|implement|validate|increment|check|add)\b/i.test(text)) {
    categories.actionableImplementation = 16;
    signals.push('actionable_implementation');
  }
  if (/\b(trade-?off|depending on|limitation|when|may|can|if)\b/i.test(text)) {
    categories.tradeoffOrCondition = 14;
    signals.push('tradeoff_or_condition');
  }
  if (/\b(because|cause|leads to|results in|prevents|when .+ then)\b/i.test(text)) {
    categories.causalExplanation = 16;
    signals.push('causal_explanation');
  }

  const keywordOnly = categories.namedMechanism > 0 &&
    categories.implementationBoundary === 0 &&
    categories.failureMode === 0 &&
    categories.causalExplanation === 0;
  if (keywordOnly) categories.namedMechanism = Math.min(categories.namedMechanism, 8);

  const score = Math.min(
    100,
    categories.namedMechanism +
      categories.implementationBoundary +
      categories.failureMode +
      categories.actionableImplementation +
      categories.tradeoffOrCondition +
      categories.causalExplanation,
  );

  if (categories.namedMechanism === 0) missing.push('named_mechanism');
  if (categories.implementationBoundary === 0) missing.push('implementation_boundary');
  if (categories.failureMode === 0) missing.push('failure_mode');
  if (categories.actionableImplementation === 0) missing.push('actionable_implementation');
  if (categories.causalExplanation === 0) missing.push('causal_explanation');

  return { score, signals, missing };
}

export function validateAngleContent(body: string, plan: BatchPostPlan): QualityIssue[] {
  const issues: QualityIssue[] = [];

  switch (plan.angle) {
    case 'debugging_story':
      if (!/\b(symptom|failed|error|timeout|duplicate|retry|stuck|incorrect)\b/i.test(body)) {
        issues.push({ code: 'debugging_missing_symptom', severity: 'error', instruction: 'Include a defined failure symptom.' });
      }
      if (!/\b(because|cause|mechanism|reason|due to)\b/i.test(body)) {
        issues.push({ code: 'debugging_missing_cause', severity: 'error', instruction: 'Explain a likely mechanism or cause.' });
      }
      if (!/\b(fix|prevent|guard|idempoten|atomic|constraint)\b/i.test(body)) {
        issues.push({ code: 'debugging_missing_prevention', severity: 'error', instruction: 'Include a correction and prevention lesson.' });
      }
      break;
    case 'technical_mistake':
      if (!/\b(mistake|wrong|incorrect|anti-?pattern|should not|instead|pitfall|risk|problem|avoid)\b/i.test(body)) {
        issues.push({ code: 'mistake_not_named', severity: 'error', instruction: 'Name the actual mistake and consequence.' });
      }
      break;
    case 'architecture_tradeoff':
      if (!/\b(trade-?off|versus|vs\.|alternative|on the other hand|however)\b/i.test(body)) {
        issues.push({ code: 'tradeoff_missing', severity: 'error', instruction: 'Describe two valid alternatives and the trade-off.' });
      }
      if (/\b(consistency|security|environment)\b[^.]{0,40}\bversus\b[^.]{0,40}\b(scalability|usability)\b/i.test(body) &&
          !/\b(context|workload|specific)\b/i.test(body)) {
        issues.push({ code: 'false_dichotomy', severity: 'error', instruction: 'Explain why the trade-off applies in this specific context.' });
      }
      break;
    case 'practical_tutorial':
      if (!/\b(step|first|then|configure|implement|add|check|validate)\b/i.test(body)) {
        issues.push({ code: 'tutorial_not_actionable', severity: 'error', instruction: 'Include actionable implementation steps.' });
      }
      break;
    case 'defensible_opinion':
      if (!/\b(because|since|reason|however|limitation|counter)\b/i.test(body)) {
        issues.push({ code: 'opinion_missing_reasoning', severity: 'error', instruction: 'Include reasoning and a limitation or counterpoint.' });
      }
      break;
    case 'product_lesson':
      if (!/\b(user|reliability|maintain|cost|value|product|customer)\b/i.test(body)) {
        issues.push({ code: 'product_lesson_weak', severity: 'warning', instruction: 'Connect to user value, reliability, or maintainability.' });
      }
      break;
    default:
      break;
  }

  return issues;
}

export function validatePostTopicFingerprints(
  post: GeneratedPostContent,
  plan: BatchPostPlan,
  sourceTitle: string,
  batchFingerprints: TopicFingerprint[] = [],
  history: TopicHistoryRow[] = [],
): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const fp = fingerprintFromBody(post.body, sourceTitle, plan.angle);

  const batchCheck = evaluateBatchTopicSimilarity(fp, batchFingerprints);
  if (batchCheck.duplicate && batchCheck.code) {
    issues.push({
      code: batchCheck.code,
      severity: 'error',
      instruction: 'Develop a different core claim, mechanism, or failure mode for this batch slot.',
    });
  }

  const historyCheck = evaluateHistoricalPostSimilarity(fp, history);
  if (historyCheck.blocked) {
    issues.push({
      code: 'historical_topic_duplicate',
      severity: 'error',
      instruction: 'Avoid repeating a recently generated, scheduled, or published topic. Change the core claim.',
    });
  }

  if (plan.topicCluster && fp.topicCluster === plan.topicCluster) {
    const claimSim = jaccardSimilarity(fp.coreClaim, plan.coreClaim ?? '');
    if (plan.coreClaim && claimSim < 0.35 && batchFingerprints.some((b) => b.topicCluster === plan.topicCluster)) {
      issues.push({
        code: 'repeated_topic_cluster',
        severity: 'warning',
        instruction: 'Post drifted toward a familiar cluster; strengthen a distinct mechanism focus.',
      });
    }
  }

  return issues;
}

export function runDeterministicValidation(
  post: GeneratedPostContent,
  author: AuthorContext,
  plan: BatchPostPlan,
  acceptedBodies: string[],
  topicContext?: {
    sourceTitle?: string;
    batchFingerprints?: TopicFingerprint[];
    history?: TopicHistoryRow[];
  },
): DeterministicValidationResult {
  const issues: QualityIssue[] = [];
  let score = 100;
  const body = post.body || '';

  const fpEvidence = detectUnsupportedFirstPersonClaims(body, author.description);
  if (fpEvidence.length) {
    issues.push({
      code: 'unsupported_first_person',
      severity: 'error',
      evidence: fpEvidence,
      instruction: 'Rewrite as a general engineering scenario. Do not attribute the experience to the author.',
    });
    score -= 30;
  }

  issues.push(...detectDeterministicTechnicalIssues(body));

  const specificity = scoreSpecificity(body);
  const minSpec = getSpecificityThreshold(plan);
  if (specificity.score < minSpec) {
    issues.push({
      code: 'insufficient_specificity',
      severity: 'error',
      evidence: specificity.missing,
      instruction: `Add concrete mechanism, boundary, or failure mode. Score ${specificity.score} < ${minSpec}.`,
    });
    score -= 20;
  }

  issues.push(...validateAngleContent(body, plan));

  if (isGenericEnding(body)) {
    issues.push({ code: 'generic_ending', severity: 'error', instruction: 'Replace generic engagement-bait ending.' });
    score -= 15;
  }

  const tags = (post.hashtags || '').split(/\s+/).filter((t) => t.startsWith('#'));
  if (tags.length > 3) {
    issues.push({ code: 'too_many_hashtags', severity: 'error' });
    score -= 10;
  }

  for (const prev of acceptedBodies) {
    if (jaccardSimilarity(body, prev) > 0.55) {
      issues.push({ code: 'batch_similarity', severity: 'error' });
      score -= 25;
      break;
    }
  }

  if (topicContext) {
    const topicIssues = validatePostTopicFingerprints(
      post,
      plan,
      topicContext.sourceTitle ?? plan.sourceTopic ?? '',
      topicContext.batchFingerprints ?? [],
      topicContext.history ?? [],
    );
    issues.push(...topicIssues);
  }

  for (const issue of issues) {
    if (issue.severity === 'error') score -= 5;
    else score -= 2;
  }

  score = Math.max(0, Math.min(100, score));
  const blocking = issues.filter((i) => i.severity === 'error');
  return { passed: blocking.length === 0, deterministicScore: score, score, issues, specificity };
}

export function validateFormattedBody(
  body: string,
  hashtags: string,
  authorDescription: string,
  options: { includeContactInfo: boolean; includeWebsiteLink: boolean },
): QualityIssue[] {
  const issues: QualityIssue[] = [];

  const fp = detectUnsupportedFirstPersonClaims(body, authorDescription);
  if (fp.length) {
    issues.push({ code: 'unsupported_first_person_after_format', severity: 'error', evidence: fp });
  }

  if (!options.includeContactInfo && /Contact:/i.test(body)) {
    issues.push({ code: 'unauthorized_contact', severity: 'error' });
  }
  if (!options.includeWebsiteLink && /\bLearn more:\s*https?:\/\//i.test(body)) {
    issues.push({ code: 'unauthorized_website', severity: 'error' });
  }

  const tagCount = hashtags.split(/\s+/).filter((t) => t.startsWith('#')).length;
  if (tagCount > 3) issues.push({ code: 'too_many_hashtags_after_format', severity: 'error' });

  if (body.length < 100 || body.length > 2000) {
    issues.push({ code: 'body_length_out_of_bounds', severity: 'warning' });
  }

  const paragraphs = body.split(/\n\n+/);
  const seen = new Set<string>();
  for (const p of paragraphs) {
    const key = p.trim().toLowerCase();
    if (key && seen.has(key)) issues.push({ code: 'duplicate_paragraph', severity: 'error' });
    seen.add(key);
  }

  issues.push(...detectDeterministicTechnicalIssues(body).filter((i) => i.severity === 'error'));

  return issues;
}

export function validateImageContent(
  image: ImageContent,
  approvedPost: GeneratedPostContent,
): ImageValidationResult {
  const issues: QualityIssue[] = [];
  const approvedText = approvedPost.body;

  if (image.mode === 'none') return { passed: true, issues: [] };

  const imageText = [image.headline, image.supportingText, ...(image.bulletPoints ?? [])].join(' ');

  if (/\b(contact:|learn more:|https?:\/\/|@\w+)/i.test(imageText)) {
    issues.push({ code: 'image_contact_or_url', severity: 'error' });
  }

  if (countWords(image.headline) > MAX_IMAGE_HEADLINE_WORDS) {
    issues.push({ code: 'image_headline_too_long', severity: 'error' });
  }
  if (image.headline.length > MAX_IMAGE_HEADLINE_CHARS) {
    issues.push({ code: 'image_headline_too_many_chars', severity: 'error' });
  }

  if (image.supportingText) {
    if (countWords(image.supportingText) > MAX_IMAGE_SUBHEADING_WORDS) {
      issues.push({ code: 'image_subheading_too_long', severity: 'error' });
    }
    if (image.supportingText.length > MAX_IMAGE_SUBHEADING_CHARS) {
      issues.push({ code: 'image_subheading_too_many_chars', severity: 'error' });
    }
  }

  const bullets = image.bulletPoints ?? [];
  if (bullets.length > 3) issues.push({ code: 'image_too_many_bullets', severity: 'error' });
  for (const b of bullets) {
    if (countWords(b) > MAX_IMAGE_BULLET_WORDS) issues.push({ code: 'image_bullet_too_long', severity: 'error' });
    if (/\b(growth|innovation|strategy|revolutionize|game changer)\b/i.test(b)) {
      issues.push({ code: 'image_vague_bullet', severity: 'error' });
    }
  }

  issues.push(...detectDeterministicTechnicalIssues(imageText).filter((i) => i.severity === 'error'));

  const approvedTokens = tokenSet(approvedText);
  const imageTokens = [...tokenSet(imageText)].filter((t) => t.length > 4);
  const unsupported = imageTokens.filter((t) => !approvedTokens.has(t) && !['server', 'client', 'users', 'teams'].includes(t));
  if (unsupported.length > 8) {
    issues.push({ code: 'image_new_claims', severity: 'error', evidence: unsupported.slice(0, 5) });
  }

  return { passed: issues.filter((i) => i.severity === 'error').length === 0, issues };
}

export function sanitizeImageContent(image: ImageContent): ImageContent {
  if (image.mode === 'none') return image;

  let headline = clampWords(clampChars(image.headline, MAX_IMAGE_HEADLINE_CHARS), MAX_IMAGE_HEADLINE_WORDS);
  let supportingText = image.supportingText
    ? clampWords(clampChars(image.supportingText, MAX_IMAGE_SUBHEADING_CHARS), MAX_IMAGE_SUBHEADING_WORDS)
    : undefined;

  if (supportingText && countWords(supportingText) > MAX_IMAGE_SUBHEADING_WORDS) {
    supportingText = undefined;
  }

  const bulletPoints = (image.bulletPoints ?? [])
    .slice(0, 3)
    .map((b) => clampWords(b, MAX_IMAGE_BULLET_WORDS))
    .filter((b) => b.length > 0);

  return {
    mode: bulletPoints.length >= 2 ? 'checklist' : image.mode === 'checklist' && bulletPoints.length === 0 ? 'single_insight' : image.mode,
    headline,
    supportingText: supportingText || undefined,
    bulletPoints: bulletPoints.length ? bulletPoints : undefined,
  };
}

export function buildSafeFallbackImageContent(finalized: {
  body: string;
  headline: string;
}): ImageContent {
  const firstSentence = finalized.body.split(/[.!?]/).find((s) => s.trim().length > 20)?.trim()
    ?? finalized.headline;

  const safe = clampWords(clampChars(firstSentence, MAX_IMAGE_HEADLINE_CHARS), MAX_IMAGE_HEADLINE_WORDS);
  if (countWords(safe) < 3) {
    return { mode: 'none', headline: '', bulletPoints: [] };
  }

  return {
    mode: 'single_insight',
    headline: safe,
    supportingText: undefined,
    bulletPoints: [],
  };
}

export function issuesToRepairInput(issues: QualityIssue[]): QualityIssue[] {
  return issues.filter((i) => i.severity === 'error');
}

const CRITICAL_BLOCKING_CODES = new Set([
  'unsupported_first_person',
  'unsupported_first_person_after_format',
  'environment_isolation_error',
  'docker_framework',
  'background_job_overclaim',
  'unauthorized_contact',
  'unauthorized_website',
  'batch_similarity',
  'generic_ending',
  'too_many_hashtags',
  'too_many_hashtags_after_format',
]);

const RELAXABLE_BLOCKING_CODES = new Set([
  'insufficient_specificity',
  'mistake_not_named',
  'debugging_missing_symptom',
  'debugging_missing_cause',
  'debugging_missing_prevention',
  'tutorial_not_actionable',
  'opinion_missing_reasoning',
  'false_dichotomy',
  'tradeoff_missing',
  'guaranteed_outcome',
  'compliance_overclaim',
  'tenant_isolation_confusion',
  'frontend_security_claim',
  'idempotency_omitted',
  'locking_overclaim',
  'audit_trail_overclaim',
  'token_auth_overclaim',
  'auth_vs_authorization',
  'product_lesson_weak',
]);

export function filterBlockingIssues(issues: QualityIssue[], attempt: number): QualityIssue[] {
  const errors = issues.filter((i) => i.severity === 'error');
  if (attempt >= 7) {
    return errors.filter((i) => CRITICAL_BLOCKING_CODES.has(i.code));
  }
  if (attempt >= 3) {
    return errors.filter((i) => !RELAXABLE_BLOCKING_CODES.has(i.code) || CRITICAL_BLOCKING_CODES.has(i.code));
  }
  return errors;
}

export function canForceAcceptBlockingCodes(codes: string[]): boolean {
  if (codes.length === 0) return true;
  return codes.every((code) => RELAXABLE_BLOCKING_CODES.has(code) && !CRITICAL_BLOCKING_CODES.has(code));
}
