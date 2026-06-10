type CircuitState = {
  openUntil: number;
  reason?: string;
};

const redditCircuit: CircuitState = { openUntil: 0 };

let redditSkipLoggedForRequest = false;

export function isRedditConfigured(): boolean {
  return Boolean(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET);
}

export function isRedditCircuitOpen(): boolean {
  return Date.now() < redditCircuit.openUntil;
}

export function openRedditCircuit(reason: string, durationMs = 30 * 60 * 1000): void {
  redditCircuit.openUntil = Date.now() + durationMs;
  redditCircuit.reason = reason;
}

export function resetRedditSkipLog(): void {
  redditSkipLoggedForRequest = false;
}

export function resetRedditCircuit(): void {
  redditCircuit.openUntil = 0;
  redditCircuit.reason = undefined;
}

/** Log once per preview/generation request when Reddit is skipped. */
export function logRedditSkippedOnce(context: { mode: string; reason: string }): void {
  if (redditSkipLoggedForRequest) return;
  redditSkipLoggedForRequest = true;
  console.warn('[trends] Reddit skipped', context);
}

export function noteRedditHttpFailure(status?: number): void {
  if (status === 401 || status === 403 || status === 429) {
    openRedditCircuit(`reddit_http_${status}`);
  }
}

export function filterRedditFromSources(sources: string[]): string[] {
  if (isRedditConfigured() && !isRedditCircuitOpen()) {
    return sources;
  }
  return sources.filter((s) => s.toLowerCase() !== 'reddit');
}
