import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildEffectiveBotStrategy } from './botStrategyService';
import {
  buildStrategyExpansionPlan,
  buildStrategyTrendSeeds,
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
