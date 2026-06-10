import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { buildManualPlanningPrompt } from './manualPostPrompts';
import {
  evaluateAngleAgainstFingerprints,
  fingerprintPenaltyForAngle,
  selectManualPlan,
} from './manualPostPlanning';
import type { ManualAngleCandidate, ManualPlanningResult } from './manualPostTypes';
import {
  calculateFingerprintSimilarity,
  extractManualPostFingerprint,
  isBroadTopicAllowed,
  type ManualPostFingerprintRecord,
} from './manualPostFingerprintService';

const ROOT = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function fingerprint(overrides: Partial<ManualPostFingerprintRecord> = {}): ManualPostFingerprintRecord {
  return {
    id: 'fp-1',
    postId: 'post-1',
    userId: 'user-1',
    primaryTopic: 'Tenant authorization in SaaS',
    subtopic: 'authorization',
    coreClaim: 'Server-side tenant scope must be enforced before any database query runs.',
    structure: 'hook_body_close',
    hookType: 'observation_hook',
    evidenceType: 'technical_example',
    ctaType: 'closing_takeaway',
    keywords: ['tenant', 'authorization', 'server'],
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    ...overrides,
  };
}

function angle(overrides: Partial<ManualAngleCandidate> = {}): ManualAngleCandidate {
  return {
    title: 'Tenant authorization in SaaS',
    coreClaim: 'Server-side tenant scope must be enforced before any database query runs.',
    audience: 'Backend engineers',
    structure: 'hook_body_close',
    evidenceMode: 'technical_example',
    specificity: 8,
    novelty: 7,
    audienceFit: 8,
    voiceFit: 7,
    evidenceAvailability: 8,
    hookCandidates: [
      {
        text: 'Most multi-tenant bugs are not in the database layer.',
        type: 'observation_hook',
        specificity: 8,
        curiosity: 7,
        topicRelevance: 9,
        clarity: 8,
        voiceFit: 7,
      },
    ],
    ...overrides,
  };
}

describe('manual fingerprint extraction', () => {
  it('extracts fingerprint from final saved post content', () => {
    const extracted = extractManualPostFingerprint({
      content: [
        'Most multi-tenant bugs are not in the database layer.',
        '',
        'They show up when application code assumes the caller already belongs to the right tenant. Resolve tenant scope from the authenticated session and reject cross-tenant identifiers before any query runs.',
        '',
        'Treat tenant scope as a request invariant, not a UI convenience.',
      ].join('\n'),
      manualTopic: 'Tenant authorization',
      hashtags: '#SaaS #Authorization',
    });

    assert.ok(extracted);
    assert.equal(extracted!.primaryTopic, 'Tenant authorization');
    assert.ok(extracted!.coreClaim.length >= 40);
    assert.ok(extracted!.keywords.length > 0);
    assert.ok(extracted!.hookType);
    assert.ok(extracted!.structure);
  });

  it('returns null for content too short without failing callers', () => {
    const extracted = extractManualPostFingerprint({ content: 'Too short' });
    assert.equal(extracted, null);
  });
});

describe('manual fingerprint repetition prevention', () => {
  it('rejects repeated core claims during planning', () => {
    const rejection = evaluateAngleAgainstFingerprints(angle(), [fingerprint()]);
    assert.equal(rejection, 'repeats recent core claim');
  });

  it('allows broad related topics with a different core claim', () => {
    const related = angle({
      title: 'Tenant authorization patterns',
      coreClaim: 'Authorization middleware should attach tenant scope to the request context before handlers execute.',
    });
    const rejection = evaluateAngleAgainstFingerprints(related, [fingerprint()]);
    assert.equal(rejection, null);
    assert.equal(
      isBroadTopicAllowed(
        related.title,
        fingerprint().primaryTopic,
        calculateFingerprintSimilarity(
          { coreClaim: related.coreClaim, primaryTopic: related.title },
          fingerprint(),
        ).coreClaimSimilarity,
      ),
      true,
    );
  });

  it('penalizes repeated hook and structure patterns without blacklisting the niche', () => {
    const penalty = fingerprintPenaltyForAngle(
      angle({
        coreClaim: 'Middleware should validate tenant identifiers at the edge before routing requests.',
        structure: 'hook_body_close',
      }),
      [fingerprint()],
    );
    assert.ok(penalty > 0);
  });

  it('selectManualPlan prefers non-repeating angles when fingerprints are present', () => {
    const planning: ManualPlanningResult = {
      angles: [
        angle(),
        angle({
          title: 'Queue retry safety',
          coreClaim: 'Retry storms need bounded backoff and idempotent consumers to protect downstream APIs.',
          structure: 'multi_paragraph_argument',
          hookCandidates: [
            {
              text: 'Retry logic can quietly amplify outages.',
              type: 'problem_statement',
              specificity: 8,
              curiosity: 7,
              topicRelevance: 8,
              clarity: 8,
              voiceFit: 7,
            },
          ],
        }),
      ],
    };

    const selected = selectManualPlan(planning, 'Tenant authorization', undefined, [fingerprint()]);
    assert.equal(selected.coreClaim, 'Retry storms need bounded backoff and idempotent consumers to protect downstream APIs.');
  });
});

