import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildEffectiveBotStrategy } from './botStrategyService';
import {
  buildFallbackContentIntelligence,
  contentIntelligenceInputFingerprint,
  resolveContentIntelligence,
} from './contentIntelligenceService';
import { FALLBACK_PROVENANCE } from './fallbackProvenanceService';
import { buildUnifiedCandidateSelection } from './unifiedBatchCandidateService';
import type { RankedTrendCandidate } from './generationTypes';
import { filterBlockingIssues, canForceAcceptBlockingCodes } from './ghostwriterValidationService';
import { SlotCandidatePool, type CandidateObservation } from './ghostwriterCandidateSelection';
import {
  GeneratedPostMemoryPersistenceError,
  persistGeneratedPostWithMemory,
  type GeneratedPostTransactionRunner,
} from './generatedPostPersistenceService';
import { buildBoundedSafeWriterFallback } from './ghostwriterGenerationService';

function strategy(niche = 'Operations') {
  return buildEffectiveBotStrategy({
    description: 'I explain operational decisions for small teams.',
    tone: 'Direct',
    niches: JSON.stringify([niche]),
    targetAudience: { primaryAudience: 'team leads' },
  });
}

function ranked(claim: string, mechanism: string, searched = false): RankedTrendCandidate {
  const fingerprint = {
    normalizedTopic: claim.toLowerCase(), topicCluster: mechanism.toLowerCase().replace(/\W+/g, '_'),
    coreClaim: claim, entities: ['Operations'], mechanisms: [mechanism],
  };
  return {
    trend: {
      topic: claim, summary: claim, niche: 'Operations', originNiche: 'Operations', territory: mechanism,
      sourceType: searched ? 'searched' : 'strategy_derived',
      ideaOrigin: searched ? 'SEARCH_DISCOVERED' : 'STRATEGY_DERIVED',
      authorityMode: 'EXPLORATORY', ideaQualityScore: 85, fingerprint,
    },
    fingerprint, relevanceScore: 85, sourceQualityScore: searched ? 88 : 70, recencyScore: 75,
    technicalDepthScore: 82, noveltyScore: 84, totalScore: 84,
    novelty: { allowed: true, score: 84, reasons: [] }, matchedPillar: 'Operations',
  };
}

function observation(origin: CandidateObservation['origin'], density: number, issues: CandidateObservation['issues'] = []): CandidateObservation {
  const body = `Explicit ownership prevents duplicate approval checks because every failed decision has one escalation path. ${'Useful implementation detail. '.repeat(14)}`;
  return {
    origin,
    generated: { headline: 'Ownership', subheadline: '', bulletPoints: [], body, hashtags: '' },
    finalized: { headline: 'Ownership', subheadline: '', bulletPoints: [], body, hashtags: '', content: body },
    acceptance: {
      accepted: !issues.some((issue) => issue.severity === 'error'), deterministicScore: 86,
      specificityScore: 80, qualityScore: density, technicalPassed: true,
      blockingIssueCodes: issues.filter((issue) => issue.severity === 'error').map((issue) => issue.code),
      warningIssueCodes: issues.filter((issue) => issue.severity === 'warning').map((issue) => issue.code),
    },
    technicalReview: {
      available: true, passed: !issues.some((issue) => issue.severity === 'error'), confidence: .9,
      informationDensity: density, progressionQuality: 82, redundancyRisk: 10,
      genericDiscourseRisk: 12, claimFidelity: 94, issues: [],
    },
    issues,
    plan: {
      trendIndex: 0, sourceTopic: 'Ownership', angle: 'product_lesson', hookStyle: 'observation',
      endingStyle: 'natural', layout: 'short_observation', rationale: 'test',
      centralClaim: 'Explicit ownership prevents duplicate approval checks.',
      targetLengthRange: { min: 400, max: 900 }, depthClass: 'COMPACT',
    },
  };
}

