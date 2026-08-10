import { calculateManualGenericAiRisk } from './manualGenericAiDetector';
import type {
  ManualCriticResult,
  ManualCriticScores,
  ManualGeneratedPost,
} from './manualPostTypes';

function clampScore(value: unknown, fallback = 0): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(10, n));
}

export function evaluateDeterministicDraftQuality(content: string): {
  genericAiRisk: number;
  matches: string[];
  needsQualityRepair: boolean;
} {
  const risk = calculateManualGenericAiRisk(content);
  return {
    genericAiRisk: risk.score,
    matches: risk.matches,
    needsQualityRepair: risk.score > 4,
  };
}

export function criticScoresNeedRewrite(scores: ManualCriticScores): boolean {
  return (
    scores.hook < 7 ||
    scores.specificity < 7 ||
    scores.focus < 8 ||
    scores.credibility < 7 ||
    (scores.audienceFit ?? 8) < 7 ||
    (scores.conversationPotential ?? 8) < 7 ||
    (scores.dwellQuality ?? 8) < 7 ||
    scores.genericAiRisk > 4
  );
}

export function parseManualCriticResult(raw: string): ManualCriticResult {
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const parsed = JSON.parse(cleaned) as Record<string, unknown>;
  const scoresRaw = parsed.scores;
  if (!scoresRaw || typeof scoresRaw !== 'object' || Array.isArray(scoresRaw)) {
    throw new Error('Critic output missing scores');
  }
  const scoresObj = scoresRaw as Record<string, unknown>;

  const scores: ManualCriticScores = {
    hook: clampScore(scoresObj.hook),
    specificity: clampScore(scoresObj.specificity),
    voiceMatch: clampScore(scoresObj.voiceMatch),
    focus: clampScore(scoresObj.focus),
    credibility: clampScore(scoresObj.credibility),
    originality: clampScore(scoresObj.originality),
    audienceFit: clampScore(scoresObj.audienceFit, 8),
    conversationPotential: clampScore(scoresObj.conversationPotential, 8),
    dwellQuality: clampScore(scoresObj.dwellQuality, 8),
    readability: clampScore(scoresObj.readability),
    genericAiRisk: clampScore(scoresObj.genericAiRisk),
  };

  const issues = Array.isArray(parsed.issues)
    ? parsed.issues.map(String).map((issue) => issue.trim()).filter(Boolean)
    : [];

  const decision = parsed.decision === 'REVISE' ? 'REVISE' : 'PASS';
  const revisedRaw = parsed.revised;
  const revised =
    revisedRaw && typeof revisedRaw === 'object' && !Array.isArray(revisedRaw)
      ? {
          hook: typeof (revisedRaw as Record<string, unknown>).hook === 'string'
            ? String((revisedRaw as Record<string, unknown>).hook).trim()
            : undefined,
          body: typeof (revisedRaw as Record<string, unknown>).body === 'string'
            ? String((revisedRaw as Record<string, unknown>).body).trim()
            : undefined,
          closingLine:
            typeof (revisedRaw as Record<string, unknown>).closingLine === 'string'
              ? String((revisedRaw as Record<string, unknown>).closingLine).trim()
              : undefined,
        }
      : undefined;

  return { scores, issues, decision, revised };
}

export function applyBoundedManualRevision(
  draft: ManualGeneratedPost,
  critic: ManualCriticResult,
): ManualGeneratedPost {
  if (critic.decision !== 'REVISE' || !critic.revised) {
    return draft;
  }

  return {
    ...draft,
    hook: critic.revised.hook?.trim() || draft.hook,
    body: critic.revised.body?.trim() || draft.body,
    closingLine: critic.revised.closingLine?.trim() || draft.closingLine,
  };
}

export function extractPreservedFactTokens(text: string): string[] {
  const genericSentenceStarters = new Set([
    'A',
    'An',
    'The',
    'This',
    'That',
    'These',
    'Those',
    'Here',
    'What',
    'Why',
    'How',
    'Have',
    'Most',
    'Many',
    'When',
    'In',
    'As',
    'If',
    'Conversely',
    'Consider',
    'Invest',
  ]);
  return Array.from(
    new Set(
      text
        .match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b|\b\d+(?:\.\d+)?%|\$[\d,]+(?:\.\d+)?\b/g) ?? [],
    ),
  ).filter((token) => !genericSentenceStarters.has(token));
}

export function preservedFactsSurviveRevision(
  before: ManualGeneratedPost,
  after: ManualGeneratedPost,
): boolean {
  const beforeTokens = extractPreservedFactTokens(
    `${before.hook}\n${before.body}\n${before.closingLine}`,
  );
  if (beforeTokens.length === 0) return true;
  const afterText = `${after.hook}\n${after.body}\n${after.closingLine}`;
  return beforeTokens.every((token) => afterText.includes(token));
}
