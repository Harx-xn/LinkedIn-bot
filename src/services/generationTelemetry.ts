export type GenerationTelemetry = {
  generationType: string;
  expressionMode: string | null;
  plannerCalls: number;
  writerCalls: number;
  repairCalls: number;
  plannerPromptTokens: number[];
  writerPromptTokens: number;
  repairPromptTokens: number[];
  totalPromptTokens: number;
  /** Backward-compatible alias for totalPromptTokens. */
  promptTokenEstimate: number;
  promptContributions?: {
    profile: number;
    voiceSamples: number;
    recentFingerprints: number;
    topicContext: number;
    depthPlan: number;
    editorialRules: number;
  };
  initialLength: number;
  repairInputLength: number | null;
  repairOutputLength: number | null;
  recoveryInputLength?: number | null;
  recoveryOutputLength?: number | null;
  finalLength: number;
  qualityRiskScore: number;
  detectedIssues: string[];
  repairTriggered: boolean;
  repairAccepted: boolean;
  repairRejected: boolean;
  repairRejectionReason?: string | null;
  recoveryTriggered?: boolean;
  recoveryAccepted?: boolean;
  minimumLengthSatisfied: boolean;
  selectedCandidateSource?: 'initial' | 'repair' | 'recovery' | 'emergency';
  selectedCandidateReason?: string;
  returnedWithQualityWarnings?: boolean;
  finalQualityWarnings?: string[];
  plannerFallbackUsed: boolean;
  plannerValidationFailureReason: string | null;
};

export function estimatePromptTokens(...prompts: string[]): number {
  const characters = prompts.reduce((sum, prompt) => sum + prompt.length, 0);
  return Math.ceil(characters / 4);
}

export function logGenerationTelemetry(telemetry: GenerationTelemetry): void {
  console.info('[generation-telemetry]', telemetry);
}
