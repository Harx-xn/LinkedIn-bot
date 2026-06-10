import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectUnsupportedFirstPersonClaims,
  convertUnsupportedFirstPerson,
  detectTechnicalIssues,
  isGenericEnding,
  endsWithQuestion,
  evaluatePostQuality,
  evaluateTopicCombination,
  jaccardSimilarity,
} from './ghostwriterQualityService';
import { normalizeHashtags, normalizeTaplioStyleBody } from './postContentFormatting';
import { scoreTrend } from './trendQualityService';
import { buildEvergreenTopics } from './trendQualityService';

const AUTHOR = {
  description:
    'I am a full-stack developer building a SaaS platform for LinkedIn automation. I work with React, TypeScript, Node.js, Express, PostgreSQL, Prisma, authentication, subscriptions, scheduling, and third-party APIs.',
  tone: 'Professional',
  niches: ['SaaS', 'full-stack development'],
};

describe('trend filtering', () => {
  it('rejects a LinkedIn job listing', () => {
    const r = scoreTrend({ topic: 'SaaS developer job in Markham hiring now' }, AUTHOR);
    assert.equal(r.accepted, false);
    assert.ok(r.reasons.includes('job_listing'));
  });

  it('rejects an unpaid internship', () => {
    const r = scoreTrend({ topic: 'Unpaid SaaS internship in Karnataka apply now' }, AUTHOR);
    assert.equal(r.accepted, false);
  });

  it('rejects PR promotional announcement', () => {
    const r = scoreTrend({ topic: 'PR.com: leading company announces new services' }, AUTHOR);
    assert.equal(r.accepted, false);
  });

  it('rejects generic best company in city page', () => {
    const r = scoreTrend({ topic: 'Best software development company in Toronto services' }, AUTHOR);
    assert.equal(r.accepted, false);
  });

  it('accepts relevant SaaS architecture topic', () => {
    const r = scoreTrend({ topic: 'How to build a SaaS product with API entitlement limits' }, AUTHOR);
    assert.ok(r.score >= 60 || r.accepted);
  });

  it('falls back to evergreen author topics', () => {
    const topics = buildEvergreenTopics(AUTHOR, 3);
    assert.equal(topics.length, 3);
    assert.ok(topics[0].source === 'evergreen');
  });
});

describe('unsupported claims', () => {
  it('detects I ignored Docker for months', () => {
    const flags = detectUnsupportedFirstPersonClaims('I ignored Docker for months until deploys hurt.', AUTHOR.description);
    assert.ok(flags.length > 0);
  });

  it('permits I am a full-stack developer from author description', () => {
    const flags = detectUnsupportedFirstPersonClaims('I am a full-stack developer building a SaaS platform.', AUTHOR.description);
    assert.equal(flags.length, 0);
  });

  it('detects fabricated customer claims', () => {
    const flags = detectUnsupportedFirstPersonClaims('Our customers increased revenue by 300%.', AUTHOR.description);
    assert.ok(flags.length > 0);
  });

  it('converts unsupported first person safely', () => {
    const out = convertUnsupportedFirstPerson('I ignored Docker for months and finally learned.');
    assert.ok(!/I ignored Docker/i.test(out));
  });
});

describe('hashtags', () => {
  it('returns zero to three hashtags', () => {
    const none = normalizeHashtags('', 'API entitlement checks in Express', 'SaaS');
    const tags = none.split(' ').filter((t) => t.startsWith('#'));
    assert.ok(tags.length <= 3);
  });

  it('does not force generic fallback hashtags', () => {
    const out = normalizeHashtags('#Growth #Innovation #Strategy', 'random unrelated text xyz', 'xyz');
    assert.ok(!out.includes('#Growth'));
  });

  it('preserves strong topic-specific tags', () => {
    const out = normalizeHashtags('#SaaS #PostgreSQL', 'SaaS subscription limits with PostgreSQL', 'SaaS');
    assert.ok(out.includes('#SaaS') || out.includes('#PostgreSQL'));
  });
});

describe('endings', () => {
  it('rejects Are you ready?', () => {
    assert.ok(isGenericEnding('Some body\n\nAre you ready?'));
  });

  it('rejects What strategies have worked for you?', () => {
    assert.ok(isGenericEnding('Post\n\nWhat strategies have worked for you?'));
  });

  it('accepts specific technical question', () => {
    assert.ok(endsWithQuestion('Which part of your deployment still depends on a developer local machine?'));
    assert.ok(!isGenericEnding('Which part of your deployment still depends on a developer local machine?'));
  });

  it('accepts takeaway without question', () => {
    const body = 'Docker improves environment consistency.\n\nIt does not automatically make an application scalable.';
    assert.ok(!endsWithQuestion(body));
    assert.ok(!isGenericEnding(body));
  });
});

describe('technical safety', () => {
  it('flags Docker framework', () => {
    assert.ok(detectTechnicalIssues('Docker is a framework for containers').includes('docker_framework'));
  });

  it('flags guaranteed upgrade ROI', () => {
    assert.ok(detectTechnicalIssues('This CMS upgrade guarantees better SEO and ROI').length > 0);
  });

  it('flags instant scalability', () => {
    assert.ok(detectTechnicalIssues('Cloud gives instant scalability').includes('instant_scalability'));
  });

  it('permits qualified claims', () => {
    const issues = detectTechnicalIssues('Caching may reduce latency depending on workload patterns.');
    assert.equal(issues.length, 0);
  });
});

describe('batch diversity', () => {
  it('detects similar bodies', () => {
    const a = 'Subscription limits belong on the server not only in the frontend for SaaS products.';
    const b = 'Subscription limits belong on the server not only in the UI for SaaS apps.';
    assert.ok(jaccardSimilarity(a, b) > 0.55);
  });
});

describe('formatting', () => {
  it('preserves concise paragraphs', () => {
    const body = 'First paragraph with two sentences. Still same paragraph.\n\nSecond paragraph here.';
    const out = normalizeTaplioStyleBody(body);
    assert.ok(out.includes('First paragraph'));
    assert.ok(out.includes('\n\nSecond paragraph'));
  });

  it('splits dense prose into readable line-based paragraphs', () => {
    const body = 'Sentence one. Sentence two. Sentence three. Sentence four.';
    const out = normalizeTaplioStyleBody(body);
    assert.ok(out.includes('\n\n'));
  });
});

describe('mixed topic safety', () => {
  it('rejects weak topic combination', () => {
    const r = evaluateTopicCombination('International SEO agency services', 'Docker container basics', AUTHOR);
    assert.equal(r.canCombine, false);
  });
});

describe('quality gate', () => {
  it('fails generic unsupported first-person post', () => {
    const q = evaluatePostQuality(
      {
        headline: 'Docker',
        subheadline: '',
        bulletPoints: [],
        body: 'I ignored Docker for months. Modern technology will revolutionize your business. Are you ready?',
        hashtags: '#Growth #Innovation #Strategy',
      },
      AUTHOR,
      [],
      [],
    );
    assert.equal(q.passed, false);
  });
});
