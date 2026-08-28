import type {
  AuthorContext,
  ClaimSource,
  ExpressionMode,
  PostAngle,
  TrendCandidate,
} from './generationTypes';
import { detectDeterministicTechnicalIssues } from './ghostwriterValidationService';

const GENERIC_CLAIM_PATTERNS = [
  /\b(?:is|are) (?:very )?(?:important|essential|critical|key|valuable)\b/i,
  /\bplays? (?:a )?(?:critical|key|important) role\b/i,
  /\b(?:improves?|enhances?|boosts?) (?:performance|efficiency|productivity|customer experience)\b/i,
  /\b(?:drives?|supports?) (?:success|growth|better outcomes|long[- ]term success)\b/i,
  /\bhelps? (?:businesses|teams|organizations|people) (?:grow|succeed|improve)\b/i,
  /\b(?:reduces? risk|increases? efficiency|should be prioritized)\b/i,
  /\b(?:strong foundation|game[- ]changer|clear takeaway|practical,? focused perspective)\b/i,
];

const CLAIM_RELATIONSHIP = /\b(?:because|when|whenever|if|unless|until|while|before|after|rather than|instead of|depends? on|leads? to|causes?|prevents?|hides?|reveals?|removes?|lowers?|raises?|increases?|reduces?|becomes?|fails?|works? only|matters? most)\b|\b(?:is|are)\s+not\b[^.!?]{0,160}(?:\bbut\b|[.!?]\s*(?:it|they|this)\s+(?:is|are)\b)/i;

const CLAIM_STOP_WORDS = new Set('a an and are as at be because been but by can do does for from had has have if in into is it its may more most not of on or our should so than that the their them then there these they this to under was we when where which while will with without'.split(' '));

export type ClaimAssessment = {
  usable: boolean;
  reasons: string[];
};

export type ClaimFidelityResult = {
  faithful: boolean;
  reasons: string[];
  selectedTokenCoverage: number;
};

export function resolveClaimSource(trend?: TrendCandidate | null): ClaimSource {
  if (!trend) return 'FALLBACK';
  if (trend.sourceType === 'strategy_derived') return 'STRATEGY_SELECTED';
  if (
    trend.sourceType === 'searched'
    || trend.sourceType === 'source_derived_angle'
    || trend.ideaOrigin === 'SEARCH_DISCOVERED'
    || trend.ideaOrigin === 'RECENT_DEVELOPMENT'
  ) return 'SEARCH_DISCOVERED';
  return 'LEGACY_TOPIC';
}

export function isObviouslyGenericClaim(value: string): boolean {
  const claim = value.trim();
  if (!claim) return true;
  return GENERIC_CLAIM_PATTERNS.some((pattern) => pattern.test(claim)) && !CLAIM_RELATIONSHIP.test(claim);
}

