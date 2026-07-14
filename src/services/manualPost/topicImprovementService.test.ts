import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildEffectiveBotStrategy } from '../botStrategyService';
import { improveWeakTopicSuggestions, parseImprovedTopics, STRONG_TOPIC_SCORE } from './topicImprovementService';
import type { StrategyTrendScore } from '../botStrategyTrendService';

const strategy = buildEffectiveBotStrategy({
  description: 'I help B2B SaaS founders reduce onboarding drop-off.', tone: 'Direct', niches: JSON.stringify(['Activation systems']),
  contentPillars: { primaryPillars: [{ name: 'Activation systems', description: 'Practical onboarding systems', audienceRelevance: 'B2B SaaS founders', trendKeywords: ['onboarding'], exampleAngles: ['Audit the first week'] }] },
  targetAudience: { primaryAudience: 'B2B SaaS founders', desiredOutcomes: ['reduce onboarding drop-off'] }, contentGoals: { primaryGoal: 'authority' },
});

function score(valueForTitle: (title: string) => number) {
  return ((candidate: { topic: string }): StrategyTrendScore => {
    const value = valueForTitle(candidate.topic);
    return { score: value, accepted: value >= STRONG_TOPIC_SCORE, reasons: [], matchedPillar: 'Activation systems', breakdown: { pillarMatch: 25, audienceMatch: value >= 80 ? 35 : 0, goalMatch: 15, positioningMatch: 10, freshness: 4, exclusionPenalty: 0, finalScore: value } };
  }) as any;
}

const weak = { title: 'Automation may introduce vulnerabilities', description: 'Automation can create workflow risks.', reason: 'Timely', sourceUrl: 'https://example.com/source', sourcePlatform: 'news' };
function validOutput() {
  return JSON.stringify({ topics: [{ candidateId: 'candidate-0', title: 'B2B SaaS founders automate onboarding faster than they secure it', summary: 'A practical onboarding workflow risk for B2B SaaS founders.', pillar: 'Activation systems', suggestedAngle: 'Audit three access boundaries before automating the first-week onboarding workflow.', audienceRelevance: 'Helps B2B SaaS founders reduce onboarding drop-off.', whyItFitsGoal: 'Builds authority through a practical audit.', improvementReason: 'Adds specificity and audience relevance.' }] });
}

describe('topicImprovementService', () => {
  it('accepts scores at and above 70 without AI', async () => {
    let calls = 0;
    const result = await improveWeakTopicSuggestions({ topics: [weak, { ...weak, title: 'Already strong' }], strategy, scoreTopic: score((title) => title === weak.title ? 70 : 91), improveBatch: async () => { calls++; return ''; } });
    assert.equal(result.accepted.length, 2); assert.equal(calls, 0);
  });
  it('improves, deterministically rescores, and preserves source metadata', async () => {
    let scoreCalls = 0;
    const result = await improveWeakTopicSuggestions({ topics: [weak], strategy, scoreTopic: score((title) => { scoreCalls++; return title === weak.title ? 39 : 84; }), improveBatch: async () => validOutput() });
    assert.equal(scoreCalls, 2); assert.equal(result.accepted[0].relevanceScore, 84); assert.equal(result.accepted[0].originalScore, 39); assert.equal(result.accepted[0].sourceUrl, weak.sourceUrl); assert.equal(result.accepted[0].sourcePlatform, weak.sourcePlatform); assert.equal(result.accepted[0].wasAiImproved, true);
  });
  it('retries no more than twice and discards a still-weak topic', async () => {
    let calls = 0;
    const result = await improveWeakTopicSuggestions({ topics: [weak], strategy, scoreTopic: score(() => 69), improveBatch: async () => { calls++; return validOutput(); } });
    assert.equal(calls, 2); assert.equal(result.accepted.length, 0); assert.equal(result.discarded[0].improvementAttempts, 2);
  });
  it('handles invalid JSON and invalid pillars safely', async () => {
    assert.deepEqual(parseImprovedTopics('not-json'), []);
    const payload = JSON.parse(validOutput()); payload.topics[0].pillar = 'Invented pillar';
    const result = await improveWeakTopicSuggestions({ topics: [weak], strategy, scoreTopic: score(() => 20), improveBatch: async () => JSON.stringify(payload) });
    assert.equal(result.accepted.length, 0);
  });
  it('rejects a duplicate angle and ignores AI score fields', async () => {
    const payload = JSON.parse(validOutput()); payload.topics[0].suggestedAngle = payload.topics[0].summary; payload.topics[0].score = 100;
    const result = await improveWeakTopicSuggestions({ topics: [weak], strategy, scoreTopic: score(() => 10), improveBatch: async () => JSON.stringify(payload) });
    assert.equal(result.accepted.length, 0); assert.equal(result.discarded[0].relevanceScore, 10);
  });
});
