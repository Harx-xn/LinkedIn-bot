import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildEffectiveBotStrategy } from './botStrategyService';
import {
  buildStrategyExpansionPlan,
  buildStrategyTrendSeeds,
  isUsefulTrendKeyword,
  scoreTrendForStrategy,
} from './botStrategyTrendService';

const strategy = buildEffectiveBotStrategy({
  description: 'I help SaaS founders build reliable onboarding systems.',
  tone: 'Practical',
  niches: JSON.stringify(['legacy SaaS']),
  contentPillars: {
    primaryPillars: [
      {
        name: 'Activation systems',
        description: 'Onboarding and product activation',
        audienceRelevance: 'Helps founders reduce onboarding drop-off',
        exampleAngles: ['Audit the first-week handoff'],
        trendKeywords: ['user onboarding', 'activation analytics'],
      },
    ],
    secondaryPillars: [
      {
        name: 'Lifecycle messaging',
        description: 'Email and in-app guidance',
        audienceRelevance: 'Helps teams guide stuck users',
        exampleAngles: ['Fix the empty-state message'],
        trendKeywords: ['lifecycle email'],
      },
    ],
    experimentalPillars: [
      {
        name: 'Product AI',
        description: 'AI assistance in SaaS products',
        audienceRelevance: 'Helps founders evaluate AI features',
        exampleAngles: ['Use AI where support tickets repeat'],
        trendKeywords: ['AI product assistant'],
      },
    ],
    excludedTopics: ['crypto'],
  },
  targetAudience: {
    primaryAudience: 'B2B SaaS founders',
    painPoints: ['onboarding drop-off'],
    desiredOutcomes: ['higher activation'],
  },
  contentGoals: {
    primaryGoal: 'education',
  },
  topicRules: {
    minimumRelevanceScore: 60,
    requireAudiencePainMatch: true,
    requirePillarMatch: true,
    avoidDuplicateAngles: true,
    avoidRecentTopicsDays: 30,
  },
});

