import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { imageContentSchema } from './ghostwriterSchemas';
import { countWords } from './ghostwriterTextUtils';
import {
  detectUnsupportedFirstPersonClaims,
  detectDeterministicTechnicalIssues,
  scoreSpecificity,
  validateAngleContent,
  validateFormattedBody,
  validateImageContent,
  buildSafeFallbackImageContent,
  runDeterministicValidation,
} from './ghostwriterValidationService';

const AUTHOR = {
  description:
    'I am a full-stack developer building a SaaS platform for LinkedIn automation. I work with React, TypeScript, Node.js, Express, PostgreSQL, Prisma, authentication, subscriptions, scheduling, and third-party APIs.',
  tone: 'Professional',
  niches: ['SaaS', 'full-stack development'],
};

describe('first-person claims', () => {
  it('detects In building Veyrais, I encountered', () => {
    const flags = detectUnsupportedFirstPersonClaims(
      'In building Veyrais, I encountered a scheduling issue with duplicate jobs.',
      AUTHOR.description,
    );
    assert.ok(flags.length > 0);
  });

  it('detects I set up', () => {
    assert.ok(detectUnsupportedFirstPersonClaims('I set up a job queue to fix retries.', AUTHOR.description).length > 0);
  });

  it('detects I was able', () => {
    assert.ok(detectUnsupportedFirstPersonClaims('I was able to limit duplicate publishes.', AUTHOR.description).length > 0);
  });

  it('detects we implemented', () => {
    assert.ok(detectUnsupportedFirstPersonClaims('We implemented a lock around publishing.', AUTHOR.description).length > 0);
  });

  it('permits verified author identity', () => {
    const flags = detectUnsupportedFirstPersonClaims(
      'I am a full-stack developer building a SaaS platform. I work with React and Node.js.',
      AUTHOR.description,
    );
    assert.equal(flags.length, 0);
  });
});

describe('technical distinctions', () => {
  it('flags authentication as tenant authorization', () => {
    const issues = detectDeterministicTechnicalIssues(
      "Authentication prevents one tenant from accessing another tenant's data.",
    );
    assert.ok(issues.some((i) => i.code === 'auth_vs_authorization' && i.severity === 'error'));
  });

  it('flags frontend checks as security', () => {
    const issues = detectDeterministicTechnicalIssues('Frontend checks provide UI security for premium features.');
    assert.ok(issues.some((i) => i.code === 'frontend_security_claim'));
  });

  it('flags API checks as automatic compliance', () => {
    const issues = detectDeterministicTechnicalIssues('API entitlement checks create a clear audit trail and ensure compliance.');
    assert.ok(issues.some((i) => i.code === 'compliance_overclaim'));
  });

  it('flags shared database across environments', () => {
    const issues = detectDeterministicTechnicalIssues(
      'Use one database instance for development, staging, and production to ensure consistency.',
    );
    assert.ok(issues.some((i) => i.code === 'environment_isolation_error'));
  });

  it('flags false consistency versus scalability trade-off', () => {
    const issues = detectDeterministicTechnicalIssues(
      'Consistent environments may limit scalability, so choose one based on growth.',
    );
    assert.ok(issues.some((i) => i.code === 'false_architecture_tradeoff'));
  });

  it('flags queue locks without idempotency', () => {
    const issues = detectDeterministicTechnicalIssues(
      'Lowering queue concurrency and adding locks prevents duplicate publishing.',
    );
    assert.ok(issues.some((i) => i.code === 'locking_overclaim' || i.code === 'idempotency_omitted'));
  });

  it('flags background reconciliation as primary usage enforcement', () => {
    const issues = detectDeterministicTechnicalIssues(
      'Run a background job periodically to update usage and enforce plan limits.',
    );
    assert.ok(issues.some((i) => i.code === 'background_job_overclaim' || i.code === 'atomic_usage_omitted'));
  });
});

describe('specificity scoring', () => {
  it('scores generic API advice low', () => {
    const r = scoreSpecificity('Use API checks for security.');
    assert.ok(r.score < 40);
  });

  it('scores atomic entitlement example high', () => {
    const r = scoreSpecificity(
      "Before publishing, load the user's entitlement and atomically increment the monthly usage counter in the same transaction because two requests may race. Reject the request if the update would exceed the plan limit.",
    );
    assert.ok(r.score >= 65);
    assert.ok(r.signals.includes('named_mechanism'));
    assert.ok(r.signals.includes('causal_explanation'));
  });

  it('does not score high on technology names alone', () => {
    const r = scoreSpecificity('API server frontend backend token.');
    assert.ok(r.score < 50);
  });

  it('accepts a short Direct-style post with one deeply explained mechanism', () => {
    const body = 'API scaling problems often start before traffic becomes a problem. An endpoint returning an unbounded dataset does more database work, serializes more data, sends a larger payload, and makes the client process more than it needs. Pagination fixes that particular problem before another server enters the discussion.';
    const r = scoreSpecificity(body);
    assert.ok(r.score >= 55);
    assert.ok(r.signals.includes('explained_mechanism'));
    assert.deepEqual(r.missing, []);

    const validation = runDeterministicValidation(
      { headline: '', subheadline: '', bulletPoints: [], body, hashtags: '' },
      AUTHOR,
      { trendIndex: 0, sourceTopic: 'API design', angle: 'product_lesson', hookStyle: 'observation', endingStyle: 'natural', layout: 'short_observation', rationale: 'regression', expressionMode: 'direct' },
      [],
    );
    assert.equal(validation.passed, true);
    assert.ok(!validation.issues.some((issue) => issue.code === 'insufficient_specificity'));
  });
});

