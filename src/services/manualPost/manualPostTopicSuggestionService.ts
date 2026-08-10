import type { BotVoice } from '../userContentContext';
import type { EffectiveBotStrategy } from '../botStrategyService';
import { scoreTrendForStrategy } from '../botStrategyTrendService';

export type ManualTopicSuggestion = {
  title: string;
  description: string;
  reason: string;
  normalizedTopic?: string;
  topicCluster?: string;
  matchedPillar?: string;
  targetAudience?: string;
  whyAudienceCares?: string;
  suggestedAngle?: string;
  contentGoal?: string;
  relevanceScore?: number;
  sourceTitle?: string;
  sourceUrl?: string;
  sourcePlatform?: string;
};

export const DEFAULT_TOPIC_SUGGESTION_COUNT = 3;

const GENERIC_TOPIC_PATTERNS: RegExp[] = [
  /\bleveraging ai\b/i,
  /\bauthentic connections?\b/i,
  /\bcommon mistakes in\b/i,
  /\btop tools for linkedin growth\b/i,
  /\beffective content marketing\b/i,
  /\bgeneric linkedin\b/i,
  /\bthought leadership\b/i,
  /\bunlock(ing)? the power\b/i,
  /\bgame[- ]changer\b/i,
  /\bin today'?s (fast[- ]paced|digital|ever[- ]changing)\b/i,
  /\bthe future of (ai|content|marketing)\b/i,
  /\bwhy linkedin (matters|is important)\b/i,
  /\bcontent is king\b/i,
  /\bengagement bait\b/i,
];

export function isOutdatedTopic(text: string, currentYear: number): boolean {
  const years = text.match(/\b(20\d{2})\b/g) || [];
  return years.some((year) => Number(year) < currentYear);
}

export function isGenericTopicTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  if (!normalized) return true;
  return GENERIC_TOPIC_PATTERNS.some((pattern) => pattern.test(normalized));
}

