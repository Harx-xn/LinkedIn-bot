import {
  scoreCandidateAgainstPerformance,
  type AccountPerformanceProfile,
} from './accountPerformanceLearningService';

export type ShareabilityValueType =
  | 'INSIGHT' | 'FRAMEWORK' | 'HOW_TO' | 'REFERENCE' | 'DISTINCTION'
  | 'EXPERIENCE' | 'OPINION' | 'STORY' | 'CURRENT_CONTEXT';

export type ShareabilityPresentation =
  | 'PLAIN_TEXT' | 'COMPACT_TEXT' | 'STRUCTURED_TEXT' | 'FRAMEWORK'
  | 'VISUAL_REFERENCE' | 'CAROUSEL_CANDIDATE';

export type ShareabilityProfile = {
  overallPotential: number;
  saveValue: number;
  sendValue: number;
  repostValue: number;
  referenceValue: number;
  discussionValue: number;
  valueDensity: number;
  valueType: ShareabilityValueType;
  strongestReason?: string;
  improvementOpportunities: string[];
  recommendedPresentation: ShareabilityPresentation;
  presentationGuidance: string;
  artificialTacticPenalty: number;
  accountPreferenceAdjustment: number;
  safetyBoundary: { authorityEligible: boolean; factualSafetyEligible: boolean };
};

export type ShareabilityInput = {
  centralClaim: string;
  mechanism?: string | null;
  audienceConsequence?: string | null;
  ideaFamily?: string | null;
  contentObjective?: string | null;
  supportingText?: string | null;
  personalEvidenceAvailable?: boolean;
  authorityEligible?: boolean;
  factualSafetyEligible?: boolean;
  semanticShareabilityHint?: number;
  performanceProfile?: AccountPerformanceProfile;
};

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : 0)));
const words = (text: string) => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
const count = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].length;

function presentationPerformanceAdjustment(
  presentation: ShareabilityPresentation,
  profile?: AccountPerformanceProfile,
): number {
  if (!profile?.postCount) return 0;
  const features = presentation === 'CAROUSEL_CANDIDATE'
    ? { visualType: 'CAROUSEL', structure: 'FRAMEWORK_EXPLANATION_APPLICATION' }
    : presentation === 'VISUAL_REFERENCE'
      ? { visualType: 'IMAGE' }
      : presentation === 'FRAMEWORK'
        ? { structure: 'FRAMEWORK_EXPLANATION_APPLICATION' }
        : presentation === 'COMPACT_TEXT'
          ? { visualType: 'NONE', structure: 'COMPACT_INSIGHT' }
          : presentation === 'STRUCTURED_TEXT'
            ? { visualType: 'NONE', structure: 'CLAIM_EXPLANATION_IMPLICATION' }
            : { visualType: 'NONE' };
  return scoreCandidateAgainstPerformance(profile, features).adjustment;
}

function guidance(presentation: ShareabilityPresentation, valueType: ShareabilityValueType): string {
  switch (presentation) {
    case 'COMPACT_TEXT': return 'This is one compact insight. Keep it sharp; do not inflate it into a list or framework.';
    case 'STRUCTURED_TEXT': return 'Make the useful distinction or consequence easy to scan without changing the central claim.';
    case 'FRAMEWORK': return 'The idea contains genuinely distinct parts. Make them easy to understand and reference without inventing extra steps.';
    case 'VISUAL_REFERENCE': return 'Make the relationship or model easy to reference; the separate media layer may consider a visual.';
    case 'CAROUSEL_CANDIDATE': return 'The process has genuinely distinct stages. Present them sequentially and do not manufacture additional steps.';
    default: return valueType === 'EXPERIENCE'
      ? 'Let the specific lesson carry the value. Keep the presentation natural and do not dramatize it.'
      : 'Keep the idea natural in plain text; no list, framework, or CTA is required.';
  }
}

