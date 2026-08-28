import { normalizeTrendTitle } from './trendTitleUtils';
import { classifyConceptualMotif } from './conceptualMotifService';

export type FinalPostFingerprintClassification = {
  hookType: string;
  argumentPattern: string;
  structure: string;
  endingType: string;
  endingIntent: 'CONCLUSION' | 'INSIGHT' | 'PREDICTION' | 'OBSERVATION' | 'CHALLENGE' | 'QUESTION' | 'PERSONAL_NOTE' | 'SOFT_CTA' | 'NO_CTA';
  ctaType: string;
  mechanism: string | null;
  perspective: string;
  ideaFamily: string;
  contentIntent: string;
  authorityMode: string;
  conceptualMotif: string | null;
  reasoningArchetype: string | null;
  openingSyntax: OpeningSyntax;
  rhetoricalMove: OpeningRhetoricalMove;
  openingBehavior: string;
  secondLineTransition: string;
  transitionPattern: string;
};

export type OpeningSyntax = 'QUESTION' | 'CONDITIONAL' | 'CONTRAST' | 'CONSEQUENCE_FIRST' | 'MECHANISM_FIRST' | 'DATA_FIRST' | 'DIRECT_INSTRUCTION' | 'SCENARIO' | 'DIRECT_DECLARATIVE';
export type OpeningRhetoricalMove = 'MISCONCEPTION_CORRECTION' | 'DIAGNOSTIC' | 'TRADE_OFF' | 'COMPARISON' | 'CAUSAL_EXPLANATION' | 'DECISION_RULE' | 'WARNING' | 'PATTERN_RECOGNITION' | 'PRACTICAL_OBSERVATION' | 'GENERIC_SETUP';

export type OpeningFormFingerprint = {
  syntax: OpeningSyntax;
  rhetoricalMove: OpeningRhetoricalMove;
  behavior: string;
  secondLineTransition: string;
  transitionPattern: string;
  substantive: boolean;
  genericCategorySetup: boolean;
  obviousQuestionAnswer: boolean;
};

function paragraphs(body: string): string[] {
  return body.split(/\n\s*\n+/).map((part) => part.trim()).filter(Boolean);
}

function sentences(body: string): string[] {
  return body.replace(/\n+/g, ' ').split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);
}