describe('fallback architecture hardening', () => {
  it('labels successful semantic enrichment accurately', async () => {
    const active = strategy();
    const profile = buildFallbackContentIntelligence(active);
    const result = await resolveContentIntelligence('u', active, {
      load: async () => null,
      enrich: async () => ({ success: true, profile: { ...profile, confidence: .91 } }),
      save: async () => ({ version: 3 }),
    });
    assert.equal(result.source, FALLBACK_PROVENANCE.CONTENT_INTELLIGENCE_REBUILT);
    assert.equal(result.semanticEnrichmentSucceeded, true);
    assert.equal(result.profile.version, 3);
    const cached = await resolveContentIntelligence('u', active, {
      load: async () => ({
        inputFingerprint: result.inputFingerprint,
        profile: result.profile,
        version: result.profile.version,
      }),
      enrich: async () => { throw new Error('cache should avoid enrichment'); },
      save: async () => { throw new Error('cache should avoid persistence'); },
    });
    assert.equal(cached.source, FALLBACK_PROVENANCE.CONTENT_INTELLIGENCE_CACHE);
  });

  it('distinguishes deterministic current-strategy fallback from semantic rebuild', async () => {
    const active = strategy('Recruiting');
    const result = await resolveContentIntelligence('u', active, {
      load: async () => null,
      enrich: async () => ({ success: false, error: 'provider unavailable' }),
      save: async () => ({ version: 1 }),
    });
    assert.equal(result.source, FALLBACK_PROVENANCE.CONTENT_INTELLIGENCE_DETERMINISTIC_FALLBACK);
    assert.equal(result.semanticEnrichmentSucceeded, false);
    assert.equal(result.profileInputFingerprint, contentIntelligenceInputFingerprint(active));
  });

  it('never presents a mismatched stale profile as current enrichment', async () => {
    const old = strategy('Accounting');
    const active = strategy('Healthcare');
    const oldFingerprint = contentIntelligenceInputFingerprint(old);
    const result = await resolveContentIntelligence('u', active, {
      load: async () => ({ inputFingerprint: oldFingerprint, profile: buildFallbackContentIntelligence(old), version: 2 }),
      enrich: async () => ({ success: false, error: 'offline' }),
      save: async () => ({ version: 3 }),
    });
    assert.equal(result.source, FALLBACK_PROVENANCE.CONTENT_INTELLIGENCE_DETERMINISTIC_FALLBACK);
    assert.notEqual(result.profileInputFingerprint, oldFingerprint);

    const staleRecovery = await resolveContentIntelligence('u', active, {
      load: async () => ({ inputFingerprint: oldFingerprint, profile: buildFallbackContentIntelligence(old), version: 2 }),
      enrich: async () => ({ success: false, error: 'offline' }),
      save: async () => ({ version: 3 }),
      deterministicFallback: () => { throw new Error('current fallback unavailable'); },
    });
    assert.equal(staleRecovery.source, FALLBACK_PROVENANCE.STALE_PROFILE_RECOVERY);
    assert.notEqual(staleRecovery.profileInputFingerprint, staleRecovery.inputFingerprint);
  });

  it('preserves a partial strategy batch while search fills only the deficit', async () => {
    const strategyCandidates = [
      ranked('Explicit ownership removes approval loops', 'decision ownership'),
      ranked('Reconciliation checkpoints expose ledger drift', 'checkpoint reconciliation'),
      ranked('Structured interviews reduce evaluator noise', 'weighted scorecard'),
      ranked('Scenario planning exposes cash constraints', 'runway scenarios'),
    ];
    const result = await buildUnifiedCandidateSelection({
      strategyCandidates, count: 5,
      search: async () => [
        ranked('A current filing rule changes the review sequence', 'filing sequence', true),
        ranked('A recent reporting update changes reconciliation timing', 'reporting deadline', true),
      ],
    });
    assert.equal(result.selected.filter((candidate) => candidate.provenance === FALLBACK_PROVENANCE.STRATEGY_IDEA).length, 4);
    assert.equal(result.selected.filter((candidate) => candidate.provenance === FALLBACK_PROVENANCE.SEARCH_FILL).length, 1);
  });

  it('never relaxes critical authority, evidence, factual, or platform violations', () => {
    const codes = ['unsupported_personal_claim', 'SOURCE_EVIDENCE_LOSS', 'factual_safety', 'hard_platform_limit'];
    for (const code of codes) {
      assert.deepEqual(filterBlockingIssues([{ code, severity: 'error' }], 99).map((issue) => issue.code), [code]);
      assert.equal(canForceAcceptBlockingCodes([code]), false);
    }
  });

  it('retains the best usable candidate through later fallback attempts', () => {
    const pool = new SlotCandidatePool();
    const best = pool.add(observation('initial_draft', 86));
    pool.add(observation('late_retry', 52, [{ code: 'insufficient_specificity', severity: 'error' }]));
    assert.equal(pool.best(), best);
  });

  it('detects memory persistence failure and leaves the operation safely retryable', async () => {
    const committed: string[] = [];
    const runner: GeneratedPostTransactionRunner = {
      $transaction: async (operation) => {
        const staged: string[] = [];
        try {
          const result = await operation({ stage: (value: string) => staged.push(value) } as never);
          committed.push(...staged);
          return result;
        } catch (error) {
          throw error;
        }
      },
    };
    await assert.rejects(
      persistGeneratedPostWithMemory(runner, async (tx) => {
        (tx as unknown as { stage: (value: string) => void }).stage('post-created-inside-transaction');
        throw new Error('fingerprint write failed');
      }, { userId: 'u' }),
      (error: unknown) => error instanceof GeneratedPostMemoryPersistenceError && error.recoverable,
    );
    assert.deepEqual(committed, []);
  });

  it('completes through a bounded deterministic fallback when writers return nothing usable', () => {
    const result = buildBoundedSafeWriterFallback({
      plan: {
        trendIndex: 0, sourceTopic: 'Approval ownership', angle: 'product_lesson', hookStyle: 'observation',
        endingStyle: 'natural', layout: 'short_observation', rationale: 'selected upstream',
        centralClaim: 'Explicit exception ownership prevents duplicate approval checks.',
      },
      trend: null,
      author: { description: 'Operations educator', tone: 'Direct', niches: ['Operations'] },
      config: { niches: ['Operations'] },
      acceptedBodies: [],
    });
    assert.ok(result?.ok);
    assert.ok(result?.fallbackProvenance?.includes(FALLBACK_PROVENANCE.EMERGENCY_ACCEPTANCE));
    assert.match(result?.finalized.body ?? '', /Explicit exception ownership/);
  });
});