describe('angle validation', () => {
  it('fails debugging story without cause and prevention', () => {
    const issues = validateAngleContent('A bug happened and then things improved.', {
      trendIndex: 0,
      sourceTopic: 'queues',
      angle: 'debugging_story',
      hookStyle: 'story',
      endingStyle: 'takeaway',
      layout: 'story_then_lesson',
      rationale: 'test',
    });
    assert.ok(issues.some((i) => i.severity === 'error'));
  });

  it('fails architecture trade-off with false dichotomy', () => {
    const issues = validateAngleContent(
      'Choose environment consistency versus scalability for your startup.',
      {
        trendIndex: 0,
        sourceTopic: 'env',
        angle: 'architecture_tradeoff',
        hookStyle: 'comparison',
        endingStyle: 'takeaway',
        layout: 'comparison',
        rationale: 'test',
      },
    );
    assert.ok(issues.some((i) => i.code === 'false_dichotomy' || i.code === 'tradeoff_missing'));
  });

  it('fails tutorial without actionable steps', () => {
    const issues = validateAngleContent('Entitlements are important for SaaS products.', {
      trendIndex: 0,
      sourceTopic: 'entitlements',
      angle: 'practical_tutorial',
      hookStyle: 'lesson',
      endingStyle: 'action',
      layout: 'technical_walkthrough',
      rationale: 'test',
    });
    assert.ok(issues.some((i) => i.code === 'tutorial_not_actionable'));
  });
});

describe('image copy validation', () => {
  const approved = {
    headline: 'Atomic usage enforcement',
    subheadline: '',
    bulletPoints: [],
    body: 'Validate and increment usage atomically during protected API operations. Background jobs can reconcile drift.',
    hashtags: '#SaaS',
  };

  it('rejects supporting text with 8 words in schema', () => {
    const parsed = imageContentSchema.safeParse({
      mode: 'single_insight',
      headline: 'Atomic usage enforcement matters',
      supportingText: 'A well structured authentication mechanism is crucial for security and satisfaction',
      bulletPoints: [],
    });
    assert.equal(parsed.success, false);
  });

  it('accepts 7 word supporting text', () => {
    const parsed = imageContentSchema.safeParse({
      mode: 'single_insight',
      headline: 'Separate identity from tenant authorization',
      supportingText: 'Enforce limits where protected actions actually occur',
      bulletPoints: [],
    });
    assert.equal(parsed.success, true);
    assert.equal(countWords(parsed.data!.supportingText!), 7);
  });

  it('rejects vague bullets', () => {
    const result = validateImageContent(
      {
        mode: 'checklist',
        headline: 'Atomic usage enforcement',
        bulletPoints: ['Drive growth with innovation'],
      },
      approved,
    );
    assert.equal(result.passed, false);
  });

  it('fallback image has no unsafe subheading', () => {
    const fallback = buildSafeFallbackImageContent({
      body: approved.body,
      headline: approved.headline,
    });
    assert.equal(fallback.supportingText, undefined);
    assert.ok(fallback.headline.length > 0);
  });
});

describe('regression fixtures', () => {
  it('Failure A: unsupported debugging story is blocked', () => {
    const result = runDeterministicValidation(
      {
        headline: 'Scheduling',
        subheadline: '',
        bulletPoints: [],
        body: 'In building Veyrais, I encountered a scheduling issue. I set up a job queue and I was able to fix it by lowering concurrency.',
        hashtags: '#SaaS',
      },
      AUTHOR,
      {
        trendIndex: 0,
        sourceTopic: 'scheduling',
        angle: 'debugging_story',
        hookStyle: 'story',
        endingStyle: 'takeaway',
        layout: 'story_then_lesson',
        rationale: 'test',
      },
      [],
    );
    assert.equal(result.passed, false);
    assert.ok(result.issues.some((i) => i.code === 'unsupported_first_person'));
  });

  it('Failure E: shared database recommendation is blocking error', () => {
    const issues = detectDeterministicTechnicalIssues(
      'Use one database instance for all environments to ensure consistency.',
    );
    assert.ok(issues.some((i) => i.code === 'environment_isolation_error' && i.severity === 'error'));
  });

  it('Failure G: long image subheading fails validation', () => {
    const parsed = imageContentSchema.safeParse({
      mode: 'single_insight',
      headline: 'Authentication matters for SaaS',
      supportingText: 'A well-structured authentication mechanism is crucial for security and user satisfaction',
      bulletPoints: [],
    });
    assert.equal(parsed.success, false);
  });
});

describe('final formatted validation', () => {
  it('rejects unauthorized contact when disabled', () => {
    const issues = validateFormattedBody('Body text\n\nContact: me@example.com', '', AUTHOR.description, {
      includeContactInfo: false,
      includeWebsiteLink: false,
    });
    assert.ok(issues.some((i) => i.code === 'unauthorized_contact'));
  });

  it('rejects more than three hashtags after formatting', () => {
    const issues = validateFormattedBody('Body', '#One #Two #Three #Four', AUTHOR.description, {
      includeContactInfo: false,
      includeWebsiteLink: false,
    });
    assert.ok(issues.some((i) => i.code === 'too_many_hashtags_after_format'));
  });
});