export function classifyOpeningForm(body: string): OpeningFormFingerprint {
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const first = lines[0] ?? '';
  const second = lines[1] ?? '';
  const firstNormalized = normalizeTrendTitle(first);
  const genericCategorySetup = /^(?:in|within) (?:the )?(?:realm|field|world|space) of\b|^(?:in|within) [a-z][a-z -]{2,45}(?:development|automation|engineering|marketing|security)\b|^when (?:discussing|talking about|it comes to)\b|^for [a-z][a-z -]{1,35}(?:developers?|teams?|leaders?|professionals?|operators?)\b/i.test(first)
    && !/\b(?:because|but|until|unless|without|fails?|breaks?|prevents?|causes?|reduces?|increases?|means|only when|depends? on|cost|risk|bottleneck|threshold)\b/i.test(first);
  const obviousQuestionAnswer = /\?\s*(?:the answer is\b|yes(?:\b|[,!.])|no(?:\b|[,!.])|of course\b)/i.test(`${first} ${second}`);
  const syntax: OpeningSyntax = /\?$/.test(first) ? 'QUESTION'
    : /^(?:if|when|unless|once)\b/i.test(first) ? 'CONDITIONAL'
      : /^(?:but|yet|however|instead|rather than|unlike|while)\b/i.test(first) || /\b(?:not .{0,35} but|rather than|versus)\b/i.test(first) ? 'CONTRAST'
        : /^(?:the (?:cost|risk|result|consequence)|[a-z -]+ (?:costs?|delays?|prevents?|reduces?|increases?))\b/i.test(first) ? 'CONSEQUENCE_FIRST'
          : /^(?:because|through|by )\b/i.test(first) || /\b(?:causes?|drives?|prevents?|invalidates?|moves? the bottleneck)\b/i.test(first) ? 'MECHANISM_FIRST'
            : /^\d+(?:\.\d+)?%?\b/i.test(first) ? 'DATA_FIRST'
              : /^(?:use|choose|check|measure|compare|instrument|remove|map|test|validate|start|stop)\b/i.test(first) ? 'DIRECT_INSTRUCTION'
                : /^(?:imagine|suppose|consider)\b/i.test(first) ? 'SCENARIO' : 'DIRECT_DECLARATIVE';
  const rhetoricalMove: OpeningRhetoricalMove = /\b(?:common|prevalent|critical) (?:mistake|misconception)|many .{0,25} assume|myth\b/i.test(first) ? 'MISCONCEPTION_CORRECTION'
    : /\b(?:symptom|diagnos|signal|reveals?|root cause|failure mode)\b/i.test(first) ? 'DIAGNOSTIC'
      : /\b(?:trade-?off|at the cost of|versus|rather than|while .{0,45} but)\b/i.test(first) ? 'TRADE_OFF'
        : /\b(?:compare|compared|difference between|versus|unlike)\b/i.test(first) ? 'COMPARISON'
          : /\b(?:because|causes?|drives?|prevents?|through|by )\b/i.test(first) ? 'CAUSAL_EXPLANATION'
            : /\b(?:only when|unless|threshold|choose|decision rule)\b/i.test(first) ? 'DECISION_RULE'
              : /\b(?:warning|risk|fails?|breaks?|cannot|can't)\b/i.test(first) ? 'WARNING'
                : /\b(?:pattern|often|tends? to|keeps? recurring)\b/i.test(first) ? 'PATTERN_RECOGNITION'
                  : genericCategorySetup ? 'GENERIC_SETUP' : 'PRACTICAL_OBSERVATION';
  const secondLineTransition = !second ? 'NONE'
    : /^(?:however|moreover|additionally|ultimately|therefore|in summary)\b/i.test(second) ? 'GENERIC_CONNECTOR'
      : /\b(?:because|through|by |causes?|prevents?)\b/i.test(second) ? 'MECHANISM'
        : /\b(?:but|instead|rather|unless|while)\b/i.test(second) ? 'CONTRAST'
          : firstNormalized && normalizeTrendTitle(second) === firstNormalized ? 'RESTATEMENT' : 'DEEPENING';
  const transitionPattern = [...body.matchAll(/(?:^|\n\s*\n)(however|moreover|additionally|ultimately|therefore|in summary)\b/gi)]
    .map((match) => match[1].toLowerCase()).join('>') || 'IMPLICIT';
  const substantive = !genericCategorySetup && !obviousQuestionAnswer && (
    /\b(?:because|but|until|unless|without|fails?|breaks?|prevents?|causes?|reduces?|increases?|means|only when|depends? on|cost|risk|bottleneck|threshold|\d+(?:\.\d+)?%?)\b/i.test(first)
    || first.split(/\s+/).length >= 8
  );
  return { syntax, rhetoricalMove, behavior: genericCategorySetup ? 'GENERIC_CATEGORY_SETUP' : obviousQuestionAnswer ? 'OBVIOUS_QUESTION_ANSWER' : 'SUBSTANTIVE_MOVE', secondLineTransition, transitionPattern, substantive, genericCategorySetup, obviousQuestionAnswer };
}

export function classifyHookType(body: string): string {
  const first = paragraphs(body)[0] ?? body.trim();
  const opening = classifyOpeningForm(body);
  if (opening.rhetoricalMove === 'MISCONCEPTION_CORRECTION') return 'MISCONCEPTION_CORRECTION_HOOK';
  if (opening.genericCategorySetup) return 'GENERIC_CATEGORY_SETUP_HOOK';
  if (/^\s*(?:[-*•]|\d+[.)])\s+/.test(first)) return 'LIST_OPENING';
  if (/\?$/.test(first)) return 'QUESTION_HOOK';
  if (/^\s*(?:\d+(?:\.\d+)?%?|one in \d+|most|few)\b/i.test(first)) return 'DATA_OR_QUANTIFIED_HOOK';
  if (/\b(?:not .{0,35} but|myth|contrary|instead|looks? .{0,25} until|the opposite)\b/i.test(first)) return 'CONTRARIAN_OR_TENSION_HOOK';
  if (/\b(?:fails?|breaks?|stalls?|problem|mistake|risk|bottleneck|warning sign)\b/i.test(first)) return 'PROBLEM_SIGNAL_HOOK';
  if (/\b(?:I|we|my|our)\b/.test(first)) return 'PERSONAL_OBSERVATION_HOOK';
  if (/\b(?:when|often|usually|sometimes|teams|people|clients|patients|leaders)\b/i.test(first)) return 'OBSERVATION_HOOK';
  return 'DIRECT_CLAIM_HOOK';
}

