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
import { evaluateSemanticProgression } from './semanticProgression';
import type { TopicHistoryRow } from './topicHistoryService';
import { buildLengthRepairInstruction, evaluateGeneratedPostLength } from './generatedPostLength';
import { resolvePostDepthMetadata } from './postDepth';
import { evaluateFirstThreeLines } from './editorialDecisionService';
import { classifyFinalPostFingerprint } from './finalPostFingerprintClassifier';

function editorialRealizationIssues(body: string, plan: BatchPostPlan): QualityIssue[] {
  const decision = plan.editorialDecision;
  if (!decision) return [];
  const actual = classifyFinalPostFingerprint(body, {
    plannedMechanism: plan.mechanismFocus?.join(' '),
    plannedIdeaFamily: decision.referenceValueForm,
  });
  const issues: QualityIssue[] = [];
  const hookMatches: Record<string, boolean> = {
    OBSERVATION: ['PRACTICAL_OBSERVATION', 'PATTERN_RECOGNITION', 'DIAGNOSTIC', 'CAUSAL_EXPLANATION'].includes(actual.rhetoricalMove) && actual.openingBehavior !== 'GENERIC_CATEGORY_SETUP',
    DIRECT_VALUE_PROMISE: ['DIRECT_DECLARATIVE', 'DIRECT_INSTRUCTION', 'MECHANISM_FIRST', 'CONSEQUENCE_FIRST'].includes(actual.openingSyntax),
    CONTRARIAN_CLAIM: ['TRADE_OFF', 'COMPARISON', 'MISCONCEPTION_CORRECTION'].includes(actual.rhetoricalMove) || actual.openingSyntax === 'CONTRAST',
    MISTAKE: ['MISCONCEPTION_CORRECTION', 'DIAGNOSTIC', 'WARNING'].includes(actual.rhetoricalMove),
    COMPARISON: ['COMPARISON', 'TRADE_OFF'].includes(actual.rhetoricalMove) || actual.openingSyntax === 'CONTRAST',
    QUESTION: actual.openingSyntax === 'QUESTION' && actual.openingBehavior !== 'OBVIOUS_QUESTION_ANSWER',
    SPECIFIC_RESULT: actual.openingSyntax === 'DATA_FIRST',
    FIRST_PERSON_LESSON: actual.hookType === 'PERSONAL_OBSERVATION_HOOK',
    STORY_OPENING: actual.openingSyntax === 'SCENARIO' || actual.hookType === 'PERSONAL_OBSERVATION_HOOK',
  };
  const opening = body.split(/\n+/).find((line) => line.trim())?.trim() ?? '';
  const substantiveOpening = opening.length >= 45
    && (opening.match(/[\p{L}\p{N}]+/gu) ?? []).length >= 7
    && /\b(?:because|when|while|but|cost|risk|constraint|overhead|reduces?|increases?|changes?|fails?|creates?|requires?|depends?)\b/i.test(opening);
  if (actual.openingBehavior === 'GENERIC_CATEGORY_SETUP' && !substantiveOpening) {
    issues.push({ code: 'generic_category_intro', severity: 'error', evidence: [opening], instruction: 'Replace the broad category setup with a substantive, claim-specific opening.' });
  }
  if (hookMatches[decision.hookFamily] === false && !substantiveOpening) {
    issues.push({ code: 'hook_realization_mismatch', severity: 'error', evidence: [`assigned=${decision.hookFamily}`, `realized=${actual.openingSyntax}/${actual.rhetoricalMove}`], instruction: `Rewrite only the opening so it performs the assigned ${decision.hookFamily.toLowerCase().replace(/_/g, ' ')} function without changing the claim or inventing audience behavior, a misconception, or controversy.` });
  }
  const structureMatches: Record<string, boolean> = {
    CLAIM_EXPLANATION_IMPLICATION: ['CLAIM_MECHANISM_CONSEQUENCE', 'OBSERVATION_CAUSAL_EXPLANATION', 'CLAIM_SUPPORT_RESOLUTION'].includes(actual.argumentPattern),
    OBSERVATION_MECHANISM_CONSEQUENCE: Boolean(actual.mechanism) && /\b(?:means|result|consequence|cost|risk|reduces?|increases?|leads? to)\b/i.test(body),
    MISTAKE_CAUSE_CORRECTION: /\b(?:mistake|failure|fails?|symptom|problem)\b/i.test(body) && Boolean(actual.mechanism),
    COMPARISON_DISTINCTION_DECISION: ['CONTRAST_REFRAME', 'CLAIM_TRADEOFF_QUALIFICATION'].includes(actual.argumentPattern),
    QUESTION_ANSWER_TAKEAWAY: actual.hookType === 'QUESTION_HOOK',
    FRAMEWORK_EXPLANATION_APPLICATION: ['PRACTICAL_SEQUENCE', 'OBSERVATION_CAUSAL_EXPLANATION', 'CLAIM_MECHANISM_CONSEQUENCE'].includes(actual.argumentPattern) && /\b(?:step|process|apply|check|sequence|framework|method)\b/i.test(body),
    COMPACT_INSIGHT: actual.structure === 'COMPACT_ARGUMENT' || body.length < 1200,
    STORY_TURNING_POINT_LESSON: /\b(?:I|we|then|until|realized|learned)\b/i.test(body),
  };
  const compatibleReasoning = Boolean(actual.mechanism)
    && ['CLAIM_MECHANISM_CONSEQUENCE', 'OBSERVATION_CAUSAL_EXPLANATION', 'CLAIM_SUPPORT_RESOLUTION', 'CONTRAST_REFRAME', 'CLAIM_TRADEOFF_QUALIFICATION'].includes(actual.argumentPattern);
  if (structureMatches[decision.rhetoricalStructure] === false && !compatibleReasoning) {
    issues.push({ code: 'rhetorical_structure_mismatch', severity: 'error', evidence: [`assigned=${decision.rhetoricalStructure}`, `realized=${actual.argumentPattern}/${actual.structure}`], instruction: `Preserve the claim and evidence, but realize the assigned ${decision.rhetoricalStructure.toLowerCase().replace(/_/g, ' ')} progression rather than a generic explanatory essay.` });
  }
  const compatibleEndings: Record<string, string[]> = {
    CONCLUSION: ['CONCLUSION'], INSIGHT: ['INSIGHT', 'OBSERVATION', 'NO_CTA'], PREDICTION: ['PREDICTION'], OBSERVATION: ['OBSERVATION', 'NO_CTA'],
    CHALLENGE: ['CHALLENGE'], QUESTION: ['QUESTION'], PERSONAL_NOTE: ['PERSONAL_NOTE'], SOFT_CTA: ['SOFT_CTA'], NO_CTA: ['NO_CTA', 'INSIGHT', 'OBSERVATION'],
  };
  if (!(compatibleEndings[decision.endingIntent] ?? []).includes(actual.endingIntent)) {
    issues.push({ code: 'ending_realization_mismatch', severity: 'error', evidence: [`assigned=${decision.endingIntent}`, `realized=${actual.endingIntent}`], instruction: `Replace only the ending with the assigned ${decision.endingIntent.toLowerCase().replace(/_/g, ' ')} behavior. Do not add a generic summary, recommendation, question, or CTA.` });
  }
  return issues;
}

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

