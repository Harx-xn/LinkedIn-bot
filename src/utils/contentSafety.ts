export interface ContentSafetyResult {
  safe: boolean;
  matchedTerms: string[];
}

// Central, deliberately token-based list. Add terms here without changing the
// matching algorithm or exposing the collection through API responses.
const BLOCKED_TERMS = new Set([
  'porn', 'pornographic', 'nude', 'nudity', 'xxx', 'sexually',
  'fuck', 'fucking', 'shit', 'bitch', 'cunt',
]);

export function normalizeSafetyTokens(value: string): string[] {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .replace(/[\p{P}\p{S}_]+/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean);
}

export function checkSafeForWorkText(value: string): ContentSafetyResult {
  const matchedTerms = Array.from(
    new Set(normalizeSafetyTokens(value).filter((token) => BLOCKED_TERMS.has(token))),
  );
  return { safe: matchedTerms.length === 0, matchedTerms };
}
