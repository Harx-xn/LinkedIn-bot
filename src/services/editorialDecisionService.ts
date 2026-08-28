import type {
  ContentObjective,
  ConversionObjective,
  EditorialDecision,
  EditorialEndingIntent,
  EditorialHookFamily,
  ExpressionMode,
  HookStyle,
  PostAngle,
  PostLayout,
  QualityIssue,
  ReferenceValueForm,
  RhetoricalStructure,
  TrendCandidate,
} from './generationTypes';
import type { RecentContentMemory } from './recentContentMemoryService';
import { normalizeTrendTitle } from './trendTitleUtils';
import { jaccardSimilarity } from './ghostwriterTextUtils';
import {
  scoreCandidateAgainstPerformance,
  type AccountPerformanceProfile,
} from './accountPerformanceLearningService';
import {
  assessShareability,
  type ShareabilityProfile,
} from './shareabilityIntelligenceService';
import { classifyOpeningForm } from './finalPostFingerprintClassifier';

export type EditorialDecisionContext = {
  recentMemory?: RecentContentMemory;
  currentBatch?: EditorialDecision[];
  personalEvidenceAvailable?: boolean;
  primaryGoal?: string | null;
  audience?: string[];
  performanceProfile?: AccountPerformanceProfile;
};

const TEXT_SIGNALS = {
  mistake: /\b(mistake|wrong|fails?|failure|risk|harmful|breaks?|misconception|warning)\b/i,
  comparison: /\b(vs\.?|versus|compare|comparison|trade[- ]?off|rather than|instead of|difference between)\b/i,
  challenge: /\b(myth|counterintuitive|contrary|not .{0,40} but|looks? .{0,35} until|assumption|overrated|underrated)\b/i,
  question: /\?\s*$/,
  process: /\b(how to|steps?|process|workflow|framework|method|playbook|checklist|decision rule)\b/i,
  mechanism: /\b(because|mechanism|causes?|leads? to|depends? on|through|by |when |why )\b/i,
  prediction: /\b(will|likely|next|future|emerging|trend)\b/i,
  quantified: /\b\d+(?:\.\d+)?%?\b/,
};

function candidateText(trend: TrendCandidate | null): string {
  if (!trend) return '';
  return [
    trend.topic,
    trend.summary,
    trend.suggestedAngle,
    trend.ideaFamily,
    trend.audienceConsequence,
    trend.discoveryIntent,
    ...(trend.fingerprint?.mechanisms ?? []),
  ].filter(Boolean).join(' ');
}

function inferObjective(trend: TrendCandidate | null, context: EditorialDecisionContext): ContentObjective {
  const text = candidateText(trend);
  if (context.personalEvidenceAvailable && trend?.personalEvidencePotential === 'STRONGLY_BENEFICIAL') return 'SHOW_EXPERIENCE';
  if (TEXT_SIGNALS.challenge.test(text) || trend?.discoveryIntent === 'misconception') return 'CHALLENGE_ASSUMPTION';
  if (TEXT_SIGNALS.process.test(text) || /\b(reference|heuristic|framework|decision)\b/i.test(trend?.ideaFamily ?? '')) {
    return 'CREATE_REFERENCE_VALUE';
  }
  if (trend?.discoveryIntent === 'audience_question' || trend?.contentType === 'community_discussion') return 'CREATE_DISCUSSION';
  if (/\btrust|uncertainty|confidence|relationship|credib/i.test(text)) return 'BUILD_TRUST';
  if (/\b(profile|visibility|positioning|demand|lead)\b/i.test(context.primaryGoal ?? '')) return 'GENERATE_PROFILE_INTEREST';
  if (TEXT_SIGNALS.mechanism.test(text) || trend?.fingerprint?.mechanisms.length) return 'TEACH';
  return 'BUILD_AUTHORITY';
}

function inferConversionObjective(objective: ContentObjective, primaryGoal?: string | null): ConversionObjective {
  const goal = (primaryGoal ?? '').toLowerCase();
  if (/\bcomment|discussion|community\b/.test(goal) && objective === 'CREATE_DISCUSSION') return 'COMMENT';
  if (objective !== 'GENERATE_PROFILE_INTEREST') return 'NONE';
  if (/\bwebsite|traffic|site\b/.test(goal)) return 'WEBSITE';
  if (/\bdm|message|inbound|lead\b/.test(goal)) return 'DM';
  if (/\bprofile\b/.test(goal)) return 'PROFILE_VISIT';
  if (/\bfollow|audience growth\b/.test(goal)) return 'FOLLOW';
  return 'NONE';
}