export function getSpecificityThreshold(plan: BatchPostPlan): number {
  switch (plan.expressionMode) {
    case 'reflective': return 45;
    case 'opinionated': return 50;
    case 'conversational': return 50;
    default: return 55;
  }
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

  if (/use api checks for security/i.test(text)) {
    return { score: 15, signals: [], missing: ['concrete_support'] };
  }

  const concreteTerms = text.match(/\b(?:api|endpoint|request|response|query|row|record|dataset|payload|serializ\w*|memory|client|server|pagination|cache|index|database|transaction|middleware|handler|controller|binding|input|queue|worker|webhook|retry|idempoten\w*|tenant|authentication|authorization|token|constraint|lock|thread|process|cpu|latency|timeout|event|table|join|route|service|versioning|version|backward compatibility|http|method|resource|schema|data format|postgres|prisma|subscription|entitlement)\b/gi) ?? [];
  const concreteCount = new Set(concreteTerms.map((term) => term.toLowerCase())).size;
  const hasCausalDepth = /\b(?:because|when|whenever|if|unless|while|so that|which (?:means|causes|forces|prevents|increases|reduces)|increases?|reduces?|prevents?|requires?|returns?|serializes?|reaches?|triggers?|blocks?|breaks?|changes?|integrates?|evolves?|defines?|reveals?|hides?|crowds? out|depends? on|leads? to|results? in|before|after|instead of|rather than)\b/i.test(text);
  const hasPreciseOperation = /\b(?:check|validate|bind|paginate|cache|index|query|return|serialize|increment|enforce|scope|deduplicate|trace|inspect|measure|limit)\w*\b/i.test(text);
  const hasConcreteRelationship = concreteCount >= 2 && (hasCausalDepth || hasPreciseOperation);
  const contentWords = text.toLowerCase().match(/\b[a-z][a-z'-]{4,}\b/g) ?? [];
  const stopWords = new Set(['about', 'after', 'again', 'being', 'could', 'every', 'first', 'their', 'there', 'these', 'thing', 'those', 'through', 'under', 'which', 'while', 'would']);
  const distinctiveWords = new Set(contentWords.filter((word) => !stopWords.has(word)));
  // Specific relationships are domain-neutral: legal deadlines, clinical follow-up,
  // sales qualification, and operational constraints do not need software nouns.
  const hasDomainNeutralRelationship = hasCausalDepth && distinctiveWords.size >= 7 && text.trim().length >= 70;
  const hasQuantifiedDetail = /\b\d[\d,]*(?:\s?(?:ms|mb|gb|rows?|records?|requests?|%))?\b/i.test(text);
  const genericOnly = /\b(?:best practices|scalable systems?|improve performance|ensure reliability|enhance user experience|reduce technical debt|robust solutions?)\b/i.test(text) && concreteCount < 2;

  let score = 10;
  if (concreteCount >= 1) { score = 30; signals.push('concrete_subject', 'named_mechanism'); }
  if (concreteCount >= 3) { score = 40; signals.push('concrete_detail'); }
  if (hasConcreteRelationship) { score = Math.max(score, 78); signals.push('explained_mechanism'); }
  if (hasDomainNeutralRelationship) { score = Math.max(score, 74); signals.push('specific_relationship'); }
  if (hasCausalDepth && concreteCount >= 1) signals.push('causal_explanation');
  if (hasQuantifiedDetail && concreteCount >= 1) { score = Math.max(score, 72); signals.push('quantified_detail'); }
  if (hasConcreteRelationship && hasQuantifiedDetail) score = 90;
  if (genericOnly && !hasDomainNeutralRelationship) score = Math.min(score, 25);

  if (score < 45) missing.push('concrete_support');

  return { score, signals, missing };
}

export function validateAngleContent(body: string, plan: BatchPostPlan): QualityIssue[] {
  const issues: QualityIssue[] = [];

  switch (plan.angle) {
    case 'debugging_story':
      if (!/\b(symptom|signal|failed|error|delay|stuck|incorrect|diagnos|trace|reveals?)\b/i.test(body)) {
        issues.push({ code: 'diagnostic_lens_weak', severity: 'warning', instruction: 'Make the diagnostic observation clearer without forcing symptom, cause, check, and fix sections.' });
      }
      break;
    case 'technical_mistake':
      if (!/\b(mistake|wrong|incorrect|anti-?pattern|should not|instead|pitfall|risk|problem|avoid)\b/i.test(body)) {
        issues.push({ code: 'mistake_lens_weak', severity: 'warning', instruction: 'Clarify the mistaken assumption or correction without adding a formulaic failure section.' });
      }
      break;
    case 'architecture_tradeoff':
      if (!/\b(trade-?off|versus|vs\.|alternative|however|rather than|instead|depends|only when|choice|distinction)\b/i.test(body)) {
        issues.push({ code: 'choice_lens_weak', severity: 'warning', instruction: 'Clarify the decision or distinction; two balanced alternatives are not mandatory.' });
      }
      if (/\b(consistency|security|environment)\b[^.]{0,40}\bversus\b[^.]{0,40}\b(scalability|usability)\b/i.test(body) &&
          !/\b(context|workload|specific)\b/i.test(body)) {
        issues.push({ code: 'false_dichotomy', severity: 'error', instruction: 'Explain why the trade-off applies in this specific context.' });
      }
      break;
    case 'practical_tutorial':
      if ((plan.expressionMode === 'walkthrough' || plan.editorialDecision?.rhetoricalStructure === 'FRAMEWORK_EXPLANATION_APPLICATION')
          && !/\b(step|first|then|before|after|begin|next|process|sequence|apply|use|check|review)\b/i.test(body)) {
        issues.push({ code: 'tutorial_not_actionable', severity: 'error', instruction: 'Include actionable implementation steps.' });
      }
      break;
    case 'defensible_opinion':
      if (!/\b(because|since|reason|means|therefore|so that|which)\b/i.test(body)) {
        issues.push({ code: 'opinion_missing_reasoning', severity: 'error', instruction: 'Support the position with defensible reasoning.' });
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
    enforceLength?: boolean;
  },
): DeterministicValidationResult {
  const issues: QualityIssue[] = [];
  let score = 100;
  const body = post.body || '';
  const { depthClass, targetLengthRange, minimumCompleteLength } = resolvePostDepthMetadata(plan);
  const visibleContent = `${body}${post.hashtags ? `\n\n${post.hashtags}` : ''}`;
  const lengthStatus = evaluateGeneratedPostLength(visibleContent, targetLengthRange, minimumCompleteLength);
  if (topicContext?.enforceLength && (lengthStatus === 'TOO_SHORT' || lengthStatus === 'TOO_LONG')) {
    issues.push({
      code: `generated_post_${lengthStatus.toLowerCase()}`,
      severity: 'error',
      evidence: [`${visibleContent.length} characters for ${depthClass} plan (${targetLengthRange.min}–${targetLengthRange.max} soft range; ${minimumCompleteLength} completeness floor)`],
      instruction: buildLengthRepairInstruction(lengthStatus, targetLengthRange),
    });
    score -= 15;
  }

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

  if (plan.editorialDecision) {
    const opening = evaluateFirstThreeLines(body, {
      personalEvidenceAvailable: plan.editorialDecision.personalEvidenceAvailable,
      audienceTerms: author.targetAudience,
    });
    issues.push(...opening.issues);

    const actualForm = classifyFinalPostFingerprint(body);
    issues.push(...editorialRealizationIssues(body, plan));
    const repeatsActualForm = acceptedBodies.some((acceptedBody) => {
      const acceptedForm = classifyFinalPostFingerprint(acceptedBody);
      return acceptedForm.structure === actualForm.structure
        && acceptedForm.argumentPattern === actualForm.argumentPattern;
    });
    if (repeatsActualForm) {
      issues.push({
        code: 'repeated_body_structure',
        severity: 'warning',
        evidence: [`${actualForm.argumentPattern} / ${actualForm.structure}`],
        instruction: `Develop this idea through its assigned ${plan.editorialDecision.rhetoricalStructure} progression instead of repeating the prior post's body experience.`,
      });
      score -= 6;
    }
    const repeatedOpening = acceptedBodies.some((acceptedBody) => {
      const accepted = classifyFinalPostFingerprint(acceptedBody);
      return accepted.openingBehavior === actualForm.openingBehavior
        && accepted.openingSyntax === actualForm.openingSyntax
        && accepted.rhetoricalMove === actualForm.rhetoricalMove;
    });
    if (repeatedOpening && (
      actualForm.openingBehavior !== 'SUBSTANTIVE_MOVE'
      || actualForm.rhetoricalMove === 'MISCONCEPTION_CORRECTION'
      || actualForm.rhetoricalMove === 'GENERIC_SETUP'
    )) {
      issues.push({ code: 'repeated_opening_form', severity: 'error', evidence: [`${actualForm.openingSyntax}/${actualForm.rhetoricalMove}/${actualForm.openingBehavior}`], instruction: 'Rewrite the opening with a different substantive rhetorical move while preserving the exact claim, mechanism, certainty, and evidence.' });
    }
    const repeatedTransitionPattern = actualForm.transitionPattern !== 'IMPLICIT' && acceptedBodies.some((acceptedBody) =>
      classifyFinalPostFingerprint(acceptedBody).transitionPattern === actualForm.transitionPattern);
    if (repeatedTransitionPattern) {
      issues.push({ code: 'repeated_transition_pattern', severity: 'warning', evidence: [actualForm.transitionPattern], instruction: 'Remove unnecessary essay connectors and let the argument move through its assigned reasoning structure.' });
    }
  }

  issues.push(...detectDeterministicTechnicalIssues(body));

  const specificity = scoreSpecificity(body);
  const minSpec = getSpecificityThreshold(plan);
  if (specificity.score < minSpec) {
    issues.push({
      code: 'insufficient_specificity',
      severity: 'error',
      evidence: specificity.missing,
      instruction: `Add the smallest relevant concrete mechanism, boundary, technical detail, or causal explanation without changing the Expression Mode structure. Score ${specificity.score} < ${minSpec}.`,
    });
    score -= 20;
  }

  issues.push(...validateAngleContent(body, plan));

  const progression = evaluateSemanticProgression(body, {
    allowEnumeration: plan.angle === 'practical_tutorial' || plan.layout === 'mini_checklist' || plan.expressionMode === 'walkthrough',
  });
  if (!progression.passed) {
    const progressionCodes = progression.codes.length ? progression.codes : ['ARGUMENT_STAGNATION'];
    issues.push(...progressionCodes.map((code) => ({
      code,
      severity: 'error',
      evidence: progression.issues,
      instruction: 'Remove or replace redundant paragraphs with one genuinely missing argumentative dimension. Do not synonym-swap. Ensure the ending does not restate the opening.',
    } as QualityIssue)));
    score -= 20;
  }

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

  if (body.includes('**')) {
    issues.push({ code: 'markdown_bold_markers', severity: 'error' });
  }

  if (body.length > 3000) {
    issues.push({ code: 'body_above_linkedin_limit', severity: 'error' });
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
  'guaranteed_outcome',
  'compliance_overclaim',
  'tenant_isolation_confusion',
  'frontend_security_claim',
  'idempotency_omitted',
  'locking_overclaim',
  'audit_trail_overclaim',
  'token_auth_overclaim',
  'auth_vs_authorization',
  'atomic_usage_omitted',
  'false_architecture_tradeoff',
  'unsupported_personal_claim',
]);

const PERSISTENT_COMPLETENESS_CODES = new Set([
  'generated_post_too_short',
  'generated_post_too_long',
  'SEMANTIC_REPETITION',
  'ARGUMENT_STAGNATION',
  'ENUMERATION_WITHOUT_INTERPRETATION',
  'CONCLUSION_RESTATES_THESIS',
  'FORCED_NICHE_PARAGRAPH',
  'GENERIC_RECOMMENDATION_ENDING',
  'REDUNDANT_EXPLANATION',
  'LOW_INFORMATION_DENSITY',
  'GENERIC_SCENARIO_STRUCTURE',
  'GENERIC_CHECKLIST_EXPANSION',
  'THESIS_RESTATEMENT',
  'WEAK_ARGUMENT_PROGRESSION',
  'GENERIC_ENGAGEMENT_ENDING',
  'CLAIM_DRIFT',
]);

const PERSISTENT_QUALITY_CODES = new Set([
  'CLAIM_DRIFT',
  'SEMANTIC_REPETITION',
  'REDUNDANT_EXPLANATION',
  'ARGUMENT_STAGNATION',
  'LOW_INFORMATION_DENSITY',
  'WEAK_ARGUMENT_PROGRESSION',
  'FORCED_NICHE_PARAGRAPH',
  'unsupported_audience_injection',
  'CROSS_DOMAIN_FINAL_TOPIC_UNTRANSFORMED',
]);

const REPAIRABLE_EDITORIAL_CODES = new Set([
  'generic_category_intro',
  'hook_realization_mismatch',
  'rhetorical_structure_mismatch',
  'ending_realization_mismatch',
  'GENERIC_RECOMMENDATION_ENDING',
  'repeated_body_structure',
  'repeated_opening_form',
]);

export function isRepairableEditorialIssueCode(code: string): boolean {
  return REPAIRABLE_EDITORIAL_CODES.has(code);
}

export function isHardBlockIssueCode(code: string): boolean {
  return isCriticalCandidateIssueCode(code) || PERSISTENT_QUALITY_CODES.has(code)
    || ['generated_post_too_short', 'ARGUMENT_STAGNATION', 'SEMANTIC_REPETITION', 'WEAK_ARGUMENT_PROGRESSION'].includes(code);
}

export function isPersistentQualityIssueCode(code: string): boolean {
  return PERSISTENT_QUALITY_CODES.has(code);
}

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

export function isCriticalCandidateIssueCode(code: string): boolean {
  return CRITICAL_BLOCKING_CODES.has(code)
    || /(?:unsupported_(?:first_person|personal|authority)|authority_boundary|source_(?:evidence_)?loss|evidence_(?:loss|integrity)|factual_(?:safety|integrity)|prohibited|hard_platform)/i.test(code)
    || code === 'body_above_linkedin_limit'
    || code === 'generated_post_too_long';
}

export function filterBlockingIssues(issues: QualityIssue[], attempt: number): QualityIssue[] {
  const errors = issues.filter((i) => i.severity === 'error');
  if (attempt >= 7) {
    return errors.filter((i) => isCriticalCandidateIssueCode(i.code)
      || PERSISTENT_COMPLETENESS_CODES.has(i.code)
      || isPersistentQualityIssueCode(i.code));
  }
  if (attempt >= 3) {
    return errors.filter((i) => isPersistentQualityIssueCode(i.code)
      || !RELAXABLE_BLOCKING_CODES.has(i.code)
      || isCriticalCandidateIssueCode(i.code));
  }
  return errors;
}

export function canForceAcceptBlockingCodes(codes: string[]): boolean {
  if (codes.length === 0) return true;
  return codes.every((code) => (RELAXABLE_BLOCKING_CODES.has(code) || isRepairableEditorialIssueCode(code)) && !isHardBlockIssueCode(code));
}
