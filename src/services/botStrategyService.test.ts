import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildEffectiveBotStrategy,
  resolveOnboardingStatus,
  syncPrimaryPillarsToNiches,
} from './botStrategyService';
import { buildAuthorBlock } from './ghostwriterPrompts';

describe('bot strategy config', () => {
  it('replaces stale primary pillars when the niche list changes', () => {
    const current = buildEffectiveBotStrategy({
      niches: JSON.stringify(['Old niche']),
      contentPillars: {
        primaryPillars: [{
          name: 'Old niche',
          description: 'Stale',
          audienceRelevance: 'Old audience',
          exampleAngles: ['Old angle'],
          trendKeywords: ['old keyword'],
        }],
      },
    }).contentPillars;

    const synced = syncPrimaryPillarsToNiches(current, ['New niche']);
    assert.deepEqual(synced.primaryPillars.map((pillar) => pillar.name), ['New niche']);
    assert.ok(!synced.primaryPillars.some((pillar) => pillar.name === 'Old niche'));
  });

  it('retains pillar metadata when a niche name is unchanged', () => {
    const current = buildEffectiveBotStrategy({ niches: JSON.stringify(['SaaS']) }).contentPillars;
    current.primaryPillars[0].exampleAngles = ['Activation teardown'];
    const synced = syncPrimaryPillarsToNiches(current, [' SaaS ']);
    assert.deepEqual(synced.primaryPillars[0].exampleAngles, ['Activation teardown']);
  });

  it('derives a valid effective strategy from legacy-only bot config', () => {
    const strategy = buildEffectiveBotStrategy({
      description: 'I help SaaS founders improve activation.',
      tone: 'Direct',
      niches: JSON.stringify(['SaaS onboarding', 'activation']),
      sources: JSON.stringify(['google']),
    });

    assert.equal(
      strategy.profilePositioning.positioningStatement,
      'I help SaaS founders improve activation.',
    );
    assert.deepEqual(strategy.writingStyle.tone, ['Direct']);
    assert.deepEqual(
      strategy.contentPillars.primaryPillars.map((pillar) => pillar.name),
      ['SaaS onboarding', 'activation'],
    );
    assert.equal(strategy.targetAudience.knowledgeLevel, 'intermediate');
    assert.equal(strategy.contentGoals.primaryGoal, 'authority');
    assert.equal(strategy.topicRules.minimumRelevanceScore, 65);
    assert.deepEqual(strategy.legacy.niches, ['SaaS onboarding', 'activation']);
    assert.deepEqual(strategy.legacy.sources, ['google']);
    assert.equal(strategy.legacy.description, 'I help SaaS founders improve activation.');
  });

  it('merges partial new config with safe defaults', () => {
    const strategy = buildEffectiveBotStrategy({
      description: 'Legacy positioning',
      tone: 'Thoughtful',
      niches: JSON.stringify(['CRM']),
      targetAudience: {
        primaryAudience: 'B2B founders',
      },
      writingStyle: {
        formality: 'balanced',
      },
    });

    assert.equal(strategy.targetAudience.primaryAudience, 'B2B founders');
    assert.deepEqual(strategy.targetAudience.roles, []);
    assert.equal(strategy.targetAudience.knowledgeLevel, 'intermediate');
    assert.equal(strategy.writingStyle.formality, 'balanced');
    assert.deepEqual(strategy.writingStyle.tone, ['Thoughtful']);
  });

  it('returns complete new config unchanged except normalization', () => {
    const strategy = buildEffectiveBotStrategy({
      description: 'Legacy positioning',
      tone: 'Legacy',
      niches: JSON.stringify(['Legacy niche']),
      profilePositioning: {
        role: 'Founder',
        companyOrProduct: 'Acme',
        positioningStatement: 'I build practical AI workflows.',
        credibilityPoints: ['Built three workflow products'],
        uniquePointOfView: 'Automate the boring edge cases first.',
        topicsToBeKnownFor: ['AI workflows'],
      },
      targetAudience: {
        primaryAudience: 'Operations leaders',
        secondaryAudiences: ['Founders'],
        roles: ['COO'],
        industries: ['SaaS'],
        companyStage: ['Series A'],
        painPoints: ['Manual follow-up'],
        desiredOutcomes: ['Reliable pipeline'],
        objectionsOrMisbeliefs: ['Automation is too brittle'],
        knowledgeLevel: 'expert',
      },
      contentGoals: {
        primaryGoal: 'leads',
        secondaryGoals: ['education'],
        conversionTarget: 'Book a call',
        preferredCTAStyle: 'direct',
      },
      contentPillars: {
        primaryPillars: [
          {
            name: 'Workflow design',
            description: 'Practical system design',
            audienceRelevance: 'Helps teams scale operations',
            exampleAngles: ['Audit handoffs'],
            trendKeywords: ['workflow automation'],
          },
        ],
        secondaryPillars: [],
        experimentalPillars: [],
        excludedTopics: ['crypto'],
      },
      topicRules: {
        minimumRelevanceScore: 80,
        requireAudiencePainMatch: true,
        requirePillarMatch: true,
        avoidDuplicateAngles: true,
        avoidRecentTopicsDays: 45,
        rejectedPatterns: ['generic AI hype'],
      },
      writingStyle: {
        tone: ['sharp', 'practical'],
        formality: 'professional',
        postLength: 'medium',
        preferredFormats: ['checklist'],
        avoidStyles: ['fluffy'],
        examplePosts: ['Here is an example post.'],
      },
    });

    assert.equal(strategy.profilePositioning.role, 'Founder');
    assert.equal(strategy.targetAudience.knowledgeLevel, 'expert');
    assert.equal(strategy.contentGoals.primaryGoal, 'leads');
    assert.equal(strategy.contentPillars.primaryPillars[0].trendKeywords[0], 'workflow automation');
    assert.equal(strategy.topicRules.minimumRelevanceScore, 80);
    assert.deepEqual(strategy.writingStyle.tone, ['sharp', 'practical']);
  });

  it('resolves onboarding status from persisted strategy fields', () => {
    assert.equal(resolveOnboardingStatus(false), 'LEGACY');
    assert.equal(resolveOnboardingStatus(true), 'COMPLETE');
  });

  it('bot config route preserves existing media/contact fields when only strategy fields are saved', () => {
    const source = readFileSync(join(process.cwd(), 'src/routes/botConfig.ts'), 'utf8');

    assert.match(source, /\.\.\.\(hasBrandLogoUrl \? \{ brandLogoUrl: normalizedBrandLogoUrl \} : \{\}\)/);
    assert.match(source, /\.\.\.\(hasBrandLogoEnabled \? \{ brandLogoEnabled \} : \{\}\)/);
    assert.match(source, /\.\.\.\(hasBackgroundImageUrl \? \{ backgroundImageUrl: normalizedBackgroundImageUrl \} : \{\}\)/);
    assert.match(source, /\.\.\.\(hasContactInfo \? \{ contactInfo: cleanedContactInfo \} : \{\}\)/);
    assert.match(source, /\.\.\.\(hasWebsiteUrl \? \{ websiteUrl: normalizedWebsiteUrl \} : \{\}\)/);
  });

  it('effective strategy handles null strategy fields used by existing generation flows', () => {
    const strategy = buildEffectiveBotStrategy({
        description: '',
        tone: null,
        niches: '[]',
        sources: '["google"]',
        profilePositioning: null,
        targetAudience: null,
        contentGoals: null,
        contentPillars: null,
        topicRules: null,
        writingStyle: null,
    });

    assert.equal(strategy.profilePositioning.positioningStatement, '');
    assert.deepEqual(strategy.legacy.sources, ['google']);
    assert.deepEqual(strategy.contentPillars.primaryPillars, []);
  });

  it('author prompt includes strategy positioning, audience, goals, pillars, and style', () => {
    const strategy = buildEffectiveBotStrategy({
      description: 'Legacy description',
      tone: 'Direct',
      niches: JSON.stringify(['SaaS']),
      profilePositioning: {
        positioningStatement: 'I help founders fix activation with better onboarding systems.',
        uniquePointOfView: 'Activation problems are usually handoff problems.',
      },
      targetAudience: {
        primaryAudience: 'B2B SaaS founders',
        painPoints: ['onboarding drop-off'],
      },
      contentGoals: {
        primaryGoal: 'education',
      },
      contentPillars: {
        primaryPillars: [
          {
            name: 'Activation systems',
            trendKeywords: ['user onboarding'],
          },
        ],
      },
      writingStyle: {
        tone: ['practical'],
        formality: 'balanced',
      },
    });

    const prompt = buildAuthorBlock({
      description: strategy.profilePositioning.positioningStatement,
      tone: strategy.writingStyle.tone[0],
      niches: ['Activation systems'],
      strategy,
    });

    assert.match(prompt, /STRATEGY CONTEXT/);
    assert.match(prompt, /B2B SaaS founders/);
    assert.match(prompt, /onboarding drop-off/);
    assert.match(prompt, /education/);
    assert.match(prompt, /Activation systems/);
    assert.match(prompt, /practical/);
    assert.match(prompt, /Do not write generic niche commentary/);
    assert.match(prompt, /Topic clarity/);
    assert.match(prompt, /Clear niche match/);
    assert.match(prompt, /Do not include \*\*/);
  });

  it('generated post rewrite path forwards strategy context into rewritePost', () => {
    const contentService = readFileSync(join(process.cwd(), 'src/services/contentService.ts'), 'utf8');
    const postsRoute = readFileSync(join(process.cwd(), 'src/routes/posts.ts'), 'utf8');

    assert.match(contentService, /strategy\?: AuthorContext\['strategy'\]/);
    assert.match(contentService, /const author: AuthorContext = \{ description, tone, strategy \}/);
    assert.match(postsRoute, /voice\.strategy/);
  });
});
