import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { NicheExpansionPlan } from './generationTypes';
import { buildFocusedRetryQueries, MIN_EXECUTABLE_QUERIES_PER_NICHE, validatePlanQueries } from './trendOrchestrationService';
import { buildFallbackExpansionPlan, buildProfileGroundedQueries, NicheExpansionService, sanitizeExpansionPlan, validateExpansionQuery } from './nicheExpansionService';
import { prisma } from '../prismaClient';

function plan(overrides: Partial<NicheExpansionPlan> = {}): NicheExpansionPlan {
  return {
    niche: 'Web Development',
    domain: 'Web Development',
    confidence: 0.85,
    subtopics: ['Web Development', 'React performance', 'for Indie Game Devs'],
    queries: [
      'Web rendering performance browser benchmarks',
      'Web accessibility standards implementation',
      'Browser API compatibility changes',
      'Web application security research',
      'Frontend performance case study',
      'Web platform standards update',
      'Browser developer tooling release',
    ],
    exclusions: [],
    generatedAt: new Date(),
    ...overrides,
  };
}

describe('generation retry query targeting', () => {
  it('builds validator-compatible queries without forbidden generic phrases', () => {
    for (const niche of ['AI Automation', 'Web Development', 'Unity Game Development', 'Pet Care', 'Real Estate', 'Accounting']) {
      const profile = buildFallbackExpansionPlan(niche);
      const generated = buildProfileGroundedQueries(profile);
      assert.ok(generated.length >= MIN_EXECUTABLE_QUERIES_PER_NICHE, niche);
      assert.ok(generated.every((query) => !/audience growth|methods practice innovation|organizations institutions developments|notable announcement/i.test(query)), niche);
      const validation = validatePlanQueries({ ...profile, queries: generated, queryBuckets: undefined });
      assert.ok(validation.executable.length >= MIN_EXECUTABLE_QUERIES_PER_NICHE, `${niche}: ${JSON.stringify(validation.rejected)}`);
    }
  });

  it('repairs invalid generated queries before sanitizing the pool', () => {
    const profile = buildFallbackExpansionPlan('Pet Care');
    const repaired = sanitizeExpansionPlan({
      ...profile,
      queries: ['Pet Care audience growth', 'Pet Care methods practice innovation'],
      queryBuckets: undefined,
    });
    assert.ok(repaired.queries.length >= MIN_EXECUTABLE_QUERIES_PER_NICHE);
    assert.ok(repaired.queries.every((query) => validateExpansionQuery(query, repaired.niche, repaired.subtopics, [], repaired).valid));
  });

  it('reuses an unchanged cached profile with at least four executable queries', async () => {
    const cached = { ...buildFallbackExpansionPlan('Accounting'), confidence: 0.9 };
    const delegate = prisma.userNicheSearchPlan as any;
    const originalFind = delegate.findUnique;
    const originalUpsert = delegate.upsert;
    let generated = 0;
    delegate.findUnique = async () => ({
      niche: 'accounting', domain: cached.domain, confidence: cached.confidence,
      subtopics: cached.subtopics, queries: { items: cached.queries, profile: cached },
      exclusions: cached.exclusions, version: cached.version, generatedAt: new Date(),
    });
    delegate.upsert = async () => { throw new Error('cache should not be rewritten'); };
    try {
      const service = new NicheExpansionService(null);
      (service as any).generatePlanWithAI = async () => { generated++; return cached; };
      const first = await service.getOrCreatePlan('user-cache-test', 'Accounting');
      const second = await service.getOrCreatePlan('user-cache-test', 'Accounting');
      assert.equal(first.inputFingerprint, second.inputFingerprint);
      assert.equal(generated, 0);
    } finally {
      delegate.findUnique = originalFind;
      delegate.upsert = originalUpsert;
    }
  });

  it('rotates profile queries without synthesizing generic suffixes', () => {
    const queries = buildFocusedRetryQueries('Web Development', plan(), 2);

    assert.equal(queries.length, 3);
    assert.deepEqual(queries, plan().queries.slice(4, 7));
    assert.ok(queries.every((query) => !/audience growth|practitioner perspectives|research and evidence/i.test(query)));
  });

  it('uses only sanitized pillar queries supplied by strategy expansion', () => {
    const queries = buildFocusedRetryQueries(
      'Web Development',
      plan({ queries: ['Web Development', 'browser performance'] }),
      1,
    );

    assert.ok(queries.some((query) => query.includes('browser performance')));
    assert.ok(queries.every((query) => !query.includes('best practices')));
    assert.ok(queries.every((query) => !query.includes('Indie Game Devs')));
  });

  it('stops retrying when no unused profile query remains', () => {
    const queries = buildFocusedRetryQueries(
      'AI Automation',
      plan({ niche: 'AI Automation', domain: 'AI Automation', queries: ['AI Automation'] }),
      3,
    );

    assert.deepEqual(queries, []);
  });

  it('does not invent fallback vocabulary for a non-technology niche', () => {
    const queries = buildFocusedRetryQueries(
      'Early Childhood Education',
      plan({
        niche: 'Early Childhood Education',
        domain: 'Early Childhood Education',
        queries: ['Early Childhood Education'],
      }),
      2,
    );

    assert.deepEqual(queries, []);
  });

  it('does not add retry queries during the initial search pass', () => {
    assert.deepEqual(buildFocusedRetryQueries('Web Development', plan(), 0), []);
  });

  it('validates ambiguous queries against profile context and exclusions', () => {
    const profile = plan({
      niche: 'Python Development',
      requiredContextTerms: ['python', 'developer'],
      excludedTerms: ['snake', 'reptile'],
    });
    assert.equal(validateExpansionQuery('Python developer packaging update', profile.niche, profile.subtopics, [], profile).valid, true);
    assert.equal(validateExpansionQuery('Python snake habitat news', profile.niche, profile.subtopics, [], profile).valid, false);
  });

  it('rejects near-duplicate queries across any niche', () => {
    const check = validateExpansionQuery(
      'Pet Care veterinary nutrition research update',
      'Pet Care',
      ['veterinary nutrition'],
      ['Pet Care veterinary nutrition research updates'],
    );
    assert.equal(check.valid, false);
    assert.equal(check.reason, 'near_duplicate_query');
  });

  it('rejects the exact generic runtime failures even when the niche is named', () => {
    const profile = buildFallbackExpansionPlan('Web Development');
    for (const query of [
      '"Web Development" notable announcement update',
      '"Web Development" organizations institutions developments',
      '"Web Development" methods practice innovation',
      'Web Development audience growth',
    ]) {
      assert.equal(validateExpansionQuery(query, profile.niche, profile.subtopics, [], profile).valid, false, query);
    }
  });
});
