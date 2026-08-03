import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RankedTrendCandidate, TopicFingerprint } from './generationTypes';
import { inventoryFingerprint, TOPIC_EXPIRY_DAYS } from './topicInventoryService';
import { dedupeCrossNicheQualifiedTopics } from './trendOrchestrationService';
import { mapWithConcurrencySettled } from './concurrencyUtils';
import { selectNicheBalancedCandidates } from './trendRankingService';

function fp(topic: string, cluster: string): TopicFingerprint {
  return { normalizedTopic: topic, coreClaim: topic, topicCluster: cluster, entities: [], mechanisms: [] };
}
function ranked(topic: string, niche: string, score: number, cluster = niche): RankedTrendCandidate {
  const fingerprint = fp(topic, cluster);
  return { trend: { topic, niche, originNiche: niche }, fingerprint, relevanceScore: score,
    sourceQualityScore: 80, recencyScore: 80, technicalDepthScore: 50, noveltyScore: 100,
    totalScore: score, novelty: { allowed: true, score: 100, reasons: [] } };
}

describe('topic inventory discovery and selection', () => {
  it('isolates a failed niche while bounded niche work continues', async () => {
    const result = await mapWithConcurrencySettled(['AI', 'Web', 'Unity'], 2, async (niche) => {
      if (niche === 'Web') throw new Error('provider failed');
      return niche;
    });
    assert.deepEqual(result.map((item) => item.status), ['fulfilled', 'rejected', 'fulfilled']);
  });

  it('uses representation first and then global score without forcing missing niches', () => {
    const selected = selectNicheBalancedCandidates([
      ranked('AI best', 'AI', 99, 'ai'), ranked('AI second', 'AI', 98, 'ai-2'),
      ranked('Unity best', 'Unity', 80, 'unity'), ranked('Unity second', 'Unity', 70, 'unity-2'),
    ], 3);
    assert.equal(selected.length, 3);
    assert.ok(selected.some((item) => item.trend.niche === 'AI'));
    assert.ok(selected.some((item) => item.trend.niche === 'Unity'));
    assert.equal(selected.some((item) => item.trend.niche === 'Web'), false);
  });

  it('removes semantic cross-niche duplicates and keeps the stronger topic', () => {
    const result = dedupeCrossNicheQualifiedTopics([
      ranked('same normalized topic', 'AI', 90, 'shared'), ranked('same normalized topic', 'Web', 70, 'shared'),
      ranked('different topic', 'Unity', 80, 'unity'),
    ]);
    assert.deepEqual(result.map((item) => item.totalScore), [90, 80]);
  });

  it('creates stable user-inventory fingerprints and configures every intent expiry', () => {
    assert.equal(inventoryFingerprint(fp('Topic', 'cluster')), inventoryFingerprint(fp('Topic', 'cluster')));
    assert.deepEqual(Object.keys(TOPIC_EXPIRY_DAYS).sort(), [
      'audience_question', 'beginner_guidance', 'industry_change', 'practical_implication',
      'recent_development', 'recurring_problem', 'verified_solution',
    ]);
  });
});
