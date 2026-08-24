import { normalizeTrendTitle } from './trendTitleUtils';

export type FinalPostFingerprintClassification = {
  hookType: string;
  argumentPattern: string;
  structure: string;
  endingType: string;
  ctaType: string;
  mechanism: string | null;
  perspective: string;
  ideaFamily: string;
  contentIntent: string;
  authorityMode: string;
};

function paragraphs(body: string): string[] {
  return body.split(/\n\s*\n+/).map((part) => part.trim()).filter(Boolean);
}

function sentences(body: string): string[] {
  return body.replace(/\n+/g, ' ').split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);
}

export function classifyHookType(body: string): string {
  const first = paragraphs(body)[0] ?? body.trim();
  if (/^\s*(?:[-*•]|\d+[.)])\s+/.test(first)) return 'LIST_OPENING';
  if (/\?$/.test(first)) return 'QUESTION_HOOK';
  if (/^\s*(?:\d+(?:\.\d+)?%?|one in \d+|most|few)\b/i.test(first)) return 'DATA_OR_QUANTIFIED_HOOK';
  if (/\b(?:not .{0,35} but|myth|contrary|instead|looks? .{0,25} until|the opposite)\b/i.test(first)) return 'CONTRARIAN_OR_TENSION_HOOK';
  if (/\b(?:fails?|breaks?|stalls?|problem|mistake|risk|bottleneck|warning sign)\b/i.test(first)) return 'PROBLEM_SIGNAL_HOOK';
  if (/\b(?:I|we|my|our)\b/.test(first)) return 'PERSONAL_OBSERVATION_HOOK';
  if (/\b(?:when|often|usually|sometimes|teams|people|clients|patients|leaders)\b/i.test(first)) return 'OBSERVATION_HOOK';
  return 'DIRECT_CLAIM_HOOK';
}

