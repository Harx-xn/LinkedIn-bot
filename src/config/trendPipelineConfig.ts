export type TrendPipelineMode = 'preview' | 'generation';

export type GoogleFreshnessLayer = '7d' | '30d' | 'fallback';

export type TrendPipelineModeConfig = {
  maxQueriesPerNiche: number;
  maxCandidatesPerNiche: number;
  maxFingerprintCandidates: number;
  useAiFingerprints: boolean;
  useHistoryMatching: boolean;
  useDeepClustering: boolean;
  googleFreshnessLayers: readonly GoogleFreshnessLayer[];
  sourceConcurrency: number;
  nicheConcurrency: number;
  candidateMultiplier: number;
  nearDuplicateThreshold: number;
  logPerCandidate: boolean;
};

export const TREND_PIPELINE_CONFIG: Record<TrendPipelineMode, TrendPipelineModeConfig> = {
  preview: {
    maxQueriesPerNiche: 4,
    maxCandidatesPerNiche: 16,
    maxFingerprintCandidates: 0,
    useAiFingerprints: false,
    useHistoryMatching: false,
    useDeepClustering: false,
    googleFreshnessLayers: ['7d'],
    sourceConcurrency: 8,
    nicheConcurrency: 3,
    candidateMultiplier: 2.5,
    nearDuplicateThreshold: 0.65,
    logPerCandidate: false,
  },
  generation: {
    maxQueriesPerNiche: 8,
    maxCandidatesPerNiche: 24,
    maxFingerprintCandidates: 24,
    useAiFingerprints: true,
    useHistoryMatching: true,
    useDeepClustering: true,
    googleFreshnessLayers: ['7d', '30d', 'fallback'],
    sourceConcurrency: 4,
    nicheConcurrency: 2,
    candidateMultiplier: 5,
    nearDuplicateThreshold: 0.72,
    logPerCandidate: true,
  },
} as const;

export type TrendPipelineOptions = {
  mode: TrendPipelineMode;
  requestedCount: number;
};

export function getPipelineConfig(mode: TrendPipelineMode): TrendPipelineModeConfig {
  return TREND_PIPELINE_CONFIG[mode];
}

export function toPipelineMode(mode: 'preview' | 'batch' | 'generation' | undefined): TrendPipelineMode {
  if (mode === 'preview') return 'preview';
  return 'generation';
}

export function targetCandidateCount(mode: TrendPipelineMode, requestedCount: number): number {
  const cfg = getPipelineConfig(mode);
  return Math.min(
    cfg.maxCandidatesPerNiche * 3,
    Math.ceil(requestedCount * cfg.candidateMultiplier),
  );
}
