import type { EffectiveBotStrategy } from '../botStrategyService';
import { scoreTrendForStrategy, type StrategyTrendScore } from '../botStrategyTrendService';
import type { ManualTopicSuggestion } from './manualPostTopicSuggestionService';

export const STRONG_TOPIC_SCORE = 70;
export const MAX_TOPIC_IMPROVEMENT_ATTEMPTS = 2;
export const TOPIC_IMPROVEMENT_BATCH_SIZE = 5;

export type ImprovedTopicOutput = {
  candidateId: string;
  title: string;
  summary: string;
  pillar: string;
  suggestedAngle: string;
  audienceRelevance: string;
  whyItFitsGoal: string;
  improvementReason: string;
};

export type ScoredTopicSuggestion = Omit<ManualTopicSuggestion, 'relevanceScore'> & {
  relevanceScore: number;
  originalTitle: string;
  originalSummary: string;
  originalScore: number;
  improvementAttempts: number;
  wasAiImproved: boolean;
  scoreBreakdown: StrategyTrendScore['breakdown'];
};

type ImproveBatch = (prompt: string) => Promise<string>;
type ScoreTopic = typeof scoreTrendForStrategy;

function allPillars(strategy: EffectiveBotStrategy): string[] {
  return [
    ...strategy.contentPillars.primaryPillars,
    ...strategy.contentPillars.secondaryPillars,
    ...(strategy.contentPillars.experimentalPillars ?? []),
  ].map((pillar) => pillar.name);
}

function toScoringCandidate(topic: ManualTopicSuggestion) {
  return {
    topic: topic.title,
    summary: topic.description,
    source: topic.sourcePlatform ?? 'manual_topic_suggestion',
    link: topic.sourceUrl,
    matchedPillar: topic.matchedPillar,
    suggestedAngle: topic.suggestedAngle,
    audienceRelevance: topic.whyAudienceCares,
  };
}

