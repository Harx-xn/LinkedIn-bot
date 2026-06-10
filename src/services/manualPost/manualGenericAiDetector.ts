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
export function calculateManualGenericAiRisk(content: string): {
  score: number;
  matches: string[];
} {
  const text = (content || '').trim();
  if (!text) return { score: 0, matches: [] };

  const matches = matchPatterns(text, genericManualAiPatterns);
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

  return { score, matches };
}

export function hasForcedEngagementQuestion(content: string): boolean {
  const closing = extractClosingLine(content);
  if (!closing.endsWith('?')) return false;
  return forcedClosingQuestionPatterns.some((re) => re.test(closing));
}
