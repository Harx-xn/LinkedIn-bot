import type { AuthorContext, ExpressionMode, PostAngle } from './generationTypes';

const GENERIC_CLAIM_PATTERNS = [
  /\b(?:is|are) (?:very )?(?:important|essential|critical|key|valuable)\b/i,
  /\bplays? (?:a )?(?:critical|key|important) role\b/i,
  /\b(?:improves?|enhances?|boosts?) (?:performance|efficiency|productivity|customer experience)\b/i,
  /\b(?:drives?|supports?) (?:success|growth|better outcomes|long[- ]term success)\b/i,
  /\bhelps? (?:businesses|teams|organizations|people) (?:grow|succeed|improve)\b/i,
  /\b(?:reduces? risk|increases? efficiency|should be prioritized)\b/i,
  /\b(?:strong foundation|game[- ]changer|clear takeaway|practical,? focused perspective)\b/i,
];

const CLAIM_RELATIONSHIP = /\b(?:because|when|whenever|if|unless|while|before|after|rather than|instead of|depends? on|leads? to|causes?|prevents?|hides?|reveals?|lowers?|raises?|increases?|reduces?|becomes?|fails?|works? only|matters? most)\b|\b(?:is|are)\s+not\b[^.!?]{0,160}(?:\bbut\b|[.!?]\s*(?:it|they|this)\s+(?:is|are)\b)/i;

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

function normalizedTopic(value: string): string {
  const trimmed = (value.trim() || 'the topic').replace(/[.!?]+$/, '');
  const whyMatters = trimmed.match(/^why\s+(.+?)\s+matters(?:\s+for\s+.+)?$/i);
  return (whyMatters?.[1] ?? trimmed).trim();
}

function audienceHint(author?: AuthorContext): string {
  const audience = author?.targetAudience?.find((item) => item.trim())?.trim();
  return audience ? ` for ${audience}` : '';
}

export function deriveNarrowCentralClaim(input: {
  topic: string;
  angle?: PostAngle;
  expressionMode?: ExpressionMode;
  author?: AuthorContext;
  candidateClaim?: string | null;
}): string {
  const candidate = input.candidateClaim?.trim() ?? '';
  if (isAlreadySpecificClaim(candidate)) return candidate;
  if (!candidate && isAlreadySpecificClaim(input.topic)) return input.topic.trim();

  const topic = normalizedTopic(input.topic);
  const audience = audienceHint(input.author);
  const mode = input.expressionMode;
  const angle = input.angle;

  if (mode === 'analytical') {
    return `${topic} can create worse outcomes when its underlying decision criteria stay unchanged as volume or complexity grows${audience}.`;
  }
  if (mode === 'diagnostic') {
    return `Recurring problems in ${topic} often begin in an earlier decision or workflow condition rather than the visible symptom${audience}.`;
  }
  if (mode === 'opinionated') {
    return `${topic} should be judged by whether it changes the constraint driving the outcome, rather than by how much activity it creates${audience}.`;
  }
  if (mode === 'walkthrough') {
    return `${topic} works more reliably when the process starts with the decision or constraint that determines whether later steps can succeed${audience}.`;
  }
  if (mode === 'reflective') {
    return `Visible progress in ${topic} can hide fragility when the result depends on work or conditions the process does not measure${audience}.`;
  }
  if (mode === 'direct') {
    return `${topic} can fail to improve outcomes when visible activity changes but the underlying constraint does not${audience}.`;
  }

  if (angle === 'architecture_tradeoff') {
    return `${topic} becomes a trade-off when improving one visible outcome shifts cost, delay, or complexity to another part of the process${audience}.`;
  }
  if (angle === 'practical_tutorial') {
    return `${topic} works more reliably when the process starts with the decision or constraint that determines whether the later steps can succeed${audience}.`;
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
  return `${topic} becomes more useful when it changes a specific decision or constraint, rather than adding activity without changing the outcome${audience}.`;
}
