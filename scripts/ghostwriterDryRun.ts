/**
 * Dry-run seven ghostwriter slots without persisting posts.
 * Usage: npx ts-node scripts/ghostwriterDryRun.ts
 */
import dotenv from 'dotenv';
import { ContentService } from '../src/services/contentService';
import { buildDeterministicBatchPlan } from '../src/services/ghostwriterBatchPlanner';
import { generateSlotPost } from '../src/services/ghostwriterGenerationService';
import { detectUnsupportedFirstPersonClaims } from '../src/services/ghostwriterValidationService';
import { buildEvergreenTopics } from '../src/services/trendQualityService';

dotenv.config();

const AUTHOR = {
  description:
    'I am a full-stack developer building a SaaS platform for LinkedIn automation. I work with React, TypeScript, Node.js, Express, PostgreSQL, Prisma, authentication, subscriptions, scheduling, and third-party APIs.',
  tone: 'Professional',
  niches: ['SaaS', 'full-stack development'],
};

const BOT_CONFIG = {
  tone: 'Professional',
  description: AUTHOR.description,
  niches: AUTHOR.niches,
  includeContactInfo: false,
  includeWebsiteLink: false,
};

async function main() {
  if (!process.env.OPENAI_API_KEY && !process.env.GEMINI_API_KEY) {
    console.error('Set OPENAI_API_KEY or GEMINI_API_KEY to run the dry run.');
    process.exit(1);
  }

  const contentService = new ContentService();
  const provider = process.env.OPENAI_API_KEY ? ('OPENAI' as const) : ('GEMINI' as const);
  const topics = buildEvergreenTopics(AUTHOR, 7);
  const plans = buildDeterministicBatchPlan(topics, 7);
  const acceptedBodies: string[] = [];
  const summary: Array<Record<string, unknown>> = [];

  for (let i = 0; i < 7; i++) {
    const plan = plans[i];
    const trend = topics[i];
    console.log(`\n=== Slot ${i + 1}/${7}: ${trend.topic.slice(0, 60)} ===`);

    const result = await generateSlotPost(
      contentService,
      plan,
      trend,
      AUTHOR,
      BOT_CONFIG,
      acceptedBodies,
      provider,
    );

    if (!result.ok) {
      summary.push({ slot: i + 1, ok: false, reason: result.reason });
      console.log('FAILED:', result.reason);
      continue;
    }

    const fp = detectUnsupportedFirstPersonClaims(result.finalized.body, AUTHOR.description);
    const review = await contentService.reviewTechnicalClaims(
      {
        headline: result.finalized.headline,
        subheadline: result.finalized.subheadline,
        bulletPoints: result.finalized.bulletPoints,
        body: result.finalized.body,
        hashtags: result.finalized.hashtags,
      },
      AUTHOR,
      plan,
      provider,
    );

    summary.push({
      slot: i + 1,
      ok: true,
      angle: plan.angle,
      qualityScore: result.qualityScore,
      firstPersonSurvived: fp.length > 0,
      technicalReviewPassed: review.passed,
      technicalIssues: review.issues.map((issue) => ({
        code: issue.code,
        severity: issue.severity,
      })),
      imageMode: result.imageContent?.mode ?? 'none',
      imageSubheadingWords: result.imageContent?.supportingText
        ? result.imageContent.supportingText.trim().split(/\s+/).filter(Boolean).length
        : 0,
      bodyPreview: result.finalized.body.slice(0, 180).replace(/\n/g, ' '),
    });

    acceptedBodies.push(result.finalized.body);
    console.log('ACCEPTED', {
      angle: plan.angle,
      score: result.qualityScore,
      technicalPassed: review.passed,
      imageMode: result.imageContent?.mode,
      fpSurvived: fp.length > 0,
    });
  }

  console.log('\n=== DRY RUN SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
