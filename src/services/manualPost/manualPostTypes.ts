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
  recordProviderCall: () => void;
  totalCalls: () => number;
};

export function createManualProviderCallBudget(): ManualProviderCallBudget {
  let count = 0;
  return {
    recordProviderCall() {
      count += 1;
    },
    totalCalls() {
      return count;
    },
  };
}
