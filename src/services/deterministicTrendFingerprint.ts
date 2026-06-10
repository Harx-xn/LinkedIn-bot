import type { TopicCluster, TopicFingerprint, TrendCandidate } from './generationTypes';
import { classifyTopicCluster } from './topicFingerprintService';

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'for', 'in', 'on', 'with',
  'how', 'why', 'what', 'is', 'are', 'new', 'by', 'at', 'from', 'that', 'this',
]);

const SHORT_TOKENS = new Set(['ai', 'ml', 'rpa', 'api', 'ui', 'ux', 'iot', 'saas']);

const SYNONYM_GROUPS: string[][] = [
  ['changing', 'transforming', 'upending', 'reshaping'],
  ['product', 'products', 'software', 'tool', 'tools'],
  ['ai', 'automation', 'intelligence'],
];

const SYNONYM_MAP = new Map<string, string>(
  SYNONYM_GROUPS.flatMap((group) => group.map((word) => [word, group[0]])),
);

export function normalizeDeterministicTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stemBasicToken(token: string): string {
  return SYNONYM_MAP.get(token) ?? token.replace(/(ing|ed|es|s)$/i, '').trim();
}

function isMeaningfulToken(token: string): boolean {
  return (token.length > 2 || SHORT_TOKENS.has(token)) && !STOP_WORDS.has(token);
}

export function buildDeterministicFingerprintKey(title: string): string {
  return normalizeDeterministicTitle(title)
    .split(/\s+/)
    .filter(isMeaningfulToken)
    .map(stemBasicToken)
    .filter(Boolean)
    .sort()
    .slice(0, 8)
    .join('|');
}

export function tokenJaccardSimilarity(firstTitle: string, secondTitle: string): number {
  const first = new Set(buildDeterministicFingerprintKey(firstTitle).split('|').filter(Boolean));
  const second = new Set(buildDeterministicFingerprintKey(secondTitle).split('|').filter(Boolean));

  if (!first.size || !second.size) return 0;

  let intersection = 0;
  for (const token of first) {
    if (second.has(token)) intersection += 1;
  }

  const union = new Set([...first, ...second]).size;
  return union === 0 ? 0 : intersection / union;
}

export function buildDeterministicTopicFingerprint(
  trend: TrendCandidate,
): TopicFingerprint {
  const normalizedTopic = normalizeDeterministicTitle(trend.topic) || trend.topic.toLowerCase().trim();
  const cluster = classifyTopicCluster(`${trend.topic} ${trend.niche ?? ''}`);
  const tokens = buildDeterministicFingerprintKey(trend.topic).split('|').filter(Boolean);

  return {
    normalizedTopic,
    topicCluster: cluster,
    coreClaim: normalizedTopic,
    entities: trend.niche ? [trend.niche] : [],
    mechanisms: tokens.slice(0, 4),
  };
}

export function deterministicNearDedupeTrends(
  trends: TrendCandidate[],
  threshold: number,
): { kept: TrendCandidate[]; removed: number } {
  const kept: TrendCandidate[] = [];
  let removed = 0;

  for (const trend of trends) {
    let duplicateIdx = -1;
    for (let i = 0; i < kept.length; i++) {
      if (tokenJaccardSimilarity(trend.topic, kept[i].topic) >= threshold) {
        duplicateIdx = i;
        break;
      }
    }
    if (duplicateIdx >= 0) {
      removed += 1;
      const existing = kept[duplicateIdx];
      const existingScore = (existing.link ? 1 : 0) + (existing.publishedAt ? 1 : 0);
      const incomingScore = (trend.link ? 1 : 0) + (trend.publishedAt ? 1 : 0);
      if (incomingScore > existingScore) kept[duplicateIdx] = trend;
    } else {
      kept.push(trend);
    }
  }

  return { kept, removed };
}
