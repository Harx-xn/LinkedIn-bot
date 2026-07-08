import type { AuthorContext, BatchPostPlan, GeneratedPostContent, PostQualityResult } from './generationTypes';
import {
  detectUnsupportedFirstPersonClaims as detectUnsupportedFirstPersonClaimsExpanded,
  detectDeterministicTechnicalIssues,
  scoreSpecificity,
} from './ghostwriterValidationService';
import {
  endsWithQuestion,
  isGenericEnding,
  jaccardSimilarity,
  tokenSet,
} from './ghostwriterTextUtils';

export { detectUnsupportedFirstPersonClaimsExpanded as detectUnsupportedFirstPersonClaims };
export { jaccardSimilarity, tokenSet, isGenericEnding, endsWithQuestion };

const GENERIC_PHRASES = [
  /\bmodern technology\b/i,
  /\bdigital transformation\b/i,
  /\bdrive growth\b/i,
  /\bunlock potential\b/i,
  /\brevolutionize\b/i,
  /\bgame changer\b/i,
  /\bcompetitive landscape\b/i,
  /\bstrategic move\b/i,
  /\breach your goals\b/i,
  /\bin today's world\b/i,
  /\bharnessing technology\b/i,
  /\bdata-driven insights\b/i,
  /\bunlock\b/i,
  /\bleverage technology\b/i,
];

export function convertUnsupportedFirstPerson(body: string): string {
  let out = body;
  out = out.replace(/\bI ignored Docker for months\b/gi,
    'Docker is often dismissed as unnecessary complexity until environment differences begin slowing a team down.');
  out = out.replace(/\bI learned that\b/gi, 'A useful lesson is that');
  out = out.replace(/\bI discovered that\b/gi, 'One pattern that shows up often is that');
  out = out.replace(/\bWe nearly\b/gi, 'Teams often nearly');
  out = out.replace(/\bI built\b/gi, 'A common implementation approach is to build');
  out = out.replace(/\bmy clients\b/gi, 'many teams');
  out = out.replace(/\bour customers\b/gi, 'users');
  return out;
}

export function detectTechnicalIssues(text: string): string[] {
  return detectDeterministicTechnicalIssues(text).map((i) => i.code);
}

export function countGenericPhrases(text: string): number {
  return GENERIC_PHRASES.filter((re) => re.test(text)).length;
}

export function hasSpecificity(text: string): boolean {
  return scoreSpecificity(text).score >= 50;
}

export function evaluatePostQuality(
  post: GeneratedPostContent,
  author: AuthorContext,
  _batchPlans: BatchPostPlan[],
  acceptedBodies: string[],
  plan?: BatchPostPlan,
): PostQualityResult {
  const reasons: string[] = [];
  const warnings: string[] = [];
  let score = 100;
  const body = post.body || '';

  const firstPerson = detectUnsupportedFirstPersonClaimsExpanded(body, author.description);
  if (firstPerson.length) {
    reasons.push('unsupported_first_person');
    score -= 25;
  }

  const technical = detectTechnicalIssues(body);
  if (technical.length) {
    warnings.push(...technical);
    score -= technical.length * 8;
  }

  const genericCount = countGenericPhrases(body);
  if (genericCount >= 3 && !hasSpecificity(body)) {
    reasons.push('generic_language');
    score -= 20;
  } else if (genericCount >= 2) {
    warnings.push('some_generic_language');
    score -= 8;
  }

  if (!hasSpecificity(body)) {
    reasons.push('missing_specificity');
    score -= 18;
  }

  if (isGenericEnding(body)) {
    reasons.push('generic_ending');
    score -= 15;
  }

  const tags = (post.hashtags || '').split(/\s+/).filter((t) => t.startsWith('#'));
  if (tags.length > 3) {
    reasons.push('too_many_hashtags');
    score -= 10;
  }

  for (const prev of acceptedBodies) {
    const sim = jaccardSimilarity(body, prev);
    if (sim > 0.55) {
      reasons.push('batch_similarity');
      score -= 25;
      break;
    }
  }

  if (plan?.endingStyle === 'takeaway' && endsWithQuestion(body)) {
    warnings.push('planned_takeaway_ended_with_question');
    score -= 5;
  }

  score = Math.max(0, Math.min(100, score));
  const passed = score >= 70 && reasons.length === 0;

  return { passed, score, reasons, warnings };
}

export function evaluateBatchDiversity(
  bodies: string[],
  plans: BatchPostPlan[],
): string[] {
  const issues: string[] = [];
  const questionEndings = bodies.filter(endsWithQuestion).length;
  if (questionEndings > 2) issues.push('too_many_question_endings');

  const hooks = plans.map((p) => p.hookStyle);
  for (const style of new Set(hooks)) {
    if (hooks.filter((h) => h === style).length > 2) {
      issues.push(`repeated_hook_style:${style}`);
    }
  }

  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      if (jaccardSimilarity(bodies[i], bodies[j]) > 0.55) {
        issues.push(`similar_posts:${i + 1}_${j + 1}`);
      }
    }
  }

  return issues;
}

export function evaluateTopicCombination(
  topicA: string,
  topicB: string,
  author: AuthorContext,
): { canCombine: boolean; connection: string | null; reason: string } {
  const sim = jaccardSimilarity(topicA, topicB);
  const sharedNiche = (author.niches ?? []).some(
    (n) => topicA.toLowerCase().includes(n.toLowerCase()) || topicB.toLowerCase().includes(n.toLowerCase()),
  );

  if (/\b(hiring|internship|seo agency|recruitment|press release)\b/i.test(topicA + ' ' + topicB)) {
    return { canCombine: false, connection: null, reason: 'promotional_or_job_topics' };
  }

  if (sim > 0.35 || sharedNiche) {
    return {
      canCombine: true,
      connection: 'Shared niche or overlapping technical theme',
      reason: 'topics_related',
    };
  }

  return { canCombine: false, connection: null, reason: 'weak_topic_connection' };
}
