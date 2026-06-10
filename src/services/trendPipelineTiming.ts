export type PipelineStageTiming = {
  configurationMs: number;
  searchPlanMs: number;
  sourceFetchMs: number;
  filteringMs: number;
  deduplicationMs: number;
  rankingMs: number;
  previewPersistenceMs: number;
  totalMs: number;
};

export class PipelineTimer {
  private startedAt = performance.now();
  private marks = new Map<string, number>();

  mark(stage: keyof Omit<PipelineStageTiming, 'totalMs'>): void {
    this.marks.set(stage, performance.now());
  }

  elapsedSince(stage: keyof Omit<PipelineStageTiming, 'totalMs'>): number {
    const mark = this.marks.get(stage);
    if (!mark) return 0;
    return Math.round(performance.now() - mark);
  }

  finish(): PipelineStageTiming {
    const totalMs = Math.round(performance.now() - this.startedAt);
    const get = (key: keyof Omit<PipelineStageTiming, 'totalMs'>) => this.marks.get(key) ?? this.startedAt;
    const configurationMs = Math.round(get('searchPlanMs') - get('configurationMs'));
    const searchPlanMs = Math.round(get('sourceFetchMs') - get('searchPlanMs'));
    const sourceFetchMs = Math.round(get('filteringMs') - get('sourceFetchMs'));
    const filteringMs = Math.round(get('deduplicationMs') - get('filteringMs'));
    const deduplicationMs = Math.round(get('rankingMs') - get('deduplicationMs'));
    const rankingMs = Math.round(get('previewPersistenceMs') - get('rankingMs'));
    const previewPersistenceMs = Math.round(performance.now() - get('previewPersistenceMs'));

    return {
      configurationMs: Math.max(0, configurationMs),
      searchPlanMs: Math.max(0, searchPlanMs),
      sourceFetchMs: Math.max(0, sourceFetchMs),
      filteringMs: Math.max(0, filteringMs),
      deduplicationMs: Math.max(0, deduplicationMs),
      rankingMs: Math.max(0, rankingMs),
      previewPersistenceMs: Math.max(0, previewPersistenceMs),
      totalMs,
    };
  }
}