describe('manual fingerprint route hooks', () => {
  it('manual post service schedules fingerprint sync after save, schedule, and publish flows', () => {
    const service = readSrc('services/manualPostService.ts');
    assert.ok(service.includes('scheduleManualPostFingerprintSync'));
    assert.ok(service.includes('afterManualPostPersisted'));
    assert.ok(service.includes('createDraft'));
    assert.ok(service.includes('scheduleManualPost'));
    assert.ok(service.includes('publishManualPostNow'));
  });

  it('linkedin publish hook fingerprints only manual posts', () => {
    const linkedin = readSrc('services/linkedinService.ts');
    assert.ok(linkedin.includes("post.source === 'MANUAL'"));
    assert.ok(linkedin.includes('scheduleManualPostFingerprintSync'));
  });

  it('manual generation orchestration does not create fingerprints directly', () => {
    const orchestration = readSrc('services/manualPost/manualPostOrchestration.ts');
    const aiService = readSrc('services/manualPostAiService.ts');
    assert.ok(!orchestration.includes('saveManualPostFingerprint'));
    assert.ok(!orchestration.includes('scheduleManualPostFingerprintSync'));
    assert.ok(!aiService.includes('manualPostFingerprint'));
  });

  it('manual planning prompt includes recent fingerprint context', () => {
    const prompt = buildManualPlanningPrompt({
      topic: 'Tenant authorization',
      author: { description: 'Engineer', tone: 'Professional', niches: ['SaaS'] },
      recentFingerprints: [fingerprint()],
    });
    assert.ok(prompt.includes('RECENT MANUAL FINGERPRINTS'));
    assert.ok(prompt.includes('Server-side tenant scope must be enforced'));
  });

  it('getRecentManualFingerprints scopes retrieval by userId', () => {
    const service = readSrc('services/manualPost/manualPostFingerprintService.ts');
    const retrieval = service.slice(
      service.indexOf('export async function getRecentManualFingerprints'),
      service.indexOf('export async function syncManualPostFingerprint'),
    );
    assert.ok(retrieval.includes('where: {'));
    assert.ok(retrieval.includes('userId'));
  });
});

describe('batch fingerprint isolation', () => {
  it('batch generation does not load manual fingerprints', () => {
    const batchGen = readSrc('services/ghostwriterGenerationService.ts');
    const pipeline = readSrc('services/ghostwriterPipeline.ts');
    const trending = readSrc('services/trendingBotService.ts');
    assert.ok(!batchGen.includes('getRecentManualFingerprints'));
    assert.ok(!batchGen.includes('PostContentFingerprint'));
    assert.ok(!pipeline.includes('manualPostFingerprint'));
    assert.ok(!trending.includes('RECENT MANUAL FINGERPRINTS'));
  });

  it('manualPostService only fingerprints manual-source posts', () => {
    const service = readSrc('services/manualPostService.ts');
    assert.ok(service.includes("post.source !== MANUAL_SOURCE"));
  });

  it('syncManualPostFingerprint skips non-manual posts', () => {
    const service = readSrc('services/manualPost/manualPostFingerprintService.ts');
    const syncBody = service.slice(
      service.indexOf('export async function syncManualPostFingerprint'),
      service.indexOf('export function scheduleManualPostFingerprintSync'),
    );
    assert.ok(syncBody.includes("source: MANUAL_SOURCE"));
    assert.ok(syncBody.includes('userId'));
  });
});
