import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { NicheExpansionPlan } from './generationTypes';
import { buildBatchDiscoveryPlan, buildNicheSourcePlan, buildSourceQueryRequests, evidenceRoleForSource, parseTrendSourceConfig, resolveAutomaticProviderJobs, resolveSourceAvailability } from './trendSourcePlanningService';
import { TrendsService, buildProviderRequestKey, calculateProviderResultLimit, parseTrendSources } from './trendsService';

const active = (niche: string, text: string, searchIntent: any = 'recent_development') => [{
  text, niche, queryOrigin: 'profile', searchIntent, validationConfidence: 0.91, profileFingerprint: 'fp-1',
}];

function profile(niche: string, entity: string, category: string, problem: string, domain: string): NicheExpansionPlan {
  return {
    niche, normalizedNiche: niche, domain: niche, confidence: 0.9, subtopics: [category],
    queries: [`${niche} release update`, `${niche} benchmark study`, `${niche} case study`, `${niche} policy update`], exclusions: [],
    importantEntities: [entity], commonProblems: [problem], audienceTypes: [`${niche} practitioners`],
    contentCategories: [{ id: 'category', label: category, terms: [category] }],
    sourcePlan: {
      officialEntities: [entity], officialDomains: [domain], regulatorsAndAssociations: [], researchSources: [{ name: `${niche} Research`, domain, sourceType: 'specialist' }],
      specialistPublications: [], communitySources: [`${niche} community`], relevantSubreddits: [niche.replace(/\s/g, '')], questionSources: ['quora'], excludedDomains: [], confidence: 0.9,
    },
  };
}