function normalizeTitleKey(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function inferTopicCluster(topic: string, strategy?: EffectiveBotStrategy): string {
  const matchedPillar = strategy?.contentPillars.primaryPillars
    .find((pillar) => normalizeTitleKey(topic).includes(normalizeTitleKey(pillar.name)));
  return normalizeTitleKey(matchedPillar?.name || topic).split(' ').slice(0, 4).join('_') || 'other';
}

export function areNearDuplicateTitles(a: string, b: string): boolean {
  const left = normalizeTitleKey(a);
  const right = normalizeTitleKey(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.length >= 24 && right.length >= 24 && (left.includes(right) || right.includes(left))) {
    return true;
  }
  return false;
}

function isValidSuggestion(topic: ManualTopicSuggestion): boolean {
  return topic.title.trim().length >= 12 && topic.description.trim().length >= 12;
}

export function sanitizeTopicSuggestions(
  topics: ManualTopicSuggestion[],
  options: { currentYear: number; maxCount?: number },
): ManualTopicSuggestion[] {
  const maxCount = options.maxCount ?? DEFAULT_TOPIC_SUGGESTION_COUNT;
  const accepted: ManualTopicSuggestion[] = [];

  for (const topic of topics) {
    const title = topic.title.trim();
    const description = topic.description.trim();
    const reason = topic.reason?.trim() || description;

    if (!title || !description) continue;
    if (isOutdatedTopic(`${title} ${description}`, options.currentYear)) continue;
    if (isGenericTopicTitle(title)) continue;
    if (!isValidSuggestion({ title, description, reason })) continue;

    const candidate: ManualTopicSuggestion = { ...topic, title, description, reason };
    if (accepted.some((existing) => areNearDuplicateTitles(existing.title, candidate.title))) {
      continue;
    }

    accepted.push(candidate);
    if (accepted.length >= maxCount) break;
  }

  return accepted;
}

export function buildFallbackTopicSuggestions(
  voice: BotVoice,
  trendSources: string[],
  count: number,
  currentYear: number,
  strategy?: EffectiveBotStrategy,
  rotation = 0,
): ManualTopicSuggestion[] {
  const primaryPillar = strategy?.contentPillars.primaryPillars[0];
  const primaryNiche = primaryPillar?.name || voice.niches.find((niche) => niche.trim()) || 'your niche';
  const sourceHint = trendSources.length > 0 ? trendSources.join(', ') : 'industry news';
  const tone = strategy?.writingStyle.tone[0] || voice.tone || 'Conversational';
  const audience = strategy?.targetAudience.primaryAudience || 'your audience';

  const templates: Array<{ title: string; description: string }> = [
    {
      title: `A ${primaryNiche} workflow that quietly wastes founder time`,
      description: `Name one specific process problem in ${primaryNiche} and the practical fix you'd recommend on LinkedIn.`,
    },
    {
      title: `What ${primaryNiche} buyers notice before they trust your content`,
      description: `Share a concrete credibility signal ${audience} cares about, grounded in your profile expertise.`,
    },
    {
      title: `The tradeoff teams miss when they automate ${primaryNiche} content`,
      description: `Take a contrarian angle on automation guardrails instead of generic AI hype.`,
    },
    {
      title: `One lesson from building in ${primaryNiche} that most posts skip`,
      description: `Turn a real business problem into a post with a clear takeaway for peers in your space.`,
    },
    {
      title: `Why ${sourceHint} headlines are useful, but weak post ideas on their own`,
      description: `Explain how to turn a timely signal into a post angle that fits a ${tone.toLowerCase()} voice.`,
    },
    {
      title: `A question I would ask any ${primaryNiche} founder before publishing more content`,
      description: `Frame a sharp diagnostic question that invites useful comments without engagement bait.`,
    },
    {
      title: `What changed in ${primaryNiche} after teams stopped copying generic playbooks`,
      description: `Describe a specific shift in approach and why it matters this year (${currentYear}).`,
    },
  ];

  const offset = ((rotation % templates.length) + templates.length) % templates.length;
  const rotated = [...templates.slice(offset), ...templates.slice(0, offset)];
  return rotated.slice(0, count).map((template) => ({
    title: template.title,
    description: template.description,
    reason: template.description,
  }));
}

function addStrategyMetadata(
  topic: ManualTopicSuggestion,
  strategy?: EffectiveBotStrategy,
): ManualTopicSuggestion {
  if (!strategy) return topic;
  const score = scoreTrendForStrategy(
    {
      topic: topic.title,
      summary: topic.description,
      source: 'manual_topic_suggestion',
    },
    strategy,
  );
  return {
    ...topic,
    normalizedTopic: normalizeTitleKey(topic.title),
    topicCluster: inferTopicCluster(topic.title, strategy),
    matchedPillar: score.matchedPillar,
    targetAudience: strategy.targetAudience.primaryAudience,
    whyAudienceCares: score.audienceRelevance || topic.reason,
    suggestedAngle: score.suggestedAngle || topic.description,
    contentGoal: strategy.contentGoals.primaryGoal,
    relevanceScore: score.score,
  };
}

export function finalizeTopicSuggestions(
  aiTopics: ManualTopicSuggestion[],
  voice: BotVoice,
  trendSources: string[],
  count = DEFAULT_TOPIC_SUGGESTION_COUNT,
  strategy?: EffectiveBotStrategy,
): ManualTopicSuggestion[] {
  const currentYear = new Date().getFullYear();
  const sanitized = sanitizeTopicSuggestions(aiTopics, { currentYear, maxCount: count });

  if (sanitized.length >= count) {
    return sanitized.slice(0, count).map((topic) => addStrategyMetadata(topic, strategy));
  }

  const fallbacks = buildFallbackTopicSuggestions(
    voice,
    trendSources,
    count,
    currentYear,
    strategy,
    Math.floor(Math.random() * 7),
  );
  const merged = sanitizeTopicSuggestions([...sanitized, ...fallbacks], {
    currentYear,
    maxCount: count,
  });

  return merged.slice(0, count).map((topic) => addStrategyMetadata(topic, strategy));
}
