import { z } from 'zod';
import {
  countWords,
  MAX_IMAGE_SUBHEADING_WORDS,
  MAX_IMAGE_HEADLINE_WORDS,
  MAX_IMAGE_HEADLINE_CHARS,
  MAX_IMAGE_SUBHEADING_CHARS,
  MAX_IMAGE_BULLET_WORDS,
} from './ghostwriterTextUtils';

export const generatedPostSchema = z.object({
  headline: z.string().min(1),
  subheadline: z.string().optional().default(''),
  bulletPoints: z.array(z.string()).optional().default([]),
  body: z.string().min(40),
  hashtags: z.string().optional().default(''),
  sourceTopic: z.string().nullable().optional(),
  angle: z.string().optional(),
  layout: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  warnings: z.array(z.string()).optional(),
});

/** Strict OpenAI schema: every property must appear in `required`; omit optional model fields. */
export const GENERATED_POST_OPENAI_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'subheadline', 'bulletPoints', 'body', 'hashtags', 'sourceTopic', 'angle', 'layout'],
  properties: {
    headline: { type: 'string', minLength: 1 },
    subheadline: { type: 'string' },
    bulletPoints: { type: 'array', items: { type: 'string' } },
    body: { type: 'string', minLength: 40 },
    hashtags: { type: 'string' },
    sourceTopic: { type: ['string', 'null'] },
    angle: { type: 'string' },
    layout: { type: 'string' },
  },
} as const;

export const imageContentSchema = z.object({
  mode: z.enum(['quote', 'single_insight', 'checklist', 'comparison', 'none']),
  headline: z
    .string()
    .trim()
    .refine((v) => countWords(v) <= MAX_IMAGE_HEADLINE_WORDS, 'Image headline must contain at most 12 words')
    .refine((v) => v.length <= MAX_IMAGE_HEADLINE_CHARS, 'Image headline must be at most 70 characters'),
  supportingText: z
    .string()
    .trim()
    .optional()
    .refine(
      (value) => !value || countWords(value) <= MAX_IMAGE_SUBHEADING_WORDS,
      'Image supportingText must contain at most 7 words',
    )
    .refine(
      (value) => !value || value.length <= MAX_IMAGE_SUBHEADING_CHARS,
      'Image supportingText must be at most 55 characters',
    ),
  bulletPoints: z
    .array(
      z
        .string()
        .trim()
        .refine((v) => countWords(v) <= MAX_IMAGE_BULLET_WORDS, 'Each bullet must contain at most 14 words'),
    )
    .max(3)
    .optional(),
});

export const technicalReviewSchema = z.object({
  passed: z.boolean(),
  confidence: z.number().min(0).max(1),
  issues: z.array(
    z.object({
      code: z.string(),
      severity: z.enum(['warning', 'error']),
      excerpt: z.string(),
      explanation: z.string(),
      repairInstruction: z.string(),
    }),
  ),
});

export const postDepthPlanSchema = z.object({
  centralClaim: z.string().min(1),
  whyThisClaimIsInteresting: z.string().nullable(),
  strongestObservations: z.array(z.string()).max(3),
  underlyingCauseOrMechanism: z.string().nullable(),
  deeperInterpretation: z.string().nullable(),
  meaningfulConsequence: z.string().nullable(),
  usefulTensionOrQualification: z.string().nullable(),
  personalPerspective: z.object({ supported: z.boolean(), insight: z.string().nullable() }),
  endingInsight: z.string().nullable(),
  avoidIdeas: z.array(z.string()).max(5),
});

export const batchPlanItemSchema = z.object({
  trendIndex: z.number().nullable(),
  sourceTopic: z.string().nullable(),
  angle: z.enum([
    'technical_mistake',
    'practical_tutorial',
    'architecture_tradeoff',
    'defensible_opinion',
    'debugging_story',
    'product_lesson',
    'reflection',
  ]),
  hookStyle: z.enum([
    'observation',
    'contrarian',
    'mistake',
    'story',
    'question',
    'lesson',
    'comparison',
  ]),
  endingStyle: z.enum(['natural', 'takeaway', 'specific_question', 'summary', 'action']),
  layout: z.enum([
    'short_observation',
    'story_then_lesson',
    'problem_mechanism_fix',
    'opinion_with_reasoning',
    'mini_checklist',
    'comparison',
    'technical_walkthrough',
  ]).optional(),
  rationale: z.string(),
  centralClaim: z.string().min(1).optional(),
  depthPlan: postDepthPlanSchema,
});

export const batchPlanSchema = z.array(batchPlanItemSchema);
