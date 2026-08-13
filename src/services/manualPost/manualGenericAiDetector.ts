export const genericManualAiPatterns = [
  /this distinction is critical/i,
  /in today'?s (?:world|landscape|digital age)/i,
  /to mitigate this risk/i,
  /here are some actionable steps/i,
  /by doing this, you not only/i,
  /imagine a scenario where/i,
  /it is important to note/i,
  /what measures are you taking/i,
  /one often overlooked detail/i,
  /in the rapidly evolving/i,
  /unlock the power of/i,
  /game[- ]changer/i,
  /revolutionize/i,
];

const forcedClosingQuestionPatterns = [
  /what (?:measures|steps|strategies) are you (?:taking|using)/i,
  /how do you (?:handle|approach|think about|deal with)/i,
  /what(?:'s| is) your (?:take|experience|approach)/i,
  /have you (?:ever|tried|considered)/i,
  /are you ready to/i,
  /what do you think\??/i,
];

const vagueHookPatterns = [
  /^in today'?s/i,
  /^many (?:people|teams|companies|organizations|businesses)/i,
  /^when it comes to/i,
  /^there(?:'s| is) no denying/i,
  /^let'?s (?:talk|discuss) about/i,
  /^one overlooked detail/i,
  /^in today'?s rapidly evolving landscape/i,
  /^have you ever wondered/i,
  /^in the world of/i,
  /^this one thing can change everything/i,
];

export function isVagueManualHook(text: string): boolean {
  const trimmed = (text || '').trim();
  if (!trimmed) return true;
  return vagueHookPatterns.some((pattern) => pattern.test(trimmed));
}

const genericBulletLeadPatterns = [
  /^[-•*]\s*(?:improve|enhance|optimize|leverage|streamline)/i,
  /^[-•*]\s*(?:focus on|prioritize|consider)/i,
];

const byDoingThisPattern = /by doing this\b/i;

function extractClosingLine(content: string): string {
  const lines = content.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

function countGenericBullets(content: string): number {
  const lines = content.split('\n');
  return lines.filter((line) => genericBulletLeadPatterns.some((re) => re.test(line.trim()))).length;
}

function matchPatterns(content: string, patterns: RegExp[]): string[] {
  const matches: string[] = [];
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) matches.push(match[0]);
  }
  return matches;
}

/**
 * Deterministic generic-AI risk scoring for manual-composer content only.
 */
export function calculateManualGenericAiRisk(
  content: string,
  options: { allowEnumeration?: boolean } = {},
): {
  score: number;
  matches: string[];
  detectedIssues: string[];
} {
  const text = (content || '').trim();
  if (!text) return { score: 0, matches: [], detectedIssues: [] };

  const matches = matchPatterns(text, genericManualAiPatterns);
  const detectedIssues: string[] = [];
  let score = matches.length;

  const closing = extractClosingLine(text);
  if (closing.endsWith('?')) {
    const forced = matchPatterns(closing, forcedClosingQuestionPatterns);
    if (forced.length > 0) {
      matches.push(...forced.map((m) => `forced_question:${m}`));
      score += 2;
    } else {
      matches.push('forced_question:closing_question_mark');
      score += 1;
    }
  }

  const firstLine = text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  if (/^(?:what if|could it be|have you ever|did you know|imagine\b|what if the secret to)\b/i.test(firstLine)) {
    detectedIssues.push('GENERIC_QUESTION_HOOK');
    matches.push('risk:GENERIC_QUESTION_HOOK');
    score += 2;
  }
  if (vagueHookPatterns.some((re) => re.test(firstLine))) {
    matches.push('structure:vague_introductory_hook');
    score += 1;
  }

  if (/^(?:this|that|it) (?:is|means|shows|highlights)/i.test(text.split('\n\n')[1]?.trim() ?? '')) {
    matches.push('structure:general_explanation_opener');
    score += 1;
  }

  const genericBulletCount = countGenericBullets(text);
  if (genericBulletCount >= 3) {
    matches.push('structure:three_generic_bullets');
    score += 2;
  } else if (genericBulletCount >= 2) {
    matches.push('structure:generic_bullets');
    score += 1;
  }

  if (byDoingThisPattern.test(text)) {
    const byDoingMatch = text.match(byDoingThisPattern);
    if (byDoingMatch) matches.push(byDoingMatch[0]);
    score += 1;
  }

  const essayTransitions = text.match(/(?:^|\n\s*\n)(?:Additionally|Moreover|Furthermore|On the flip side|Another (?:reason|factor|point|benefit|risk))\b/gi) ?? [];
  if (essayTransitions.length >= 3) {
    detectedIssues.push('EXCESSIVE_ESSAY_TRANSITIONS');
    matches.push('risk:EXCESSIVE_ESSAY_TRANSITIONS');
    score += 2;
  }

  const progression = evaluateSemanticProgression(text, options);
  const semanticSignals: Partial<Record<(typeof progression.codes)[number], string>> = {
    ENUMERATION_WITHOUT_INTERPRETATION: 'ENUMERATION_WITHOUT_INTERPRETATION',
    CONCLUSION_RESTATES_THESIS: 'THESIS_RESTATEMENT',
    GENERIC_RECOMMENDATION_ENDING: 'GENERIC_RECOMMENDATION_ENDING',
    FORCED_NICHE_PARAGRAPH: 'FORCED_NICHE_REFERENCE',
    ARGUMENT_STAGNATION: 'POSSIBLE_SEMANTIC_STAGNATION',
    SEMANTIC_REPETITION: 'POSSIBLE_SEMANTIC_STAGNATION',
  };
  for (const code of progression.codes) {
    const signal = semanticSignals[code];
    if (!signal || detectedIssues.includes(signal)) continue;
    detectedIssues.push(signal);
    matches.push(`risk:${signal}`);
    score += signal === 'THESIS_RESTATEMENT' || signal === 'ENUMERATION_WITHOUT_INTERPRETATION' ? 2 : 1;
  }

  return { score, matches, detectedIssues };
}

export function hasForcedEngagementQuestion(content: string): boolean {
  const closing = extractClosingLine(content);
  if (!closing.endsWith('?')) return false;
  return forcedClosingQuestionPatterns.some((re) => re.test(closing));
}
import { evaluateSemanticProgression } from '../semanticProgression';