export function classifyEnding(body: string): { endingType: string; ctaType: string } {
  const ending = paragraphs(body).at(-1) ?? body.trim();
  if (/\b(?:contact|message|dm|book|schedule|download|subscribe|learn more|link in)\b/i.test(ending)) {
    return { endingType: 'PROMOTIONAL_CLOSE', ctaType: 'RESOURCE_OR_CONTACT_CTA' };
  }
  if (/\?$/.test(ending)) {
    if (/\b(?:what|which|how|where)\b/i.test(ending)) return { endingType: 'DISCUSSION_QUESTION', ctaType: 'DISCUSSION_CTA' };
    return { endingType: 'REFLECTIVE_QUESTION', ctaType: 'REFLECTION_CTA' };
  }
  if (/^(?:try|start|use|check|review|ask|name|map|remove|choose|write|measure)\b/i.test(ending)) {
    return { endingType: 'ACTION_CLOSE', ctaType: 'ACTION_CTA' };
  }
  if (/\b(?:the point|the takeaway|this means|which means|that is why|so the real|ultimately)\b/i.test(ending)) {
    return { endingType: 'SYNTHESIS_CLOSE', ctaType: 'TAKEAWAY_CLOSE' };
  }
  if (/\b(?:avoid|never|risk|warning|do not|don't)\b/i.test(ending)) {
    return { endingType: 'CAUTION_CLOSE', ctaType: 'CAUTION_CLOSE' };
  }
  if (/\b(?:worth|changes how|reveals|reminder|less about|more about)\b/i.test(ending)) {
    return { endingType: 'REFLECTIVE_CLOSE', ctaType: 'REFLECTIVE_CLOSE' };
  }
  return { endingType: 'NATURAL_RESOLUTION', ctaType: 'NO_EXPLICIT_CTA' };
}

export function extractFinalMechanism(body: string, plannedMechanism?: string | null): string | null {
  const causal = sentences(body).filter((sentence) => /\b(?:because|when|by|through|due to|causes?|leads? to|depends? on|rather than|instead of|prevents?|removes?|creates?)\b/i.test(sentence));
  const selected = causal.sort((a, b) => b.length - a.length)[0];
  if (selected) return normalizeTrendTitle(selected).split(/\s+/).slice(0, 18).join(' ') || null;
  const planned = normalizeTrendTitle(plannedMechanism ?? '');
  if (planned && normalizeTrendTitle(body).includes(planned)) return planned;
  return null;
}

export function classifyFinalPostFingerprint(
  body: string,
  context: { plannedMechanism?: string | null; plannedIdeaFamily?: string | null; sourcePresent?: boolean } = {},
): FinalPostFingerprintClassification {
  const parts = paragraphs(body);
  const text = body.toLowerCase();
  const enumerated = body.split('\n').filter((line) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(line)).length;
  const hasCause = /\b(?:because|cause|underlying|due to|mechanism|when)\b/i.test(body);
  const hasConsequence = /\b(?:therefore|so |which means|leads? to|result|consequence|cost|risk)\b/i.test(body);
  const hasContrast = /\b(?:but|however|instead|rather than|trade-off|on the other hand)\b/i.test(body);
  const hasQualification = /\b(?:unless|depends|only when|may|can|in some|not always)\b/i.test(body);
  const argumentPattern = enumerated >= 3
    ? 'PRACTICAL_SEQUENCE'
    : hasContrast && hasQualification
      ? 'CLAIM_TRADEOFF_QUALIFICATION'
      : hasCause && hasConsequence
        ? 'CLAIM_MECHANISM_CONSEQUENCE'
        : hasCause
          ? 'OBSERVATION_CAUSAL_EXPLANATION'
          : hasContrast
            ? 'CONTRAST_REFRAME'
            : 'CLAIM_SUPPORT_RESOLUTION';
  const structure = enumerated >= 3
    ? 'LIST_OR_WALKTHROUGH'
    : parts.length <= 2
      ? 'COMPACT_ARGUMENT'
      : hasContrast
        ? 'MULTI_PARAGRAPH_CONTRAST'
        : 'MULTI_PARAGRAPH_PROGRESSION';
  const ending = classifyEnding(body);
  const perspective = /\b(?:I|we|my|our)\b/.test(body)
    ? 'FIRST_PERSON_PRACTITIONER'
    : /\b(?:you|your)\b/i.test(body)
      ? 'AUDIENCE_DIRECT'
      : hasContrast
        ? 'COUNTERPOINT_OR_TRADEOFF'
        : /\b(?:symptom|signal|diagnos|reveals?|indicates?)\b/i.test(body)
          ? 'DIAGNOSTIC'
          : 'EXPLANATORY';
  const contentIntent = enumerated >= 3
    ? 'GUIDE_IMPLEMENTATION'
    : /\b(?:mistake|avoid|warning|risk)\b/i.test(body)
      ? 'PREVENT_ERROR'
      : hasContrast
        ? 'REFRAME_DECISION'
        : hasCause
          ? 'EXPLAIN_MECHANISM'
          : 'SHARE_INSIGHT';
  const inferredFamily = argumentPattern === 'CLAIM_TRADEOFF_QUALIFICATION'
    ? 'TRADE_OFF'
    : argumentPattern === 'CONTRAST_REFRAME'
      ? 'REFRAME'
      : argumentPattern === 'PRACTICAL_SEQUENCE'
        ? 'IMPLEMENTATION_LESSON'
        : argumentPattern === 'CLAIM_MECHANISM_CONSEQUENCE'
          ? 'MECHANISM_AND_CONSEQUENCE'
          : 'FOCUSED_OBSERVATION';

  return {
    hookType: classifyHookType(body),
    argumentPattern,
    structure,
    ...ending,
    mechanism: extractFinalMechanism(body, context.plannedMechanism),
    perspective,
    ideaFamily: inferredFamily || context.plannedIdeaFamily || 'FOCUSED_OBSERVATION',
    contentIntent,
    authorityMode: /\b(?:I|we|my|our)\b/.test(body)
      ? 'FIRST_PERSON_PRACTITIONER'
      : context.sourcePresent
        ? 'SOURCE_GROUNDED'
        : /\b(?:hypothetical|imagine|suppose|consider a scenario)\b/i.test(body)
          ? 'HYPOTHETICAL_REASONING'
          : 'GENERAL_REASONING',
  };
}
