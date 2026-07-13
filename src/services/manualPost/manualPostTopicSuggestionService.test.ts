import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  areNearDuplicateTitles,
  buildFallbackTopicSuggestions,
  finalizeTopicSuggestions,
  isGenericTopicTitle,
  isOutdatedTopic,
  sanitizeTopicSuggestions,
} from './manualPostTopicSuggestionService';
import { buildEffectiveBotStrategy } from '../botStrategyService';

const voiceFixture = {
  tone: 'Professional',
  description: 'I build SaaS products for B2B teams.',
  niches: ['SaaS', 'productivity'],
  websiteUrl: 'https://example.com',
  contactInfo: null,
  includeContactInfo: false,
  includeWebsiteLink: false,
};

describe('manualPostTopicSuggestionService', () => {
  it('flags outdated years', () => {
    const currentYear = new Date().getFullYear();
    assert.equal(isOutdatedTopic('Top Tools for LinkedIn Growth in 2023', currentYear), true);
    assert.equal(isOutdatedTopic(`What changed in SaaS in ${currentYear}`, currentYear), false);
  });

  it('flags generic topic titles', () => {
    assert.equal(isGenericTopicTitle('Leveraging AI for Effective Content Marketing'), true);
    assert.equal(
      isGenericTopicTitle('Why AI-written LinkedIn posts fail when the author voice is missing'),
      false,
    );
  });

  it('removes outdated and generic topics', () => {
    const currentYear = new Date().getFullYear();
    const sanitized = sanitizeTopicSuggestions(
      [
        {
          title: 'Top Tools for LinkedIn Growth in 2023',
          description: 'A stale SEO-style listicle.',
          reason: 'stale',
        },
        {
          title: 'Leveraging AI for Effective Content Marketing',
          description: 'Too generic to be useful.',
          reason: 'generic',
        },
        {
          title: 'Why SaaS onboarding emails fail after the first week',
          description: 'A concrete post angle about onboarding drop-off.',
          reason: 'specific',
        },
      ],
      { currentYear, maxCount: 5 },
    );

    assert.equal(sanitized.length, 1);
    assert.match(sanitized[0].title, /onboarding emails fail/i);
  });

  it('removes near-duplicate titles', () => {
    assert.equal(
      areNearDuplicateTitles(
        'Why SaaS onboarding emails fail after the first week',
        'Why SaaS onboarding emails fail after the first week for new users',
      ),
      true,
    );
  });

  it('fills with niche-based fallbacks when AI output is weak', () => {
    const topics = finalizeTopicSuggestions(
      [
        {
          title: 'Leveraging AI for Effective Content Marketing',
          description: 'Generic',
          reason: 'Generic',
        },
      ],
      voiceFixture,
      ['google', 'reddit'],
      5,
    );

    assert.equal(topics.length, 5);
    assert.ok(topics.every((topic) => !isGenericTopicTitle(topic.title)));
    assert.ok(topics.every((topic) => !isOutdatedTopic(topic.title, new Date().getFullYear())));
  });

  it('builds deterministic fallback topics from niches', () => {
    const fallbacks = buildFallbackTopicSuggestions(voiceFixture, ['google'], 3, 2026);
    assert.equal(fallbacks.length, 3);
    assert.ok(fallbacks[0].title.includes('SaaS'));
    assert.ok(fallbacks[0].description.length > 0);
  });

  it('adds strategy-aware metadata to topic suggestions', () => {
    const strategy = buildEffectiveBotStrategy({
      description: 'I help founders improve activation.',
      tone: 'Direct',
      niches: JSON.stringify(['SaaS']),
      contentPillars: {
        primaryPillars: [
          {
            name: 'Activation systems',
            audienceRelevance: 'Helps founders reduce onboarding drop-off',
            trendKeywords: ['user onboarding'],
            exampleAngles: ['Audit the first-week handoff'],
          },
        ],
      },
      targetAudience: {
        primaryAudience: 'B2B SaaS founders',
        painPoints: ['onboarding drop-off'],
      },
    });

    const topics = finalizeTopicSuggestions(
      [
        {
          title: 'Why user onboarding fails after the first week',
          description: 'A concrete activation systems post for founders.',
          reason: 'Specific and useful.',
        },
      ],
      voiceFixture,
      ['google'],
      1,
      strategy,
    );

    assert.equal(topics[0].matchedPillar, 'Activation systems');
    assert.equal(topics[0].targetAudience, 'B2B SaaS founders');
    assert.equal(topics[0].contentGoal, 'authority');
    assert.equal(typeof topics[0].relevanceScore, 'number');
    assert.ok(topics[0].suggestedAngle);
  });
});