export function buildTopicImprovementPrompt(
  batch: Array<{ id: string; topic: ScoredTopicSuggestion }>,
  strategy: EffectiveBotStrategy,
): string {
  const pillars = [
    ...strategy.contentPillars.primaryPillars,
    ...strategy.contentPillars.secondaryPillars,
    ...(strategy.contentPillars.experimentalPillars ?? []),
  ];
  return `Improve these weak LinkedIn topic ideas. Return strict JSON only, with this shape:\n{"topics":[{"candidateId":"string","title":"string","summary":"string","pillar":"string","suggestedAngle":"string","audienceRelevance":"string","whyItFitsGoal":"string","improvementReason":"string"}]}\n\nRules:\n- Ground every edit in the original candidate. Do not add facts, statistics, quotations, people, companies, events, or claims absent from it.\n- Never change sourceUrl, sourcePlatform, publication date, or trend identity.\n- Make the title specific, the angle practical or opinionated, and the audience/goal link explicit.\n- The angle must not repeat the title or summary. Use exactly one listed pillar.\n- Do not output a score.\n\nUSER STRATEGY:\n${JSON.stringify({
    positioningStatement: strategy.profilePositioning.positioningStatement,
    targetAudience: strategy.targetAudience,
    desiredOutcomes: strategy.targetAudience.desiredOutcomes,
    primaryGoal: strategy.contentGoals.primaryGoal,
    contentPillars: pillars.map((p) => ({ name: p.name, description: p.description, keywords: p.trendKeywords })),
    tone: strategy.writingStyle.tone,
    excludedTopics: strategy.contentPillars.excludedTopics,
  })}\n\nCANDIDATES AND SCORING FEEDBACK:\n${JSON.stringify(batch.map(({ id, topic }) => ({
    candidateId: id,
    originalTitle: topic.originalTitle,
    originalSummary: topic.originalSummary,
    currentTitle: topic.title,
    currentSummary: topic.description,
    sourceUrl: topic.sourceUrl,
    sourcePlatform: topic.sourcePlatform,
    matchedPillar: topic.matchedPillar,
    suggestedAngle: topic.suggestedAngle,
    audienceRelevance: topic.whyAudienceCares,
    currentScore: topic.relevanceScore,
    scoreBreakdown: topic.scoreBreakdown,
    weakDimensions: Object.entries(topic.scoreBreakdown).filter(([key, value]) => key !== 'finalScore' && value <= 0).map(([key]) => key),
  })))}`;
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function introducedUnsupportedSignals(original: string, improved: string): boolean {
  const signals = improved.match(/(?:\b\d+(?:\.\d+)?%?\b|["“”][^"“”]{3,}["“”])/g) ?? [];
  return signals.some((signal) => !original.includes(signal));
}

export function parseImprovedTopics(raw: string): ImprovedTopicOutput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim());
  } catch {
    return [];
  }
  const items = (parsed as { topics?: unknown })?.topics;
  if (!Array.isArray(items)) return [];
  return items.flatMap((item): ImprovedTopicOutput[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const fields = ['candidateId', 'title', 'summary', 'pillar', 'suggestedAngle', 'audienceRelevance', 'whyItFitsGoal', 'improvementReason'] as const;
    if (fields.some((field) => typeof record[field] !== 'string' || !(record[field] as string).trim())) return [];
    return [Object.fromEntries(fields.map((field) => [field, (record[field] as string).trim()])) as ImprovedTopicOutput];
  });
}

function validateImprovement(output: ImprovedTopicOutput, original: ScoredTopicSuggestion, strategy: EffectiveBotStrategy): boolean {
  const pillarNames = allPillars(strategy);
  if (!pillarNames.some((pillar) => normalized(pillar) === normalized(output.pillar))) return false;
  if (output.title.length > 180 || output.summary.length > 600 || output.suggestedAngle.length > 500) return false;
  if (normalized(output.suggestedAngle) === normalized(output.title) || normalized(output.suggestedAngle) === normalized(output.summary)) return false;
  const sourceText = `${original.originalTitle} ${original.originalSummary}`;
  return !introducedUnsupportedSignals(sourceText, `${output.title} ${output.summary} ${output.suggestedAngle}`);
}

export async function improveWeakTopicSuggestions(params: {
  topics: ManualTopicSuggestion[];
  strategy: EffectiveBotStrategy;
  improveBatch: ImproveBatch;
  scoreTopic?: ScoreTopic;
}): Promise<{ accepted: ScoredTopicSuggestion[]; discarded: ScoredTopicSuggestion[] }> {
  const scorer = params.scoreTopic ?? scoreTrendForStrategy;
  let working: ScoredTopicSuggestion[] = params.topics.map((topic) => {
    const score = scorer(toScoringCandidate(topic), params.strategy);
    return {
      ...topic,
      relevanceScore: score.score,
      matchedPillar: score.matchedPillar,
      suggestedAngle: topic.suggestedAngle || score.suggestedAngle,
      whyAudienceCares: topic.whyAudienceCares || score.audienceRelevance,
      originalTitle: topic.title,
      originalSummary: topic.description,
      originalScore: score.score,
      improvementAttempts: 0,
      wasAiImproved: false,
      scoreBreakdown: score.breakdown,
    } satisfies ScoredTopicSuggestion;
  });
  const accepted: ScoredTopicSuggestion[] = working.filter((topic) => topic.relevanceScore >= STRONG_TOPIC_SCORE);
  working = working.filter((topic) => (topic.relevanceScore ?? 0) < STRONG_TOPIC_SCORE);

  for (let attempt = 1; attempt <= MAX_TOPIC_IMPROVEMENT_ATTEMPTS && working.length; attempt++) {
    const next: ScoredTopicSuggestion[] = [];
    for (let offset = 0; offset < working.length; offset += TOPIC_IMPROVEMENT_BATCH_SIZE) {
      const batch = working.slice(offset, offset + TOPIC_IMPROVEMENT_BATCH_SIZE).map((topic, index) => ({ id: `candidate-${offset + index}`, topic }));
      let outputs: ImprovedTopicOutput[] = [];
      try {
        outputs = parseImprovedTopics(await params.improveBatch(buildTopicImprovementPrompt(batch, params.strategy)));
      } catch (error) {
        console.warn('[topic-improvement] provider failure', { attempt, message: error instanceof Error ? error.message : String(error) });
      }
      for (const entry of batch) {
        const output = outputs.find((item) => item.candidateId === entry.id);
        if (!output || !validateImprovement(output, entry.topic, params.strategy)) {
          console.warn('[topic-improvement] invalid output', { attempt, candidateId: entry.id });
          next.push({ ...entry.topic, improvementAttempts: attempt });
          continue;
        }
        const improvedBase: ManualTopicSuggestion = {
          ...entry.topic,
          title: output.title,
          description: output.summary,
          reason: output.improvementReason,
          matchedPillar: output.pillar,
          suggestedAngle: output.suggestedAngle,
          whyAudienceCares: output.audienceRelevance,
        };
        const score = scorer(toScoringCandidate(improvedBase), params.strategy);
        const improved: ScoredTopicSuggestion = {
          ...entry.topic,
          ...improvedBase,
          relevanceScore: score.score,
          scoreBreakdown: score.breakdown,
          improvementAttempts: attempt,
          wasAiImproved: true,
        };
        console.info('[topic-improvement] rescored', { originalScore: improved.originalScore, improvedScore: score.score, attempt, accepted: score.score >= STRONG_TOPIC_SCORE });
        if (score.score >= STRONG_TOPIC_SCORE) accepted.push(improved); else next.push(improved);
      }
    }
    working = next;
  }
  return { accepted, discarded: working };
}
