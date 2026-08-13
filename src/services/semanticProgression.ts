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
  | 'GENERIC_RECOMMENDATION_ENDING';

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
  if (paragraphs.length >= 4 && !interpretationSignals && !options.allowEnumeration) {
    issues.push('argument accumulates points without a clear interpretive move');
    codes.push('ARGUMENT_STAGNATION');
  }

  return { passed: issues.length === 0, issues, codes: [...new Set(codes)], repetitivePairs, openingConclusionRestatement };
}
