import type { PostDepthPlan } from '../generationTypes';

export type ManualContentPlan = {
  angle: string;
  coreClaim: string;
  audience: string;
  structure: string;
  hookType: string;
  evidenceType: string;
  ctaType: string;
};

export type ManualGeneratedPost = {
  contentPlan: ManualContentPlan;
  hook: string;
  body: string;
  closingLine: string;
  hashtags: string[];
  sourceTopic?: string;
};

export type ManualJsonParseResult =
  | { ok: true; data: ManualGeneratedPost }
  | { ok: false; stage: 'json_extraction' | 'json_syntax' | 'normalization' | 'schema_validation'; message: string; issues?: string[] };

export type ManualHookCandidate = {
  text: string;
  type: string;
  specificity: number;
  curiosity: number;
  topicRelevance: number;
  clarity: number;
  voiceFit: number;
};

export type ManualAngleCandidate = {
  title: string;
  coreClaim: string;
  audience: string;
  structure: string;
  evidenceMode: string;
  specificity: number;
  novelty: number;
  audienceFit: number;
  voiceFit: number;
  evidenceAvailability: number;
  hookCandidates: ManualHookCandidate[];
  depthPlan?: PostDepthPlan;
};

export type ManualPlanningResult = {
  angles: ManualAngleCandidate[];
};

export type SelectedManualPlan = {
  title: string;
  coreClaim: string;
  audience: string;
  structure: string;
  evidenceMode: string;
  hook: string;
  selectedHookType: string;
  depthPlan: PostDepthPlan;
};

export type ManualCriticScores = {
  hook: number;
  specificity: number;
  voiceMatch: number;
  focus: number;
  credibility: number;
  originality: number;
  audienceFit?: number;
  conversationPotential?: number;
  dwellQuality?: number;
  argumentProgression?: number;
  semanticRedundancy?: number;
  centralClaimClarity?: number;
  depthInterpretation?: number;
  structuralFit?: number;
  endingQuality?: number;
  nicheNaturalness?: number;
  lengthFit?: number;
  readability: number;
  genericAiRisk: number;
};

export type ManualCriticDecision = 'PASS' | 'REVISE';

export type ManualCriticResult = {
  scores: ManualCriticScores;
  issues: string[];
  decision: ManualCriticDecision;
  revised?: {
    hook?: string;
    body?: string;
    closingLine?: string;
  };
};

export type ManualProviderCallBudget = {
  recordProviderCall: (kind?: 'planner' | 'writer' | 'repair', prompt?: string) => void;
  totalCalls: () => number;
  callsByKind: () => { plannerCalls: number; writerCalls: number; repairCalls: number };
  promptTokensByKind: () => { plannerPromptTokens: number[]; writerPromptTokens: number; repairPromptTokens: number[]; totalPromptTokens: number };
};

export function createManualProviderCallBudget(): ManualProviderCallBudget {
  let count = 0;
  const counts = { plannerCalls: 0, writerCalls: 0, repairCalls: 0 };
  const promptTokens = { plannerPromptTokens: [] as number[], writerPromptTokens: 0, repairPromptTokens: [] as number[] };
  return {
    recordProviderCall(kind, prompt) {
      count += 1;
      if (kind === 'planner') counts.plannerCalls += 1;
      if (kind === 'writer') counts.writerCalls += 1;
      if (kind === 'repair') counts.repairCalls += 1;
      const estimate = prompt ? Math.ceil(prompt.length / 4) : 0;
      if (kind === 'planner') promptTokens.plannerPromptTokens.push(estimate);
      if (kind === 'writer') promptTokens.writerPromptTokens += estimate;
      if (kind === 'repair') promptTokens.repairPromptTokens.push(estimate);
    },
    totalCalls() {
      return count;
    },
    callsByKind() {
      return { ...counts };
    },
    promptTokensByKind() {
      const plannerPromptTokens = [...promptTokens.plannerPromptTokens];
      const repairPromptTokens = [...promptTokens.repairPromptTokens];
      const writerPromptTokens = promptTokens.writerPromptTokens;
      return {
        plannerPromptTokens,
        writerPromptTokens,
        repairPromptTokens,
        totalPromptTokens: plannerPromptTokens.reduce((sum, value) => sum + value, 0)
          + writerPromptTokens
          + repairPromptTokens.reduce((sum, value) => sum + value, 0),
      };
    },
  };
}