export function classifyEnding(body: string): Pick<FinalPostFingerprintClassification, 'endingType' | 'endingIntent' | 'ctaType'> {
  const ending = paragraphs(body).at(-1) ?? body.trim();
  if (/\b(?:contact|message|dm|book|schedule|download|subscribe|learn more|link in)\b/i.test(ending)) {
    return { endingType: 'PROMOTIONAL_CLOSE', endingIntent: 'SOFT_CTA', ctaType: 'RESOURCE_OR_CONTACT_CTA' };
  }
  if (/\?$/.test(ending)) {
    if (/\b(?:what|which|how|where)\b/i.test(ending)) return { endingType: 'DISCUSSION_QUESTION', endingIntent: 'QUESTION', ctaType: 'DISCUSSION_CTA' };
    return { endingType: 'REFLECTIVE_QUESTION', endingIntent: 'QUESTION', ctaType: 'REFLECTION_CTA' };
  }
  if (/^(?:try|start|use|check|review|ask|name|map|remove|choose|write|measure)\b/i.test(ending)) {
    return { endingType: 'ACTION_CLOSE', endingIntent: 'SOFT_CTA', ctaType: 'ACTION_CTA' };
  }
  if (/\b(?:the point|the takeaway|this means|which means|that is why|so the real|ultimately)\b/i.test(ending)) {
    return { endingType: 'SYNTHESIS_CLOSE', endingIntent: 'CONCLUSION', ctaType: 'TAKEAWAY_CLOSE' };
  }
  if (/\b(?:avoid|never|risk|warning|do not|don't)\b/i.test(ending)) {
    return { endingType: 'CAUTION_CLOSE', endingIntent: 'CHALLENGE', ctaType: 'CAUTION_CLOSE' };
  }
  if (/\b(?:worth|changes how|reveals|reminder|less about|more about)\b/i.test(ending)) {
    return { endingType: 'REFLECTIVE_CLOSE', endingIntent: 'INSIGHT', ctaType: 'REFLECTIVE_CLOSE' };
  }
  if (/\b(?:will|likely|next|future|expect|is moving toward)\b/i.test(ending)) {
    return { endingType: 'PREDICTION_CLOSE', endingIntent: 'PREDICTION', ctaType: 'NO_EXPLICIT_CTA' };
  }
  if (/\b(?:I|we|my|our)\b/.test(ending)) {
    return { endingType: 'PERSONAL_NOTE_CLOSE', endingIntent: 'PERSONAL_NOTE', ctaType: 'NO_EXPLICIT_CTA' };
  }
  if (/\b(?:notice|observe|signal|pattern|tends? to|often)\b/i.test(ending)) {
    return { endingType: 'OBSERVATION_CLOSE', endingIntent: 'OBSERVATION', ctaType: 'NO_EXPLICIT_CTA' };
  }
  return { endingType: 'NATURAL_RESOLUTION', endingIntent: 'NO_CTA', ctaType: 'NO_EXPLICIT_CTA' };
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
  const motif = classifyConceptualMotif({
    claim: body,
    mechanism: extractFinalMechanism(body, context.plannedMechanism),
    perspective,
    ideaFamily: inferredFamily || context.plannedIdeaFamily,
  });
  const opening = classifyOpeningForm(body);

  return {
    hookType: classifyHookType(body),
    argumentPattern,
    structure,
    ...ending,
    mechanism: extractFinalMechanism(body, context.plannedMechanism),
    perspective,
    ideaFamily: inferredFamily || context.plannedIdeaFamily || 'FOCUSED_OBSERVATION',
    contentIntent,
    ...motif,
    openingSyntax: opening.syntax,
    rhetoricalMove: opening.rhetoricalMove,
    openingBehavior: opening.behavior,
    secondLineTransition: opening.secondLineTransition,
    transitionPattern: opening.transitionPattern,
    authorityMode: /\b(?:I|we|my|our)\b/.test(body)
      ? 'FIRST_PERSON_PRACTITIONER'
      : context.sourcePresent
        ? 'SOURCE_GROUNDED'
        : /\b(?:hypothetical|imagine|suppose|consider a scenario)\b/i.test(body)
          ? 'HYPOTHETICAL_REASONING'
          : 'GENERAL_REASONING',
  };
}
