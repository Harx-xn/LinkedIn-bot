import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAuthorBlock } from './ghostwriterPrompts';
import { buildPersonalExperienceBlock } from './manualPost/manualPostPrompts';
import type { ContentIntelligenceProfile } from './contentIntelligenceService';
import {
  applyKnowledgeAuthorityToContentIntelligence,
  buildGenerationAuthorityContext,
  buildUserKnowledgeAuthorityContext,
  resolveTopicAuthority,
} from './userKnowledgeAuthorityService';

const now = new Date('2026-08-24T12:00:00.000Z');

function manualPost(overrides: Record<string, unknown> = {}) {
  return {
    id: 'manual-1', userId: 'user-1', source: 'MANUAL', status: 'PUBLISHED',
    content: `I use a review queue to separate content approval from publishing. ${'This keeps ownership explicit and makes exceptions visible. '.repeat(3)}`,
    hashtags: null, manualTopic: 'content approval workflows', aiGenerated: false,
    rewriteCount: 0, publishedAt: now, createdAt: now, updatedAt: now,
    ...overrides,
  } as any;
}

function intelligence(): ContentIntelligenceProfile {
  return {
    identity: { positioningSummary: '', contentPromise: '', identityThemes: [], expertiseSignals: [], explorationSignals: [], credibilityBoundaries: [] },
    audienceModel: { segments: [] },
    authorityMap: [{ territory: 'cardiology diagnosis', mode: 'EXPLICIT_EXPERTISE', confidence: .95, evidence: ['strategy model guess'] }],
    territoryMap: [{ pillar: 'Medicine', territory: 'cardiology diagnosis', subterritories: [], audienceRelevance: [], ideaFamilies: [], weight: 1 }],
    ideaStrategy: { preferredIdeaFamilies: [], avoidedIdeaPatterns: [], underusedPerspectives: [] },
    distributionStrategy: { pillarWeights: {}, territoryWeights: {} },
    version: 1, confidence: .8,
  };
}

