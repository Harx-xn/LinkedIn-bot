import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RankedTrendCandidate } from './generationTypes';
import { selectFinalBatchCandidates } from './trendRankingService';
import { combineFreshAndInventoryTopics, unselectedQualifiedTopics } from './topicInventoryService';

function candidate(index: number, niche: string, cluster = niche.toLowerCase().replace(/\s+/g, '_')): RankedTrendCandidate {
  const topic = `${niche} alpha${index} beta${index} gamma${index} delta${index}`;
  return {
    trend: { topic, niche, originNiche: niche, discoveryIntent: `intent_${index % 7}` as any, publisher: `publisher-${index % 5}`, strategyReasons: [`category_match:category_${index % 6}`] },
    fingerprint: { normalizedTopic: `${niche.toLowerCase()} alpha${index} beta${index}`, coreClaim: `claim${index} outcome${index} method${index}`, topicCluster: cluster, entities: [`entity-${index % 4}`], mechanisms: [`mechanism-${index}`] },
    relevanceScore: 80, sourceQualityScore: 80, recencyScore: 80, technicalDepthScore: 70,
    noveltyScore: 100, totalScore: 1000 - index, novelty: { allowed: true, score: 100, reasons: [] },
  };
}

describe('variable-size final batch selection', () => {
  it('selects 21 of 50 approved topics and leaves exactly 29 excess', () => {
    const pool = Array.from({ length: 50 }, (_, index) => candidate(index, ['AI Automation', 'Web Development', 'Unity Game Development'][index % 3]));
    const result = selectFinalBatchCandidates(pool, 21);
    assert.equal(result.selected.length, 21);
    assert.equal(unselectedQualifiedTopics(pool, result.selected).length, 29);
  });

  it('redistributes unavailable niche capacity', () => {
    const pool = [
      ...Array.from({ length: 20 }, (_, i) => candidate(i, 'AI Automation')),
      ...Array.from({ length: 20 }, (_, i) => candidate(100 + i, 'Web Development')),
      ...Array.from({ length: 3 }, (_, i) => candidate(200 + i, 'Unity Game Development')),
    ];
    const selected = selectFinalBatchCandidates(pool, 21).selected;
    assert.equal(selected.length, 21);
    assert.equal(selected.filter((item) => item.trend.originNiche === 'Unity Game Development').length, 3);
  });

  it('lets a dominant niche fill the deficit after minority representation', () => {
    const pool = [...Array.from({ length: 30 }, (_, i) => candidate(i, 'AI Automation')), candidate(100, 'Web Development'), candidate(101, 'Web Development'), candidate(200, 'Unity Game Development')];
    const selected = selectFinalBatchCandidates(pool, 21).selected;
    assert.equal(selected.length, 21);
    assert.ok(selected.some((item) => item.trend.originNiche === 'Web Development'));
    assert.ok(selected.some((item) => item.trend.originNiche === 'Unity Game Development'));
    assert.ok(selected.filter((item) => item.trend.originNiche === 'AI Automation').length > 4);
  });

  it('stops at the hard-unique pool when duplicates prevent filling', () => {
    const unique = Array.from({ length: 17 }, (_, i) => candidate(i, 'AI Automation'));
    const pool = [...unique, ...Array.from({ length: 13 }, (_, i) => ({ ...unique[i % unique.length], trend: { ...unique[i % unique.length].trend } }))];
    const result = selectFinalBatchCandidates(pool, 21);
    assert.equal(result.selected.length, 17);
    assert.equal((result.diagnostics.final as any).stopReason, 'hard_unique_pool_exhausted');
  });

  it('preserves seven-post diversity while allowing a broad cluster to scale', () => {
    const seven = Array.from({ length: 12 }, (_, i) => candidate(i, ['AI Automation', 'Web Development', 'Unity Game Development'][i % 3], 'updates'));
    assert.equal(selectFinalBatchCandidates(seven, 7).selected.length, 7);
    const large = Array.from({ length: 25 }, (_, i) => candidate(i, 'AI Automation', 'ai_automation'));
    assert.equal(selectFinalBatchCandidates(large, 21).selected.length, 21);
  });

  it('never returns a selected topic as excess', () => {
    const pool = Array.from({ length: 30 }, (_, i) => candidate(i, 'AI Automation'));
    const selected = selectFinalBatchCandidates(pool, 21).selected;
    const excess = unselectedQualifiedTopics(pool, selected);
    assert.equal(excess.length, 9);
    assert.ok(selected.every((item) => !excess.includes(item)));
  });

  it('uses inventory only for the remaining fresh deficit', () => {
    const fresh = Array.from({ length: 18 }, (_, i) => candidate(i, 'AI Automation'));
    const inventory = Array.from({ length: 6 }, (_, i) => candidate(100 + i, 'Web Development'));
    const combined = combineFreshAndInventoryTopics(fresh, inventory, 21);
    assert.equal(combined.freshSelected.length, 18);
    assert.equal(combined.inventorySelected.length, 3);
    assert.equal(combined.selected.length, 21);
  });
});
