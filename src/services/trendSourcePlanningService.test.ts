import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { NicheExpansionPlan } from './generationTypes';
import { buildBatchDiscoveryPlan, buildNicheSourcePlan, buildSourceQueryRequests, evidenceRoleForSource, parseTrendSourceConfig, resolveAutomaticProviderJobs, resolveSourceAvailability } from './trendSourcePlanningService';
import { TrendsService, parseTrendSources } from './trendsService';

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
    const requests = buildSourceQueryRequests(plan, buildBatchDiscoveryPlan(7), { mode: 'automatic', enabled: [] });
    assert.ok(requests.some((item) => item.intent === 'recent_development' && item.source === 'google'));
    assert.ok(requests.some((item) => item.intent === 'recent_development' && item.source === 'official'));
    assert.ok(requests.some((item) => item.intent === 'recurring_problem' && item.source === 'reddit'));
    assert.ok(requests.some((item) => item.intent === 'verified_solution' && item.source === 'official'));
    assert.ok(requests.some((item) => item.intent === 'beginner_guidance' && item.source === 'quora'));
    const byIntent = new Map(requests.map((item) => [`${item.intent}:${item.source}`, item.query]));
    assert.notEqual(byIntent.get('recent_development:google'), byIntent.get('recurring_problem:reddit'));
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
      const requests = buildSourceQueryRequests(profile(niche, entity, category, problem, domain), buildBatchDiscoveryPlan(7), { mode: 'automatic', enabled: [] });
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
    const resolution = resolveAutomaticProviderJobs(plan, buildBatchDiscoveryPlan(7), {});
    assert.deepEqual(resolveSourceAvailability(plan, {}).operationalSources.sort(), ['google', 'linkedin', 'medium', 'official', 'quora'].sort());
    assert.ok(resolution.unavailableSources.some((item) => item.source === 'web' && item.reason === 'web_search_not_configured'));
    assert.ok(resolution.unavailableSources.some((item) => item.source === 'reddit' && item.reason === 'reddit_oauth_not_configured'));
    for (const source of ['google', 'medium', 'linkedin', 'quora']) assert.ok(resolution.jobs.some((job) => job.source === source), source);
    assert.ok(resolution.jobs.length > 1);
    assert.equal(resolution.intentsWithoutJobs.length, 0);
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
    assert.ok(results.some((item) => item.source === 'medium'));
    assert.ok(results.some((item) => item.source === 'quora'));
    assert.ok(results.some((item) => item.source === 'linkedin'));
  });
});