describe('evidence-grounded user knowledge and authority', () => {
  it('treats a selected niche as exploration, never experience or expertise', () => {
    const context = buildUserKnowledgeAuthorityContext({ niches: ['Cardiology'] });
    assert.equal(context.items.length, 1);
    assert.equal(context.items[0].type, 'EXPLORATION');
    assert.equal(context.items[0].sourceType, 'SELECTED_NICHE');
    assert.equal(context.items[0].permitsFirstPerson, false);
    assert.equal(context.explicitlyDone.length, 0);
    assert.equal(resolveTopicAuthority(context, 'Cardiology').mode, 'EXPLORATORY');

    const grounded = applyKnowledgeAuthorityToContentIntelligence(intelligence(), context);
    assert.equal(grounded.authorityMap[0].mode, 'EXPLORATORY');
  });

  it('keeps USER_SUPPLIED experience strongest and permits grounded manual first person', () => {
    const rawText = 'I automated lead transfer from email into a CRM using a webhook.';
    const context = buildUserKnowledgeAuthorityContext({ experiences: [{
      id: 'experience-1', rawText, title: 'Email-to-CRM webhook', topics: ['CRM automation'], source: 'USER_SUPPLIED',
    }] });
    const evidence = context.items[0];
    assert.equal(evidence.sourceType, 'USER_SUPPLIED_EXPERIENCE');
    assert.equal(evidence.strength, 'STRONG');
    assert.equal(evidence.permitsFirstPerson, true);
    assert.equal(resolveTopicAuthority(context, 'CRM automation').mode, 'SUPPORTED_PRACTITIONER');
    assert.match(buildPersonalExperienceBlock({ id: 'experience-1', rawText, source: 'USER_SUPPLIED' }, 'HIGH'), /stronger than general profile/i);
  });

  it('does not create authority evidence from AI-generated batch posts', () => {
    const context = buildUserKnowledgeAuthorityContext({ posts: [manualPost({
      id: 'batch-1', source: 'AI', aiGenerated: true, manualTopic: 'cardiology diagnosis',
    })] });
    assert.equal(context.items.length, 0);
    assert.equal(resolveTopicAuthority(context, 'cardiology diagnosis').mode, 'UNKNOWN');
  });

  it('uses a LinkedIn profile skill as familiarity without inventing projects', () => {
    const context = buildUserKnowledgeAuthorityContext({ linkedInProfile: {
      id: 'profile-1', skills: ['Revenue operations'], experience: [],
    } });
    const skill = context.items.find((item) => item.sourceType === 'LINKEDIN_PROFILE_SKILL');
    assert.equal(skill?.type, 'EXPERTISE');
    assert.equal(skill?.permitsFirstPerson, false);
    assert.equal(resolveTopicAuthority(context, 'Revenue operations').mode, 'INFERRED_FAMILIARITY');
    assert.ok(!context.explicitlyDone.some((item) => item.sourceType === 'LINKEDIN_PROFILE_SKILL'));
  });

  it('keeps an explicit learning signal exploratory', () => {
    const context = buildUserKnowledgeAuthorityContext({
      profileDescription: "I'm learning about clinical trial design.",
      niches: ['Clinical trials'],
    });
    assert.equal(resolveTopicAuthority(context, 'clinical trial design').mode, 'EXPLORATORY');
    assert.ok(context.exploringTopics.length > 0);
  });

  it('resolves conflicting expertise and exploration evidence conservatively', () => {
    const context = buildUserKnowledgeAuthorityContext({
      experiences: [{ id: 'experience-1', rawText: 'I configured one CRM workflow.', topics: ['CRM workflow'], source: 'USER_SUPPLIED' }],
      explicitInstructions: ["I'm currently learning and exploring CRM workflow architecture."],
    });
    const resolved = resolveTopicAuthority(context, 'CRM workflow architecture');
    assert.equal(resolved.mode, 'INFERRED_FAMILIARITY');
    assert.ok(resolved.confidence <= .58);
  });

  it('retains reusable item provenance and detects repeated manual discussion', () => {
    const context = buildUserKnowledgeAuthorityContext({ posts: [
      manualPost({ id: 'manual-1' }),
      manualPost({ id: 'manual-2', content: `I separate publishing from content approval. ${'A visible queue keeps review ownership clear. '.repeat(4)}` }),
    ] });
    const first = context.items.find((item) => item.sourceId === 'manual-1');
    assert.equal(first?.sourceType, 'PUBLISHED_MANUAL_POST');
    assert.equal(first?.sourceId, 'manual-1');
    assert.ok(first!.confidence > 0);
    assert.ok(context.repeatedlyDiscussedTopics.some((topic) => /content approval/i.test(topic)));
  });

  it('gives batch authority boundaries and stronger territories without anecdote text or permission', () => {
    const rawText = 'I rebuilt a private client workflow after a failed migration.';
    const context = buildUserKnowledgeAuthorityContext({
      profileDescription: 'I advise teams on workflow migrations.',
      experiences: [{ id: 'private-experience', rawText, topics: ['workflow migrations'], source: 'USER_SUPPLIED' }],
    });
    const batch = buildGenerationAuthorityContext(context, 'BATCH', ['workflow migrations']);
    assert.equal(batch.experienceBank.availableCount, 1);
    assert.equal(batch.experienceBank.detailsIncluded, false);
    assert.equal(batch.experienceBank.batchApprovalRequired, true);
    assert.equal(batch.territories[0].mode, 'SUPPORTED_PRACTITIONER');

    const prompt = buildAuthorBlock({
      description: 'I advise teams on workflow migrations.', tone: 'Direct', niches: ['Operations'], authorityContext: batch,
    });
    assert.match(prompt, /Batch generation has no anecdote permission/i);
    assert.ok(!prompt.includes(rawText));
    assert.ok(!prompt.includes('private-experience'));
  });
});