function hookMemoryCount(family: EditorialHookFamily, memory?: RecentContentMemory): number {
  if (!memory) return 0;
  const aliases: Record<EditorialHookFamily, string[]> = {
    FIRST_PERSON_LESSON: ['first person lesson', 'personal observation hook'],
    OBSERVATION: ['observation', 'observation hook'],
    CONTRARIAN_CLAIM: ['contrarian claim', 'contrarian or tension hook'],
    SPECIFIC_RESULT: ['specific result', 'data or quantified hook'],
    MISTAKE: ['mistake', 'problem signal hook'],
    COMPARISON: ['comparison', 'contrarian or tension hook'],
    QUESTION: ['question', 'question hook'],
    STORY_OPENING: ['story opening', 'personal observation hook'],
    DIRECT_VALUE_PROMISE: ['direct value promise', 'direct claim hook'],
  };
  return aliases[family].reduce((sum, alias) => sum + (memory.recentHooks.get(normalizeTrendTitle(alias)) ?? 0), 0);
}

function chooseHook(
  trend: TrendCandidate | null,
  objective: ContentObjective,
  context: EditorialDecisionContext,
): EditorialHookFamily {
  const text = candidateText(trend);
  const scores = new Map<EditorialHookFamily, number>([
    ['OBSERVATION', 45],
    ['DIRECT_VALUE_PROMISE', 28],
    ['CONTRARIAN_CLAIM', 18],
    ['MISTAKE', 18],
    ['COMPARISON', 16],
    ['QUESTION', 8],
    ['SPECIFIC_RESULT', 4],
    ['FIRST_PERSON_LESSON', -100],
    ['STORY_OPENING', -100],
  ]);
  const add = (family: EditorialHookFamily, amount: number) => scores.set(family, (scores.get(family) ?? 0) + amount);

  if (TEXT_SIGNALS.challenge.test(text) || objective === 'CHALLENGE_ASSUMPTION') add('CONTRARIAN_CLAIM', 55);
  if (TEXT_SIGNALS.mistake.test(text)) add('MISTAKE', 52);
  if (TEXT_SIGNALS.comparison.test(text)) add('COMPARISON', 55);
  if (TEXT_SIGNALS.question.test((trend?.topic ?? '').trim()) || objective === 'CREATE_DISCUSSION') add('QUESTION', 32);
  if (objective === 'CREATE_REFERENCE_VALUE' || objective === 'TEACH') add('DIRECT_VALUE_PROMISE', 28);
  if (TEXT_SIGNALS.quantified.test(text) && (trend?.supportingSources?.length ?? 0) > 0) add('SPECIFIC_RESULT', 44);
  if (context.personalEvidenceAvailable) {
    scores.set('FIRST_PERSON_LESSON', objective === 'SHOW_EXPERIENCE' ? 78 : 34);
    scores.set('STORY_OPENING', objective === 'SHOW_EXPERIENCE' ? 68 : 26);
  }

  for (const family of scores.keys()) {
    const currentCount = (context.currentBatch ?? []).filter((item) => item.hookFamily === family).length;
    add(family, -(hookMemoryCount(family, context.recentMemory) * 7 + currentCount * 20));
    add(family, scoreCandidateAgainstPerformance(context.performanceProfile, { hookFamily: family }).adjustment);
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

function structureMemoryCount(structure: RhetoricalStructure, memory?: RecentContentMemory): number {
  if (!memory) return 0;
  const aliases: Record<RhetoricalStructure, string[]> = {
    CLAIM_EXPLANATION_IMPLICATION: ['claim explanation implication', 'claim support resolution'],
    STORY_TURNING_POINT_LESSON: ['story turning point lesson', 'multi paragraph progression'],
    OBSERVATION_MECHANISM_CONSEQUENCE: ['observation mechanism consequence', 'claim mechanism consequence', 'observation causal explanation'],
    MISTAKE_CAUSE_CORRECTION: ['mistake cause correction', 'claim mechanism consequence'],
    COMPARISON_DISTINCTION_DECISION: ['comparison distinction decision', 'multi paragraph contrast', 'contrast reframe'],
    QUESTION_ANSWER_TAKEAWAY: ['question answer takeaway', 'claim support resolution'],
    FRAMEWORK_EXPLANATION_APPLICATION: ['framework explanation application', 'list or walkthrough', 'practical sequence'],
    COMPACT_INSIGHT: ['compact insight', 'compact argument'],
  };
  return aliases[structure].reduce((sum, alias) => {
    const normalized = normalizeTrendTitle(alias);
    const direct = memory.recentArgumentPatterns.get(normalized) ?? 0;
    const fingerprintCount = memory.fingerprints.filter((item) => normalizeTrendTitle(item.structure ?? '') === normalized).length;
    return sum + direct + fingerprintCount;
  }, 0);
}

function chooseStructure(
  trend: TrendCandidate | null,
  objective: ContentObjective,
  hook: EditorialHookFamily,
  context: EditorialDecisionContext,
  shareability: ShareabilityProfile,
): RhetoricalStructure {
  const text = candidateText(trend);
  const scores = new Map<RhetoricalStructure, number>([
    ['CLAIM_EXPLANATION_IMPLICATION', 40],
    ['OBSERVATION_MECHANISM_CONSEQUENCE', 36],
    ['COMPACT_INSIGHT', 28],
    ['MISTAKE_CAUSE_CORRECTION', 12],
    ['COMPARISON_DISTINCTION_DECISION', 12],
    ['QUESTION_ANSWER_TAKEAWAY', 7],
    ['FRAMEWORK_EXPLANATION_APPLICATION', 10],
    ['STORY_TURNING_POINT_LESSON', context.personalEvidenceAvailable ? 8 : -100],
  ]);
  const add = (structure: RhetoricalStructure, amount: number) => scores.set(structure, (scores.get(structure) ?? 0) + amount);
  if (TEXT_SIGNALS.mistake.test(text) || hook === 'MISTAKE') add('MISTAKE_CAUSE_CORRECTION', 60);
  if (TEXT_SIGNALS.comparison.test(text) || hook === 'COMPARISON') add('COMPARISON_DISTINCTION_DECISION', 60);
  if (TEXT_SIGNALS.question.test((trend?.topic ?? '').trim()) || hook === 'QUESTION') add('QUESTION_ANSWER_TAKEAWAY', 42);
  if (TEXT_SIGNALS.mechanism.test(text) || trend?.fingerprint?.mechanisms.length) add('OBSERVATION_MECHANISM_CONSEQUENCE', 34);
  if (objective === 'CREATE_REFERENCE_VALUE' && TEXT_SIGNALS.process.test(text)) add('FRAMEWORK_EXPLANATION_APPLICATION', 54);
  if (objective === 'SHOW_EXPERIENCE' && context.personalEvidenceAvailable) add('STORY_TURNING_POINT_LESSON', 75);
  if ((trend?.topic.length ?? 0) < 95 && !TEXT_SIGNALS.process.test(text)) add('COMPACT_INSIGHT', 15);
  const presentationBonus = 10 + Math.max(-3, Math.min(3, shareability.accountPreferenceAdjustment));
  if (shareability.recommendedPresentation === 'COMPACT_TEXT') add('COMPACT_INSIGHT', presentationBonus);
  if (shareability.recommendedPresentation === 'STRUCTURED_TEXT') {
    add('CLAIM_EXPLANATION_IMPLICATION', presentationBonus * .7);
    add('OBSERVATION_MECHANISM_CONSEQUENCE', presentationBonus * .55);
  }
  if (shareability.recommendedPresentation === 'FRAMEWORK' || shareability.recommendedPresentation === 'CAROUSEL_CANDIDATE') {
    add('FRAMEWORK_EXPLANATION_APPLICATION', presentationBonus);
  }
  if (shareability.recommendedPresentation === 'VISUAL_REFERENCE') add('OBSERVATION_MECHANISM_CONSEQUENCE', presentationBonus * .7);

  for (const structure of scores.keys()) {
    const currentCount = (context.currentBatch ?? []).filter((item) => item.rhetoricalStructure === structure).length;
    add(structure, -(structureMemoryCount(structure, context.recentMemory) * 8 + currentCount * 24));
    add(structure, scoreCandidateAgainstPerformance(context.performanceProfile, { structure }).adjustment);
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

function chooseEnding(
  objective: ContentObjective,
  conversion: ConversionObjective,
  structure: RhetoricalStructure,
  trend: TrendCandidate | null,
  context: EditorialDecisionContext,
): EditorialEndingIntent {
  if (conversion !== 'NONE') return conversion === 'COMMENT' ? 'QUESTION' : 'SOFT_CTA';
  let preferred: EditorialEndingIntent = 'CONCLUSION';
  if (objective === 'SHOW_EXPERIENCE') preferred = 'PERSONAL_NOTE';
  else if (objective === 'CHALLENGE_ASSUMPTION') preferred = 'CHALLENGE';
  else if (objective === 'CREATE_DISCUSSION') preferred = 'OBSERVATION';
  else if (TEXT_SIGNALS.prediction.test(candidateText(trend)) && trend?.ideaOrigin === 'RECENT_DEVELOPMENT') preferred = 'PREDICTION';
  else if (structure === 'COMPACT_INSIGHT') preferred = 'NO_CTA';
  else if (objective === 'TEACH' || objective === 'CREATE_REFERENCE_VALUE') preferred = 'INSIGHT';
  const candidates: EditorialEndingIntent[] = [
    'CONCLUSION', 'INSIGHT', 'PREDICTION', 'OBSERVATION', 'CHALLENGE', 'QUESTION', 'PERSONAL_NOTE', 'NO_CTA',
  ];
  return candidates
    .filter((ending) => ending !== 'PERSONAL_NOTE' || context.personalEvidenceAvailable)
    .map((ending) => ({
      ending,
      score: (ending === preferred ? 10 : 0)
        + scoreCandidateAgainstPerformance(context.performanceProfile, { endingType: ending }).adjustment,
    }))
    .sort((a, b) => b.score - a.score || a.ending.localeCompare(b.ending))[0].ending;
}

function chooseReferenceValue(objective: ContentObjective, trend: TrendCandidate | null): ReferenceValueForm {
  const text = candidateText(trend);
  if (objective === 'SHOW_EXPERIENCE') return 'EXPERIENCE_LESSON';
  if (TEXT_SIGNALS.comparison.test(text) || TEXT_SIGNALS.challenge.test(text)) return 'MEMORABLE_DISTINCTION';
  if (/\b(rule|heuristic|signal|test|diagnostic)\b/i.test(text)) return 'HEURISTIC';
  if (TEXT_SIGNALS.process.test(text)) return 'FRAMEWORK';
  if (objective === 'TEACH' || objective === 'CREATE_REFERENCE_VALUE') return 'USEFUL_EXPLANATION';
  return 'NONE';
}

export function inferEditorialAngle(trend: TrendCandidate | null, fallback: PostAngle): PostAngle {
  const text = candidateText(trend);
  if (!trend) return fallback;
  if (TEXT_SIGNALS.mistake.test(text)) return 'technical_mistake';
  if (TEXT_SIGNALS.comparison.test(text)) return 'architecture_tradeoff';
  if (TEXT_SIGNALS.challenge.test(text)) return 'defensible_opinion';
  if (TEXT_SIGNALS.process.test(text)) return 'practical_tutorial';
  if (trend.personalEvidencePotential === 'STRONGLY_BENEFICIAL') return 'product_lesson';
  if (TEXT_SIGNALS.mechanism.test(text) || trend.fingerprint?.mechanisms.length) return 'product_lesson';
  return 'reflection';
}

export function selectEditorialDecision(
  trend: TrendCandidate | null,
  context: EditorialDecisionContext = {},
): EditorialDecision {
  const personalEvidenceAvailable = context.personalEvidenceAvailable === true;
  const safeContext = { ...context, personalEvidenceAvailable };
  const contentObjective = inferObjective(trend, safeContext);
  const shareabilityProfile = assessShareability({
    centralClaim: trend?.topic ?? 'Develop one useful idea for the audience.',
    mechanism: trend?.fingerprint?.mechanisms.join(' ') ?? trend?.summary,
    audienceConsequence: trend?.audienceConsequence ?? trend?.audienceRelevance,
    ideaFamily: trend?.ideaFamily ?? trend?.suggestedAngle,
    contentObjective,
    personalEvidenceAvailable,
    semanticShareabilityHint: trend?.shareabilityHint,
    performanceProfile: context.performanceProfile,
  });
  const conversionObjective = inferConversionObjective(contentObjective, context.primaryGoal);
  const hookFamily = chooseHook(trend, contentObjective, safeContext);
  const rhetoricalStructure = chooseStructure(trend, contentObjective, hookFamily, safeContext, shareabilityProfile);
  const endingIntent = chooseEnding(contentObjective, conversionObjective, rhetoricalStructure, trend, safeContext);
  const referenceValueForm = chooseReferenceValue(contentObjective, trend);
  return {
    contentObjective,
    conversionObjective,
    hookFamily,
    rhetoricalStructure,
    endingIntent,
    referenceValueForm,
    personalEvidenceAvailable,
    shareabilityProfile,
    rationale: [
      `objective follows the claim's ${contentObjective.toLowerCase().replace(/_/g, ' ')} need`,
      `hook fits the idea and carries recent-use penalty`,
      `structure fits the argument and carries batch/history repetition penalty`,
      `shareability presentation remains a soft ${shareabilityProfile.recommendedPresentation.toLowerCase().replace(/_/g, ' ')} signal`,
      conversionObjective === 'NONE' ? 'no conversion action is required' : `conversion goal supports ${conversionObjective.toLowerCase()}`,
    ],
  };
}

export function legacyHookStyle(family: EditorialHookFamily): HookStyle {
  const map: Record<EditorialHookFamily, HookStyle> = {
    FIRST_PERSON_LESSON: 'lesson', OBSERVATION: 'observation', CONTRARIAN_CLAIM: 'contrarian',
    SPECIFIC_RESULT: 'observation', MISTAKE: 'mistake', COMPARISON: 'comparison', QUESTION: 'question',
    STORY_OPENING: 'story', DIRECT_VALUE_PROMISE: 'lesson',
  };
  return map[family];
}

export function legacyLayout(structure: RhetoricalStructure): PostLayout {
  const map: Record<RhetoricalStructure, PostLayout> = {
    CLAIM_EXPLANATION_IMPLICATION: 'opinion_with_reasoning', STORY_TURNING_POINT_LESSON: 'story_then_lesson',
    OBSERVATION_MECHANISM_CONSEQUENCE: 'short_observation', MISTAKE_CAUSE_CORRECTION: 'problem_mechanism_fix',
    COMPARISON_DISTINCTION_DECISION: 'comparison', QUESTION_ANSWER_TAKEAWAY: 'short_observation',
    FRAMEWORK_EXPLANATION_APPLICATION: 'technical_walkthrough', COMPACT_INSIGHT: 'short_observation',
  };
  return map[structure];
}

export function expressionModeForDecision(decision: EditorialDecision): ExpressionMode {
  switch (decision.rhetoricalStructure) {
    case 'MISTAKE_CAUSE_CORRECTION': return 'diagnostic';
    case 'COMPARISON_DISTINCTION_DECISION': return 'analytical';
    case 'STORY_TURNING_POINT_LESSON': return 'reflective';
    case 'QUESTION_ANSWER_TAKEAWAY': return 'conversational';
    case 'FRAMEWORK_EXPLANATION_APPLICATION': return 'walkthrough';
    case 'COMPACT_INSIGHT': return decision.contentObjective === 'CHALLENGE_ASSUMPTION' ? 'opinionated' : 'direct';
    default: return decision.contentObjective === 'CHALLENGE_ASSUMPTION' ? 'opinionated' : 'analytical';
  }
}

export type OpeningQualityEvaluation = {
  score: number;
  opening: string;
  issues: QualityIssue[];
};

export function evaluateFirstThreeLines(
  body: string,
  options: { personalEvidenceAvailable?: boolean; audienceTerms?: string[] } = {},
): OpeningQualityEvaluation {
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 3);
  const opening = lines.join(' ');
  const issues: QualityIssue[] = [];
  const realized = classifyOpeningForm(body);
  if (/^(?:in today'?s|in the (?:modern|digital|ever-changing)|when it comes to|as (?:we|businesses|professionals)|\w+(?: \w+){0,4} (?:is|are) (?:important|essential|crucial|changing))/i.test(opening)) {
    issues.push({
      code: 'generic_category_intro', severity: 'error', evidence: [opening.slice(0, 180)],
      instruction: 'Open with the narrow claim, concrete observation, distinction, behavior, or tension instead of introducing the category.',
    });
  }
  if (realized.genericCategorySetup && !issues.some((issue) => issue.code === 'generic_category_intro')) {
    issues.push({
      code: 'generic_category_intro', severity: 'error', evidence: [lines[0]?.slice(0, 180) ?? ''],
      instruction: 'Make line one advance the claim through a mechanism, consequence, distinction, condition, or concrete observation; naming the domain or audience is not enough.',
    });
  }
  if (realized.obviousQuestionAnswer) {
    issues.push({
      code: 'obvious_question_answer_opening', severity: 'error', evidence: [opening.slice(0, 180)],
      instruction: 'Replace the obvious question-and-answer setup with the useful claim or uncertainty itself.',
    });
  }
  if (realized.rhetoricalMove === 'MISCONCEPTION_CORRECTION'
    && !/\b(?:because|evidence|data|when|fails?|breaks?|instead|rather|\d+(?:\.\d+)?%?)\b/i.test(opening)) {
    issues.push({
      code: 'unsupported_misconception_opening', severity: 'error', evidence: [opening.slice(0, 180)],
      instruction: 'Do not manufacture a common mistake or assumption. State the supported distinction, mechanism, or evidence directly.',
    });
  }
  if (lines.length >= 2 && jaccardSimilarity(lines[0], lines[1]) >= .72) {
    issues.push({
      code: 'opening_line_restatement', severity: 'error', evidence: lines.slice(0, 2),
      instruction: 'Make line two deepen, explain, qualify, or contrast line one instead of restating it.',
    });
  }
  const hasConcreteTension = /\b(?:but|until|instead|rather|because|fails?|breaks?|cost|risk|mistake|only when|depends|cannot|can\'t|without|means)\b/i.test(opening);
  const hasSpecificIdea = hasConcreteTension || /\b\d+(?:\.\d+)?%?\b/.test(opening) || /[?:]/.test(opening);
  if (opening && !hasSpecificIdea && opening.split(/\s+/).length > 18) {
    issues.push({
      code: 'opening_lacks_concrete_idea', severity: 'warning', evidence: [opening.slice(0, 180)],
      instruction: 'Give the reader a concrete idea, distinction, outcome, or tension within the first three lines.',
    });
  }
  if (/\b(?:you won\'t believe|shocking|secret nobody|this changes everything|guaranteed|must read|stop scrolling)\b/i.test(opening)) {
    issues.push({ code: 'clickbait_opening', severity: 'error', evidence: [opening.slice(0, 180)], instruction: 'Replace sensational framing with the useful underlying claim.' });
  }
  if (!options.personalEvidenceAvailable && /\bI (?:learned|discovered|realized|built|fixed|helped|grew|lost|made|tested|implemented|experienced)\b/i.test(opening)) {
    issues.push({
      code: 'unsupported_first_person_opening', severity: 'error', evidence: [opening.slice(0, 180)],
      instruction: 'Use a non-personal observation unless explicit personal evidence supports this opening.',
    });
  }
  const audienceTerms = (options.audienceTerms ?? []).map(normalizeTrendTitle).filter(Boolean);
  if (audienceTerms.length && !audienceTerms.some((term) => normalizeTrendTitle(opening).includes(term)) && !/\b(?:you|your|teams?|leaders?|clients?|patients?|founders?|developers?|operators?|creators?)\b/i.test(opening)) {
    issues.push({ code: 'opening_relevance_is_implicit', severity: 'warning', instruction: 'Make audience relevance quickly legible when it can be done naturally.' });
  }
  const score = Math.max(0, 100 - issues.reduce((sum, issue) => sum + (issue.severity === 'error' ? 28 : 10), 0));
  return { score, opening, issues };
}