export function isAlreadySpecificClaim(value: string): boolean {
  const claim = value.trim();
  if (claim.length < 28 || isObviouslyGenericClaim(claim)) return false;
  return CLAIM_RELATIONSHIP.test(claim) || /\b(?:must|needs?|should|shouldn't|cannot|can\s+(?:hide|lower|raise|worsen|fail)|only)\b/i.test(claim);
}

function hasBalancedDelimiters(value: string): boolean {
  const pairs: Array<[string, string]> = [['(', ')'], ['[', ']'], ['{', '}']];
  return pairs.every(([open, close]) => value.split(open).length === value.split(close).length);
}

export function assessSelectedClaim(value: string): ClaimAssessment {
  const claim = value.trim();
  const reasons: string[] = [];
  const wordCount = claim.split(/\s+/).filter(Boolean).length;
  if (wordCount < 6 || claim.length < 28) reasons.push('too_vague_or_fragmentary');
  if (wordCount > 55 || claim.length > 420) reasons.push('too_broad_or_unwieldy');
  if (isObviouslyGenericClaim(claim)) reasons.push('generic_claim');
  if (/\b(?:because|when|if|unless|until|while|and|or|to|of|for|with|by)\s*[.!?]*$/i.test(claim)) {
    reasons.push('grammatically_incomplete');
  }
  if (!hasBalancedDelimiters(claim)) reasons.push('unbalanced_delimiters');
  if (/\b(?:always|never)\b[^.!?]{0,120}\b(?:sometimes|may|might|can)\b/i.test(claim)) {
    reasons.push('internally_contradictory');
  }
  if (detectDeterministicTechnicalIssues(claim).some((issue) => issue.severity === 'error')) {
    reasons.push('factually_unsafe');
  }
  if (!isAlreadySpecificClaim(claim)) reasons.push('not_specific_claim');
  return { usable: reasons.length === 0, reasons: [...new Set(reasons)] };
}

function semanticTokens(value: string): Set<string> {
  return new Set((value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((token) => token.length > 2 && !CLAIM_STOP_WORDS.has(token)));
}

export function evaluateClaimSemanticFidelity(
  selectedClaim: string,
  plannedClaim: string,
  expectedMechanisms: string[] = [],
): ClaimFidelityResult {
  const selected = selectedClaim.trim();
  const planned = plannedClaim.trim();
  const reasons: string[] = [];
  if (!planned || isObviouslyGenericClaim(planned)) reasons.push('planned_claim_is_generic');
  if (selected.toLowerCase() === planned.toLowerCase()) {
    return { faithful: reasons.length === 0, reasons, selectedTokenCoverage: 1 };
  }

  const selectedTokens = semanticTokens(selected);
  const plannedTokens = semanticTokens(planned);
  const shared = [...selectedTokens].filter((token) => plannedTokens.has(token)).length;
  const selectedTokenCoverage = selectedTokens.size ? shared / selectedTokens.size : 0;
  if (selectedTokens.size >= 3 && selectedTokenCoverage < 0.55) reasons.push('different_subject_or_conclusion');

  const mechanismTokens = semanticTokens(expectedMechanisms.join(' '));
  if (mechanismTokens.size) {
    const preservedMechanisms = [...mechanismTokens].filter((token) => plannedTokens.has(token)).length;
    if (preservedMechanisms / mechanismTokens.size < 0.5) reasons.push('different_mechanism');
  }

  const selectedNegates = /\b(?:not|never|cannot|without|instead of|rather than)\b/i.test(selected);
  const plannedNegates = /\b(?:not|never|cannot|without|instead of|rather than)\b/i.test(planned);
  if (selectedNegates !== plannedNegates && selectedTokenCoverage < 0.8) reasons.push('changed_claim_direction');

  return { faithful: reasons.length === 0, reasons, selectedTokenCoverage };
}

export function canLockSelectedClaim(
  claim: string,
  trend?: TrendCandidate | null,
): boolean {
  if (!assessSelectedClaim(claim).usable) return false;
  if (trend?.searchRequired && !trend.summary?.trim() && !(trend.keyPoints?.length) && !trend.link) return false;
  return true;
}

function normalizedTopic(value: string): string {
  const trimmed = (value.trim() || 'the topic').replace(/[.!?]+$/, '');
  const whyMatters = trimmed.match(/^why\s+(.+?)\s+matters(?:\s+for\s+.+)?$/i);
  const normalized = (whyMatters?.[1] ?? trimmed).trim();
  const words = normalized.split(/\s+/).filter(Boolean);
  if (
    words.length > 14
    || /[;:]/.test(normalized)
    || /\b(?:because|when|unless|until|rather than|instead of)\b/i.test(normalized)
  ) return 'the selected approach';
  return normalized;
}

function audienceHint(resolvedAudience?: string[]): string {
  const audience = resolvedAudience?.find((item) => item.trim())?.trim();
  return audience ? ` for ${audience}` : '';
}

export function deriveNarrowCentralClaim(input: {
  topic: string;
  angle?: PostAngle;
  expressionMode?: ExpressionMode;
  author?: AuthorContext;
  resolvedAudience?: string[];
  candidateMechanism?: string | null;
  sourceEvidence?: string | null;
  candidateClaim?: string | null;
}): string {
  const candidate = input.candidateClaim?.trim() ?? '';
  if (assessSelectedClaim(candidate).usable) return candidate;
  if (!candidate && assessSelectedClaim(input.topic).usable) return input.topic.trim();

  const topic = normalizedTopic(input.topic);
  const audience = audienceHint(input.resolvedAudience);
  const mechanism = input.candidateMechanism?.replace(/\s+/g, ' ').trim();
  if (mechanism && assessSelectedClaim(`${topic} changes because ${mechanism}.`).usable) {
    return `${topic} changes because ${mechanism}${audience}.`;
  }
  const evidence = input.sourceEvidence?.replace(/\s+/g, ' ').trim();
  if (evidence) {
    const evidenceSentence = evidence.split(/(?<=[.!?])\s+/)[0]?.replace(/[.!?]+$/, '');
    if (evidenceSentence && assessSelectedClaim(evidenceSentence).usable) return `${evidenceSentence}${audience}.`;
  }
  const mode = input.expressionMode;
  const angle = input.angle;

  if (mode === 'analytical') {
    return `${topic} can create worse outcomes when observable failure conditions are ignored as volume or complexity grows${audience}.`;
  }
  if (mode === 'diagnostic') {
    return `Recurring problems in ${topic} often begin in an earlier decision or workflow condition rather than the visible symptom${audience}.`;
  }
  if (mode === 'opinionated') {
    return `${topic} should be judged by whether it changes the constraint driving the outcome, rather than by how much activity it creates${audience}.`;
  }
  if (mode === 'walkthrough') {
    return `${topic} becomes actionable when each step produces an observable result for the next${audience}.`;
  }
  if (mode === 'reflective') {
    return `Visible progress in ${topic} can hide fragility when the result depends on work or conditions the process does not measure${audience}.`;
  }
  if (mode === 'direct') {
    return `${topic} is useful only when its observable result changes${audience}.`;
  }

  if (angle === 'architecture_tradeoff') {
    return `${topic} becomes a trade-off when improving one visible outcome shifts cost, delay, or complexity to another part of the process${audience}.`;
  }
  if (angle === 'practical_tutorial') {
    return `${topic} becomes usable when every step exposes the result needed by the next${audience}.`;
  }
  if (angle === 'debugging_story') {
    return `A recurring problem with ${topic} often points to an upstream condition or decision, rather than the visible symptom${audience}.`;
  }
  if (angle === 'technical_mistake') {
    return `Treating ${topic} as a standalone task can hide the upstream assumption or process condition causing the recurring problem${audience}.`;
  }
  if (angle === 'defensible_opinion') {
    return `${topic} should be judged by whether it changes the constraint driving the outcome, rather than by how much activity it creates${audience}.`;
  }
  if (angle === 'reflection') {
    return `Visible progress in ${topic} can hide fragility when the result depends on work or conditions the process does not measure${audience}.`;
  }
  return `${topic} becomes more useful when it produces a specific observable effect rather than additional activity${audience}.`;
}
