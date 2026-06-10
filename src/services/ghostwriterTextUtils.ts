export const MAX_IMAGE_SUBHEADING_WORDS = 7;
export const MAX_IMAGE_SUBHEADING_CHARS = 55;
export const MAX_IMAGE_HEADLINE_WORDS = 12;
export const MAX_IMAGE_HEADLINE_CHARS = 70;
export const MAX_IMAGE_BULLET_WORDS = 14;

export function countWords(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

export function clampWords(value: string, maxWords: number): string {
  return value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxWords)
    .join(' ');
}

export function clampChars(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars).trim();
}

const GENERIC_ENDINGS = [
  /\bare you ready\??/i,
  /\bis your business ready\??/i,
  /\bwhat strategies have worked for you\??/i,
  /\bhow are you leveraging\b/i,
  /\bthoughts\??$/i,
  /\bagree\??$/i,
  /\bwhat do you think\??$/i,
];

export function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 3),
  );
}

export function jaccardSimilarity(a: string, b: string): number {
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  const inter = [...sa].filter((x) => sb.has(x)).length;
  const union = new Set([...sa, ...sb]).size;
  return union === 0 ? 0 : inter / union;
}

export function isGenericEnding(body: string): boolean {
  const tail = body.trim().split('\n').slice(-2).join(' ');
  return GENERIC_ENDINGS.some((re) => re.test(tail));
}

export function endsWithQuestion(body: string): boolean {
  const lastLine = body.trim().split('\n').filter(Boolean).pop() ?? '';
  return lastLine.trim().endsWith('?');
}
