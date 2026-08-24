const STOP_WORDS = new Set('a an and are as at be because been but by can do does for from had has have if in into is it its may more most not of on or our should so than that the their them then there these they this to under was we when where which while will with without'.split(' '));

function propositionTokens(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(tokens.filter((token) => token.length > 2 && !STOP_WORDS.has(token)));
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / Math.min(a.size, b.size);
}

export type SemanticProgressionResult = {
  passed: boolean;
  issues: string[];
  codes: SemanticProgressionCode[];
  repetitivePairs: Array<[number, number]>;
  openingConclusionRestatement: boolean;
};

export type SemanticProgressionCode =
  | 'SEMANTIC_REPETITION'
  | 'ARGUMENT_STAGNATION'
  | 'ENUMERATION_WITHOUT_INTERPRETATION'
  | 'CONCLUSION_RESTATES_THESIS'
  | 'FORCED_NICHE_PARAGRAPH'
  | 'GENERIC_RECOMMENDATION_ENDING'
  | 'GENERIC_SCENARIO_STRUCTURE'
  | 'GENERIC_CHECKLIST_EXPANSION'
  | 'GENERIC_ENGAGEMENT_ENDING';

export function evaluateSemanticProgression(
  content: string,
  options: { allowEnumeration?: boolean } = {},
): SemanticProgressionResult {
  const paragraphs = content.split(/\n\s*\n+/).map((part) => part.trim()).filter(Boolean);
  const tokenSets = paragraphs.map(propositionTokens);
  const repetitivePairs: Array<[number, number]> = [];

  for (let later = 1; later < tokenSets.length; later += 1) {
    for (let earlier = 0; earlier < later; earlier += 1) {
      if (overlap(tokenSets[earlier], tokenSets[later]) >= 0.72) {
        repetitivePairs.push([earlier + 1, later + 1]);
      }
    }
  }

  const openingConclusionRestatement = paragraphs.length >= 2
    && overlap(tokenSets[0], tokenSets[tokenSets.length - 1]) >= 0.48;
  const issues = repetitivePairs.map(([a, b]) => `paragraph ${b} substantially restates paragraph ${a}`);
  const codes: SemanticProgressionCode[] = repetitivePairs.length ? ['SEMANTIC_REPETITION'] : [];
  if (openingConclusionRestatement) {
    issues.push('conclusion substantially restates the opening thesis');
    codes.push('CONCLUSION_RESTATES_THESIS');
  }

  const enumeratedLines = content.split('\n').filter((line) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(line)).length;
  const essayTransitionPattern = /^(?:first(?:ly)?|second(?:ly)?|third(?:ly)?|fourth(?:ly)?|fifth(?:ly)?|additionally|moreover|furthermore|on the flip side|another (?:reason|factor|point|benefit|risk))\b/i;
  const transitionedParagraphs = paragraphs.filter((paragraph) => essayTransitionPattern.test(paragraph)).length;
  const interpretationSignals = /\b(?:because|underlying|reveals?|means?|what this shows|not .{0,30} but|root cause|in practice)\b/i.test(content);
  if (!options.allowEnumeration && (enumeratedLines >= 4 || transitionedParagraphs >= 3) && !interpretationSignals) {
    issues.push('enumerates several points without interpreting what they reveal');
    codes.push('ENUMERATION_WITHOUT_INTERPRETATION');
  }
  if (/\bthis is (?:particularly|especially) relevant (?:in|to|for)\b/i.test(content)) {
    issues.push('contains an explicit niche-relevance paragraph that may not advance the argument');
    codes.push('FORCED_NICHE_PARAGRAPH');
  }
  const ending = paragraphs[paragraphs.length - 1] ?? '';
  if (/^(?:therefore,? (?:organizations|teams|businesses) should|by (?:fostering|embracing|prioritizing)|the key takeaway is|ultimately,?|in conclusion,?|this (?:will|can) help (?:organizations|teams|businesses))/i.test(ending)) {
    issues.push('ends with a generic recommendation or summary transition');
    codes.push('GENERIC_RECOMMENDATION_ENDING');
  }
  const genericMoves = [
    /\b(?:today(?:'s)?|modern|rapidly changing|evolving) (?:world|landscape|environment)\b/i,
    /\b(?:the (?:issue|challenge|problem) (?:lies|is)|a common challenge|this creates? a tension)\b/i,
    /\b(?:consider|imagine|picture) (?:a |the )?(?:scenario|situation|team|company|organization)\b/i,
    /\b(?:to (?:address|mitigate|navigate|overcome) (?:this|these)|practical steps|actionable steps|steps (?:teams|leaders|organizations) can take)\b/i,
    /\b(?:the key is|finding|strike|striking) (?:the )?(?:right |proper )?balance\b/i,
  ].filter((pattern) => pattern.test(content)).length;
  if (genericMoves >= 3) {
    issues.push('follows a generic article sequence instead of advancing a specific argument');
    codes.push('GENERIC_SCENARIO_STRUCTURE');
  }
  const checklistLead = /\b(?:here (?:are|is)|start with|follow these|practical|actionable)\b.{0,35}\b(?:steps|tips|practices|ways|checklist)\b/is.test(content);
  if (!options.allowEnumeration && checklistLead && enumeratedLines >= 3 && !interpretationSignals) {
    issues.push('expands a generic recommendation into a checklist without adding reasoning');
    codes.push('GENERIC_CHECKLIST_EXPANSION');
  }
  if (/\b(?:what|which|how) (?:approaches|strategies|methods|practices|steps).{0,45}(?:worked|effective|use|recommend|found)\b[?]?$/i.test(ending)) {
    issues.push('ends with a generic engagement question');
    codes.push('GENERIC_ENGAGEMENT_ENDING');
  }
  if (paragraphs.length >= 4 && !interpretationSignals && !options.allowEnumeration) {
    issues.push('argument accumulates points without a clear interpretive move');
    codes.push('ARGUMENT_STAGNATION');
  }

  return { passed: issues.length === 0, issues, codes: [...new Set(codes)], repetitivePairs, openingConclusionRestatement };
}
