import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { NicheExpansionPlan } from './generationTypes';
import { buildFocusedRetryQueries, MAX_QUERIES_PER_ATTEMPT, MIN_EXECUTABLE_QUERIES_PER_NICHE, MIN_RETRY_EXECUTABLE_QUERIES, validatePlanQueries } from './trendOrchestrationService';
import { buildFallbackExpansionPlan, buildNicheProfileFingerprintInput, buildProfileGroundedQueries, fingerprintNicheProfileInput, NicheExpansionService, repairExpansionQuery, sanitizeExpansionPlan, validateExpansionQuery } from './nicheExpansionService';
import { prisma } from '../prismaClient';
import { NICHE_ALIAS_GENERATION_VERSION, NICHE_PROFILE_SCHEMA_VERSION, NICHE_QUERY_GENERATION_VERSION } from '../config/topicDiversityConfig';

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
    const inputFingerprint = fingerprintNicheProfileInput(buildNicheProfileFingerprintInput('Accounting'));
    let generated = 0;
    delegate.findUnique = async () => ({
      niche: 'accounting', domain: cached.domain, confidence: cached.confidence,
      subtopics: cached.subtopics, queries: { items: cached.queries, profile: cached },
      exclusions: cached.exclusions, version: cached.version, generatedAt: new Date(),
      schemaVersion: NICHE_PROFILE_SCHEMA_VERSION, queryGenerationVersion: NICHE_QUERY_GENERATION_VERSION,
      aliasGenerationVersion: NICHE_ALIAS_GENERATION_VERSION, inputFingerprint,
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

  it('fingerprints every material niche input deterministically', () => {
    const base = buildNicheProfileFingerprintInput('AI Automation');
    const fingerprint = fingerprintNicheProfileInput(base);
    assert.equal(fingerprint, fingerprintNicheProfileInput({ ...base, scopedMonitoredTopics: [...base.scopedMonitoredTopics].reverse() }));
    for (const changed of [
      { ...base, activePillarName: 'Agentic Automation' },
      { ...base, activePillarTrendKeywords: ['workflow agents'] },
      { ...base, scopedMonitoredTopics: ['UiPath'] },
      { ...base, scopedAvoidedTopics: ['spam'] },
      { ...base, aliasGenerationVersion: base.aliasGenerationVersion + 1 },
      { ...base, queryGenerationVersion: base.queryGenerationVersion + 1 },
    ]) assert.notEqual(fingerprintNicheProfileInput(changed), fingerprint);
    assert.notEqual(fingerprintNicheProfileInput(buildNicheProfileFingerprintInput('Web Development')), fingerprint);
  });

  it('regenerates a legacy row without a fingerprint and persists the replacement', async () => {
    const cached = { ...buildFallbackExpansionPlan('Accounting'), confidence: 0.9 };
    const delegate = prisma.userNicheSearchPlan as any;
    const originalFind = delegate.findUnique;
    const originalUpsert = delegate.upsert;
    let saved: any;
    delegate.findUnique = async () => ({ niche: 'accounting', domain: cached.domain, confidence: cached.confidence, subtopics: cached.subtopics, queries: { items: cached.queries, profile: cached }, exclusions: cached.exclusions, version: cached.version, schemaVersion: 1, queryGenerationVersion: 1, aliasGenerationVersion: 1, inputFingerprint: null, generatedAt: new Date() });
    delegate.upsert = async (args: any) => { saved = args; return args.create; };
    try {
      const service = new NicheExpansionService(null);
      (service as any).generatePlanWithAI = async () => cached;
      const result = await service.getOrCreatePlan('legacy-user', 'Accounting');
      assert.ok(result.inputFingerprint);
      assert.equal(saved.update.inputFingerprint, result.inputFingerprint);
    } finally {
      delegate.findUnique = originalFind;
      delegate.upsert = originalUpsert;
    }
  });

  it('executes all three remaining retry queries without requiring four', () => {
    const initial = [...plan().queries, 'Web standards compliance study'];
    const queries = buildFocusedRetryQueries('Web Development', plan({ queries: [...initial, 'Web standards policy report', 'Browser adoption survey', 'Frontend tooling benchmark'] }), 1);

    assert.equal(queries.length, 3);
    assert.deepEqual(queries, ['Web standards policy report', 'Browser adoption survey', 'Frontend tooling benchmark']);
    assert.ok(queries.every((query) => !/audience growth|practitioner perspectives|research and evidence/i.test(query)));
  });

  it('allows retry batches of one, two, or three executable queries', () => {
    for (const remaining of [1, 2, 3]) {
      const initial = [...plan().queries, 'Web standards compliance study'];
      const queries = [...initial.slice(0, MAX_QUERIES_PER_ATTEMPT), ...Array.from({ length: remaining }, (_, i) => `Web platform unique report ${i}`)];
      assert.equal(buildFocusedRetryQueries('Web Development', plan({ queries }), 1).length, remaining);
    }
    assert.equal(MIN_RETRY_EXECUTABLE_QUERIES, 1);
  });

  it('uses only sanitized pillar queries supplied by strategy expansion', () => {
    const queries = buildFocusedRetryQueries(
      'Web Development',
      plan({ queries: [...plan().queries, 'Web standards compliance study', 'browser performance release report'] }),
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

  it('recognizes scoped AI Automation entities without leaking them into other niches', () => {
    const aiProfile = {
      ...buildFallbackExpansionPlan('AI Automation'), version: 4,
      importantEntities: ['UiPath', 'Blue Prism', 'Automation Anywhere', 'Azure AI'],
      entityAliases: ['RPA', 'robotic process automation'],
      productsAndPlatforms: ['Microsoft Power Automate'], requiredContextTerms: ['AI Automation'],
    };
    for (const query of ['UiPath release update', 'Blue Prism implementation case study', 'Automation Anywhere benchmark study', 'RPA implementation challenges report', 'Azure AI workflow automation adoption report']) {
      assert.equal(validateExpansionQuery(query, aiProfile.niche, aiProfile.subtopics, [], aiProfile).valid, true, query);
      const web = buildFallbackExpansionPlan('Web Development');
      assert.equal(validateExpansionQuery(query, web.niche, web.subtopics, [], web).valid, false, `leaked: ${query}`);
    }
  });

  it('repairs queries while preserving the entity and discovery intent and avoiding used repairs', () => {
    const profile = {
      ...buildFallbackExpansionPlan('AI Automation'),
      importantEntities: ['UiPath', 'Blue Prism'], requiredContextTerms: ['AI Automation'],
    };
    const repaired = repairExpansionQuery('UiPath release update business process', ['insufficient_niche_context'], profile, 1);
    assert.ok(repaired?.includes('UiPath'));
    assert.ok(repaired?.includes('release update'));
    assert.equal(validateExpansionQuery(repaired!, profile.niche, profile.subtopics, [], profile).valid, true);
    const rotated = repairExpansionQuery('UiPath release update business process', ['insufficient_niche_context'], profile, 1, [repaired!]);
    assert.notEqual(rotated, repaired);
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