describe('botStrategyTrendService', () => {
  it('uses pillar trend keywords before legacy niches', () => {
    const seeds = buildStrategyTrendSeeds(strategy);
    assert.deepEqual(
      seeds.slice(0, 3).map((seed) => seed.query),
      ['Activation systems', 'user onboarding', 'activation analytics'],
    );
    assert.equal(seeds.some((seed) => seed.query === 'legacy SaaS'), false);
  });

  it('falls back to legacy niches when strategy pillars are absent', () => {
    const legacy = buildEffectiveBotStrategy({
      description: 'I write about legal operations.',
      tone: 'Direct',
      niches: JSON.stringify(['legal ops']),
    });
    assert.deepEqual(buildStrategyTrendSeeds(legacy).map((seed) => seed.query), ['legal ops']);
  });

  it('builds expansion plans from pillar keywords and exclusions', () => {
    const plan = buildStrategyExpansionPlan(strategy, 'Activation systems');
    assert.ok(plan.queries.includes('user onboarding'));
    assert.ok(plan.queries.includes('activation analytics'));
    assert.ok(plan.exclusions.includes('crypto'));
  });

  it('produces the same strategy fingerprint for unchanged normalized inputs', () => {
    const first = buildStrategyExpansionPlan(strategy, 'Activation systems');
    const second = buildStrategyExpansionPlan(strategy, 'Activation systems');
    assert.equal(first.inputFingerprint, second.inputFingerprint);
  });

  it('removes generic and audience-only terms from strategy search queries', () => {
    const contaminated = buildEffectiveBotStrategy({
      description: 'I write about software engineering for indie game developers.',
      tone: 'Practical',
      niches: JSON.stringify(['Web Development']),
      contentPillars: {
        primaryPillars: [{
          name: 'Web Development',
          description: 'Browser engineering and web application architecture',
          audienceRelevance: 'For indie game developers',
          exampleAngles: ['for Indie Game Devs'],
          trendKeywords: [
            'trends',
            'best practices',
            'for Indie Game Devs',
            'Web Development trends',
            'Web Development best practices',
            'Web Development for Indie Game Devs',
            'browser performance',
          ],
        }],
        secondaryPillars: [],
        experimentalPillars: [],
        excludedTopics: [],
      },
    });

    const plan = buildStrategyExpansionPlan(contaminated, 'Web Development');
    assert.deepEqual(plan.queries, ['browser performance']);
    assert.equal(plan.subtopics.includes('for Indie Game Devs'), true);
    assert.equal(isUsefulTrendKeyword('best practices', 'Web Development'), false);
    assert.equal(isUsefulTrendKeyword('Web Development trends', 'Web Development'), false);
    assert.equal(isUsefulTrendKeyword('Web Development for Indie Game Devs', 'Web Development'), false);
  });

  it('does not let injected niche or search-query labels satisfy strategy relevance', () => {
    const unrelated = scoreTrendForStrategy(
      {
        topic: 'A woodcut-inspired 3D game launches this year',
        niche: 'Activation systems',
        searchQuery: 'Activation systems user onboarding latest news',
      },
      strategy,
    );

    assert.equal(unrelated.accepted, false);
    assert.equal(unrelated.breakdown.pillarMatch, 0);
  });

  it('matches a source headline by the distinctive part of a pillar name', () => {
    const unityStrategy = buildEffectiveBotStrategy({
      description: 'I write about game-engine engineering.',
      tone: 'Technical',
      niches: JSON.stringify(['Unity Game Development']),
      contentPillars: {
        primaryPillars: [{
          name: 'Unity Game Development',
          description: 'Unity engine architecture',
          audienceRelevance: '',
          exampleAngles: [],
          trendKeywords: ['Unity rendering'],
        }],
        secondaryPillars: [],
        experimentalPillars: [],
        excludedTopics: [],
      },
      topicRules: {
        minimumRelevanceScore: 60,
        requirePillarMatch: true,
        requireAudiencePainMatch: false,
        avoidDuplicateAngles: true,
        avoidRecentTopicsDays: 30,
      },
    });
    const result = scoreTrendForStrategy(
      { topic: 'Unity changes its rendering pipeline for mobile games', publishedAt: new Date() },
      unityStrategy,
    );

    assert.equal(result.accepted, true);
    assert.equal(result.matchedPillar, 'Unity Game Development');
  });

  it('applies the same token-overlap rule to arbitrary non-technology pillars', () => {
    const culinaryStrategy = buildEffectiveBotStrategy({
      description: 'I write about culinary operations.',
      tone: 'Practical',
      niches: JSON.stringify(['Sustainable Restaurant Operations']),
      contentPillars: {
        primaryPillars: [{
          name: 'Sustainable Restaurant Operations',
          description: 'Reducing waste in commercial kitchens',
          audienceRelevance: '',
          exampleAngles: [],
          trendKeywords: ['commercial kitchen waste'],
        }],
        secondaryPillars: [],
        experimentalPillars: [],
        excludedTopics: [],
      },
      topicRules: {
        minimumRelevanceScore: 60,
        requirePillarMatch: true,
        requireAudiencePainMatch: false,
        avoidDuplicateAngles: true,
        avoidRecentTopicsDays: 30,
      },
    });
    const result = scoreTrendForStrategy(
      { topic: 'Restaurants adopt sustainable kitchen operations', publishedAt: new Date() },
      culinaryStrategy,
    );

    assert.equal(result.accepted, true);
    assert.equal(result.matchedPillar, 'Sustainable Restaurant Operations');
  });

  it('rejects excluded and low-relevance topics', () => {
    const excluded = scoreTrendForStrategy(
      { topic: 'Crypto launch for user onboarding teams' },
      strategy,
    );
    assert.equal(excluded.accepted, false);
    assert.ok(excluded.riskFlags?.some((flag) => flag.startsWith('excluded:')));

    const unrelated = scoreTrendForStrategy(
      { topic: 'A new restaurant reservation trend' },
      strategy,
    );
    assert.equal(unrelated.accepted, false);
    assert.ok(unrelated.riskFlags?.includes('low_relevance'));
  });

  it('accepts relevant audience and pillar matches with metadata', () => {
    const result = scoreTrendForStrategy(
      {
        topic: 'User onboarding analytics show where B2B SaaS founders lose activation',
        summary: 'The report explains onboarding drop-off and higher activation.',
        publishedAt: new Date(),
      },
      strategy,
    );

    assert.equal(result.accepted, true);
    assert.equal(result.matchedPillar, 'Activation systems');
    assert.equal(result.suggestedAngle, 'Audit the first-week handoff');
    assert.ok(result.score >= 60);
  });

  it('rejects duplicate recent angles from topic history', () => {
    const result = scoreTrendForStrategy(
      {
        topic: 'User onboarding analytics show where B2B SaaS founders lose activation',
        summary: 'The report explains onboarding drop-off and higher activation.',
      },
      strategy,
      {
        recentHistory: [
          {
            id: 'hist_1',
            userId: 'user_1',
            postId: null,
            batchId: null,
            sourceTitle: null,
            normalizedTopic: 'user onboarding analytics show where b2b saas founders lose activation',
            topicCluster: 'activation_systems',
            coreClaim: null,
            angle: null,
            status: 'GENERATED',
            generatedAt: new Date(),
            publishedAt: null,
          },
        ],
      },
    );

    assert.equal(result.accepted, false);
    assert.ok(result.riskFlags?.some((flag) => flag.startsWith('recent_duplicate:')));
  });

  it('scheduled bot uses strategy orchestration without legacy fetch precheck', () => {
    const source = readFileSync(join(process.cwd(), 'src/services/trendingBotService.ts'), 'utf8');
    const runBotStart = source.indexOf('async runBot');
    const generateNowStart = source.indexOf('async generateNow');
    const runBotBody = source.slice(runBotStart, generateNowStart);

    assert.ok(runBotBody.includes('buildTrendPoolForBatch'));
    assert.ok(runBotBody.includes('strategy,'));
    assert.equal(runBotBody.includes('this.trendsService.fetchTrends('), false);
  });
});
