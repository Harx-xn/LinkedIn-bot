import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEffectiveBotStrategy } from './botStrategyService';
import { scoreTrendForStrategy } from './botStrategyTrendService';
import { buildDeterministicBatchPlan } from './ghostwriterBatchPlanner';
import { buildPlannedPostPrompt } from './ghostwriterPrompts';
import type { NicheExpansionPlan, TrendCandidate } from './generationTypes';
import { decideCandidateEligibility } from './trendSelectionService';

function strategy() {
  return buildEffectiveBotStrategy({
    description: 'I build practical software and game-development systems.',
    niches: JSON.stringify(['AI Automation', 'Web Development', 'Unity Game Development']),
    profilePositioning: {
      positioningStatement: 'Practical software and Unity game-development workflows',
      credibilityPoints: [],
      uniquePointOfView: 'Production constraints should shape implementation decisions',
      topicsToBeKnownFor: ['Unity Game Development', 'game design principles'],
    },
    targetAudience: {
      primaryAudience: 'Indie Game Devs',
      secondaryAudiences: ['Freelancers', 'AI Enthusiasts'],
      roles: [], industries: [],
      painPoints: ['shipping reliable projects'],
      desiredOutcomes: ['build better user experiences'],
      objectionsOrMisbeliefs: [], knowledgeLevel: 'intermediate',
    },
    contentGoals: { primaryGoal: 'education', secondaryGoals: [], preferredCTAStyle: 'no_cta' },
    contentPillars: {
      primaryPillars: [{
        name: 'Unity Game Development',
        description: 'Unity development and game-design principles',
        audienceRelevance: 'Practical development guidance for Indie Game Devs',
        exampleAngles: ['game-design principles', 'development playbooks'],
        trendKeywords: ['Unity', 'game design', 'user experience'],
      }],
      secondaryPillars: [], experimentalPillars: [], excludedTopics: [],
    },
  });
}

const sourceTitle = "The M.A.G.I.C. framework for mHealth development: applying game design principles from 'Magic: The Gathering'";

function corruptedTrend(): TrendCandidate {
  return {
    topic: sourceTitle,
    rawTitle: sourceTitle,
    summary: 'A framework applies collectible-card-game design principles to mobile-health product development.',
    sourceType: 'searched',
    ideaOrigin: 'SEARCH_DISCOVERED',
    matchedPillar: 'Unity Game Development',
    territory: 'design-principles',
    ideaFamily: 'A practical Unity Game Development playbook for Indie Game Devs',
    authorityMode: 'EXPLORATORY',
    creatorContentFit: 95,
    audienceIdeaNaturalness: 26,
    resolvedAudience: [],
  };
}

test('scenario C/E: observed mHealth-style source is rejected before candidate construction', () => {
  const configured = strategy();
  const plan: NicheExpansionPlan = {
    niche: 'Unity Game Development', normalizedNiche: 'Unity Game Development', domain: 'game development', confidence: .9,
    subtopics: ['game design', 'user experience'], queries: ['Unity game design principles research'], exclusions: [],
    requiredContextTerms: ['game development', 'Unity engine'],
    contentCategories: [{ id: 'design-principles', label: 'design principles', terms: ['game design', 'user experience', 'framework'] }],
  };
  const result = scoreTrendForStrategy({
    topic: sourceTitle,
    searchQuery: 'Unity game design principles research',
    originNiche: 'Unity Game Development',
  }, configured, { profile: plan });
  assert.equal(result.nicheMatch?.activeNicheEvidence?.pillarSatisfied, false, JSON.stringify(result));
  assert.ok(result.nicheMatch?.rejectionCodes.includes('niche_mismatch'));
  assert.equal(decideCandidateEligibility(result.nicheMatch!, true).eligible, false);
});

test('scenario B: adjacent batch slots retain their own topics during deterministic planning', () => {
  const health = corruptedTrend();
  const engine: TrendCandidate = {
    topic: 'Reducing Unity build iteration time with asset dependency hashing',
    sourceType: 'strategy_derived',
    matchedPillar: 'Unity Game Development',
    territory: 'build-pipeline',
    authorityMode: 'EXPLORATORY',
    resolvedAudience: ['Indie Game Devs'],
  };
  const plans = buildDeterministicBatchPlan([health, engine], 2);
  assert.equal(plans[0].selectedCentralClaim, health.topic);
  assert.equal(plans[1].selectedCentralClaim, engine.topic);
  assert.deepEqual(plans[0].resolvedAudience, []);
  assert.deepEqual(plans[1].resolvedAudience, ['Indie Game Devs']);
});

test('prompt builder remains unchanged, but the observed source is now stopped by eligibility first', () => {
  const configured = strategy();
  const trend = corruptedTrend();
  const plan = buildDeterministicBatchPlan([trend], 1, configured.writingStyle, {
    audience: [configured.targetAudience.primaryAudience],
  })[0];
  const prompt = buildPlannedPostPrompt(plan, {
    description: 'I build practical software and game-development systems.',
    tone: 'professional',
    niches: configured.legacy.niches,
    targetAudience: [configured.targetAudience.primaryAudience],
    strategy: configured,
  }, '', trend);

  assert.match(prompt, /mHealth development/i);
  assert.match(prompt, /CONFIGURED AUDIENCE OPTIONS: Indie Game Devs/i);
  assert.match(prompt, /broadly relevant readers; do not insert a configured audience label/i);
});