/** Evaluates reusable/social value separately from publishability and factual safety. */
export function assessShareability(input: ShareabilityInput): ShareabilityProfile {
  const text = [input.centralClaim, input.mechanism, input.audienceConsequence, input.ideaFamily, input.supportingText]
    .filter(Boolean).join('\n').trim();
  const tokens = words(text);
  const unique = new Set(tokens.filter((token) => token.length > 3));
  const frameworkSignals = count(text, /\b(?:framework|matrix|model|taxonomy|decision tree|heuristic|quadrant|checklist)\b/gi);
  const processSignals = count(text, /\b(?:step|stage|phase|process|workflow|how to|playbook|sequence)\b/gi);
  const distinctionSignals = count(text, /\b(?:rather than|instead of|difference|distinction|not .{0,35} but|versus|vs\.?|trade-?off)\b/gi);
  const mechanismSignals = count(text, /\b(?:because|causes?|leads? to|depends? on|mechanism|when|only if|until|unless)\b/gi);
  const warningSignals = count(text, /\b(?:mistake|failure|risk|warning|harmful|breaks?|cannot|fails?)\b/gi);
  const currentSignals = count(text, /\b(?:recent|new|latest|this week|this month|today|emerging|update)\b/gi);
  const numbered = count(text, /(?:^|\n)\s*\d+[.)]\s+/gm);
  const clickbait = count(text, /\b(?:shocking|secret nobody|you won't believe|guaranteed|must see|game[- ]changer|viral|before it's too late)\b/gi);
  const engagementBait = count(text, /\b(?:save this post|share this with|tag someone|agree\?|thoughts\?|comment below|repost if)\b/gi);
  const repeatedPackaging = numbered >= 3 && unique.size / Math.max(1, tokens.length) < .34;
  const artificialTacticPenalty = Math.min(45, clickbait * 16 + engagementBait * 13 + (repeatedPackaging ? 22 : 0));
  const personal = input.personalEvidenceAvailable === true;
  const objective = (input.contentObjective ?? '').toUpperCase();
  const family = (input.ideaFamily ?? '').toLowerCase();

  let valueType: ShareabilityValueType = 'INSIGHT';
  if (personal) valueType = /story|turning point/i.test(family) ? 'STORY' : 'EXPERIENCE';
  else if (frameworkSignals) valueType = 'FRAMEWORK';
  else if (processSignals) valueType = 'HOW_TO';
  else if (distinctionSignals) valueType = 'DISTINCTION';
  else if (currentSignals) valueType = 'CURRENT_CONTEXT';
  else if (/challenge|opinion|authority/i.test(`${objective} ${family}`)) valueType = 'OPINION';
  else if (/reference/i.test(objective)) valueType = 'REFERENCE';

  const densityBase = tokens.length <= 40
    ? 66 + Math.min(24, (distinctionSignals + mechanismSignals + warningSignals + frameworkSignals) * 7)
    : 62 + Math.min(22, unique.size / Math.max(1, tokens.length) * 40)
      - Math.max(0, tokens.length - 140) * .12;
  const repetitionPenalty = tokens.length > 35 ? Math.max(0, .42 - unique.size / Math.max(1, tokens.length)) * 90 : 0;
  const valueDensity = clamp(densityBase - repetitionPenalty - artificialTacticPenalty * .45);
  const saveValue = clamp(34 + frameworkSignals * 20 + processSignals * 12 + distinctionSignals * 12 + mechanismSignals * 5 + valueDensity * .22 - artificialTacticPenalty);
  const sendValue = clamp(38 + warningSignals * 12 + mechanismSignals * 8 + distinctionSignals * 9 + (input.audienceConsequence ? 10 : 0) + (personal ? 6 : 0) - artificialTacticPenalty);
  const repostValue = clamp(34 + distinctionSignals * 12 + (valueType === 'OPINION' ? 14 : 0) + (personal ? 8 : 0) + valueDensity * .12 - artificialTacticPenalty);
  const referenceValue = clamp(25 + frameworkSignals * 25 + processSignals * 15 + distinctionSignals * 14 + mechanismSignals * 5 - artificialTacticPenalty);
  const naturalDiscussion = distinctionSignals + mechanismSignals + warningSignals + (input.audienceConsequence ? 1 : 0);
  const discussionValue = clamp(32 + naturalDiscussion * 9 - engagementBait * 18 - clickbait * 10);
  const intrinsic = saveValue * .25 + sendValue * .22 + repostValue * .14 + referenceValue * .23 + discussionValue * .08 + valueDensity * .08;
  const semanticHint = input.semanticShareabilityHint == null ? 0 : (clamp(input.semanticShareabilityHint) - 50) * .08;
  const overallPotential = clamp(intrinsic + semanticHint - artificialTacticPenalty * .2);

  // Keywords describe the idea; only explicit distinct items or repeated stage
  // descriptions indicate that sequential packaging is actually warranted.
  const genuineParts = numbered || processSignals;
  let recommendedPresentation: ShareabilityPresentation;
  if ((numbered >= 5 || processSignals >= 5) && !repeatedPackaging) recommendedPresentation = 'CAROUSEL_CANDIDATE';
  else if (frameworkSignals && genuineParts >= 2) recommendedPresentation = 'FRAMEWORK';
  else if (mechanismSignals >= 2 && referenceValue >= 65) recommendedPresentation = 'VISUAL_REFERENCE';
  else if (tokens.length <= 42 && (valueType === 'INSIGHT' || valueType === 'DISTINCTION' || valueType === 'OPINION')) recommendedPresentation = 'COMPACT_TEXT';
  else if (valueType === 'EXPERIENCE' || valueType === 'STORY') recommendedPresentation = 'PLAIN_TEXT';
  else if (overallPotential >= 62) recommendedPresentation = 'STRUCTURED_TEXT';
  else recommendedPresentation = 'PLAIN_TEXT';

  const accountPreferenceAdjustment = presentationPerformanceAdjustment(recommendedPresentation, input.performanceProfile);
  const opportunities: string[] = [];
  if (valueDensity < 55) opportunities.push('Remove repetition and keep only information that changes reader understanding.');
  if (repeatedPackaging) opportunities.push('Remove artificial numbering; present the single insight as one coherent argument.');
  if (clickbait) opportunities.push('Replace sensational framing with a concrete, defensible value promise.');
  if (engagementBait) opportunities.push('Remove engagement bait; let a substantive tension create discussion naturally.');
  if (overallPotential < 55 && mechanismSignals === 0) opportunities.push('Clarify why the claim happens or what decision it changes, without adding a new claim.');

  const strongestReason = referenceValue >= Math.max(saveValue, sendValue, repostValue, discussionValue)
    ? 'The idea offers something readers can reuse or reference.'
    : saveValue >= Math.max(sendValue, repostValue, discussionValue)
      ? 'The idea contains practical value worth returning to.'
      : sendValue >= Math.max(repostValue, discussionValue)
        ? 'The idea can help someone explain a relevant problem to another person.'
        : repostValue >= discussionValue
          ? 'The idea expresses a useful professional viewpoint.'
          : 'The idea creates a substantive tension worth discussing.';

  return {
    overallPotential, saveValue, sendValue, repostValue, referenceValue, discussionValue,
    valueDensity, valueType, strongestReason, improvementOpportunities: opportunities,
    recommendedPresentation,
    presentationGuidance: guidance(recommendedPresentation, valueType),
    artificialTacticPenalty,
    accountPreferenceAdjustment,
    safetyBoundary: {
      authorityEligible: input.authorityEligible !== false,
      factualSafetyEligible: input.factualSafetyEligible !== false,
    },
  };
}

export function inferActualShareabilityPresentation(input: {
  content: string;
  structure?: string | null;
  visualType?: string | null;
}): ShareabilityPresentation {
  const visual = (input.visualType ?? '').toUpperCase();
  const structure = (input.structure ?? '').toUpperCase();
  if (visual === 'CAROUSEL') return 'CAROUSEL_CANDIDATE';
  if (visual && visual !== 'NONE') return 'VISUAL_REFERENCE';
  if (/FRAMEWORK|WALKTHROUGH|PRACTICAL_SEQUENCE/.test(structure)) return 'FRAMEWORK';
  if (input.content.length < 700) return 'COMPACT_TEXT';
  if (input.content.split(/\n\s*\n/).filter(Boolean).length >= 3) return 'STRUCTURED_TEXT';
  return 'PLAIN_TEXT';
}