describe('intent-based source planning', () => {
  it('routes discovery intents to source-specific providers and wording', () => {
    const plan = profile('Pet Care', 'Veterinary Association', 'Veterinary nutrition', 'unsafe feeding advice', 'vet.example.org');
    const requests = buildSourceQueryRequests(plan, buildBatchDiscoveryPlan(7), { mode: 'automatic', enabled: [] }, active(plan.niche, 'pet nutrition safety update'));
    assert.ok(requests.some((item) => item.intent === 'recent_development' && item.source === 'google'));
    assert.ok(requests.some((item) => item.intent === 'recent_development' && item.source === 'official'));
    assert.ok(requests.every((item) => item.providerQuery.includes('pet nutrition safety update')));
  });

  it('builds distinct domain-neutral source plans across required niches', () => {
    const inputs = [
      ['AI Automation', 'Automation Guild', 'Workflow orchestration', 'unreliable workflows', 'automation.example'],
      ['Web Development', 'Web Standards Group', 'Web performance', 'slow pages', 'web.example'],
      ['Unity Game Development', 'Game Engine Association', 'Game rendering', 'frame drops', 'games.example'],
      ['Pet Care', 'Veterinary Association', 'Pet nutrition', 'unsafe diets', 'pets.example'],
      ['Real Estate', 'Property Council', 'Housing finance', 'mortgage access', 'property.example'],
      ['Accounting', 'Accounting Board', 'Financial reporting', 'filing errors', 'accounting.example'],
    ];
    const fingerprints = inputs.map(([niche, entity, category, problem, domain]) => {
      const sourcePlan = buildNicheSourcePlan(profile(niche, entity, category, problem, domain));
      const requests = buildSourceQueryRequests(profile(niche, entity, category, problem, domain), buildBatchDiscoveryPlan(7), { mode: 'automatic', enabled: [] }, active(niche, `${niche} current update`));
      assert.ok(sourcePlan.officialEntities.includes(entity));
      assert.ok(sourcePlan.officialDomains.includes(domain));
      assert.ok(sourcePlan.communitySources.length > 0);
      return JSON.stringify({ sourcePlan, queries: requests.map((item) => item.query) });
    });
    assert.equal(new Set(fingerprints).size, inputs.length);
  });

  it('forces automatic mode and ignores legacy source arrays', () => {
    assert.deepEqual(parseTrendSourceConfig('["google","medium"]'), { mode: 'automatic', enabled: [] });
    assert.deepEqual(parseTrendSourceConfig('["automatic"]'), { mode: 'automatic', enabled: [] });
    assert.deepEqual(parseTrendSources('["google"]'), ['automatic']);
  });

  it('assigns evidence authority without treating communities as verification', () => {
    assert.equal(evidenceRoleForSource('official'), 'primary');
    assert.equal(evidenceRoleForSource('reddit'), 'problem_discovery');
    assert.equal(evidenceRoleForSource('quora'), 'question_discovery');
    assert.equal(evidenceRoleForSource('medium'), 'practitioner');
  });

  it('falls back to operational providers when web and Reddit are unavailable', () => {
    const plan = profile('AI Automation', 'Automation Guild', 'Workflow automation', 'workflow failures', 'automation.example');
    const resolution = resolveAutomaticProviderJobs(plan, buildBatchDiscoveryPlan(7), active(plan.niche, 'workflow automation failures', 'practical_implication'), {});
    assert.deepEqual(resolveSourceAvailability(plan, {}).operationalSources.sort(), ['google', 'linkedin', 'medium', 'official', 'quora'].sort());
    assert.ok(resolution.unavailableSources.some((item) => item.source === 'web' && item.reason === 'web_search_not_configured'));
    assert.ok(resolution.unavailableSources.some((item) => item.source === 'reddit' && item.reason === 'reddit_oauth_not_configured'));
    assert.ok(resolution.jobs.some((job) => job.source === 'linkedin'));
    assert.ok(resolution.jobs.length > 1);
    assert.equal(resolution.intentsWithoutJobs.length, 0);
  });

  it('uses a rotated retry query as the provider subject and never an intent template', () => {
    const plan = profile('Pet Care', 'Veterinary Association', 'Pet nutrition', 'unsafe diets', 'pets.example');
    const rotated = 'senior dog protein guidance 2026';
    const jobs = resolveAutomaticProviderJobs(plan, buildBatchDiscoveryPlan(7), active(plan.niche, rotated, 'official_update'), {}).jobs;
    assert.ok(jobs.length > 0);
    assert.ok(jobs.every((job) => job.originalQuery === rotated && job.providerQuery.includes(rotated)));
    assert.ok(jobs.every((job) => !job.providerQuery.includes('official guidance update')));
  });

  it('appends official, Quora, and LinkedIn restrictions without replacing the query', () => {
    const plan = profile('AI Automation', 'Automation Guild', 'Workflow automation', 'workflow failures', 'automation.example');
    const query = 'agent workflow recovery patterns';
    const official = buildSourceQueryRequests(plan, buildBatchDiscoveryPlan(7), { mode: 'automatic', enabled: [] }, active(plan.niche, query, 'official_update')).find((job) => job.source === 'official');
    const community = buildSourceQueryRequests(plan, buildBatchDiscoveryPlan(7), { mode: 'automatic', enabled: [] }, active(plan.niche, query, 'practical_implication'));
    assert.equal(official?.providerQuery, `${query} site:automation.example`);
    assert.equal(community.find((job) => job.source === 'linkedin')?.providerQuery, `${query} site:linkedin.com`);
    const quora = buildSourceQueryRequests(plan, buildBatchDiscoveryPlan(7), { mode: 'automatic', enabled: [] }, active(plan.niche, query, 'audience_question')).find((job) => job.source === 'quora');
    assert.equal(quora?.providerQuery, `${query} site:quora.com`);
  });

  it('keys exhaustion from the exact executed provider query', () => {
    const common = { niche: 'Pet Care', source: 'google', freshness: '30d', intent: 'recent_development' as const };
    const first = buildProviderRequestKey({ ...common, providerQuery: 'senior dog nutrition when:30d' });
    const retry = buildProviderRequestKey({ ...common, providerQuery: 'canine protein research when:30d' });
    assert.notEqual(first, retry);
    assert.equal(first, buildProviderRequestKey({ ...common, providerQuery: '  Senior Dog Nutrition   when:30d ' }));
  });

  it('raises provider result limits as the deficit is spread across fewer jobs', () => {
    assert.equal(calculateProviderResultLimit(20, 10), 5);
    assert.equal(calculateProviderResultLimit(20, 3), 7);
    assert.equal(calculateProviderResultLimit(20, 1), 10);
  });

  it('accumulates results from multiple automatic providers', async () => {
    const plan = profile('Web Development', 'Web Standards Group', 'Web performance', 'slow pages', 'web.example');
    const service = new TrendsService();
    (service as any).fetchFromSource = async ({ source, query, discoveryIntent, evidenceRole }: any) => [{
      title: `${source} result for ${query}`, link: `https://${source}.example/${encodeURIComponent(query)}`,
      pubDate: new Date().toISOString(), source, publisher: source, discoverySource: source,
      searchQuery: query, discoveryIntent, evidenceRole,
    }];
    const results = await service.fetchGenerationTrends({ niche: plan.niche, expansionPlan: plan, sources: ['google'], requestedCount: 7 });
    assert.ok(new Set(results.map((item) => item.source)).size > 1);
    assert.ok(results.some((item) => item.source === 'google'));
    assert.ok(results.some((item) => item.source === 'quora'));
    assert.ok(results.some((item) => item.source === 'official'));
  });
});
