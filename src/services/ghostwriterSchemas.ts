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

/** Strict writer schema. Planner metadata is injected by orchestration, not echoed by the model. */
export const GENERATED_POST_OPENAI_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'subheadline', 'bulletPoints', 'body', 'hashtags'],
  properties: {
    headline: { type: 'string', minLength: 1 },
    subheadline: { type: 'string' },
    bulletPoints: { type: 'array', items: { type: 'string' } },
    body: { type: 'string', minLength: 40 },
    hashtags: { type: 'string' },
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
  informationDensity: z.number().min(0).max(100),
  progressionQuality: z.number().min(0).max(100),
  redundancyRisk: z.number().min(0).max(100),
  genericDiscourseRisk: z.number().min(0).max(100),
  claimFidelity: z.number().min(0).max(100),
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
  whyThisClaimIsInteresting: z.string().nullable().optional().default(null),
  strongestObservations: z.array(z.string()).max(3).optional().default([]),
  underlyingCauseOrMechanism: z.string().nullable().optional().default(null),
  deeperInterpretation: z.string().nullable().optional().default(null),
  meaningfulConsequence: z.string().nullable().optional().default(null),
  usefulTensionOrQualification: z.string().nullable().optional().default(null),
  personalPerspective: z.object({ supported: z.boolean(), insight: z.string().nullable() })
    .optional()
    .default({ supported: false, insight: null }),
  endingInsight: z.string().nullable().optional().default(null),
  avoidIdeas: z.array(z.string()).max(5).optional().default([]),
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
  claimSource: z.enum(['STRATEGY_SELECTED', 'SEARCH_DISCOVERED', 'LEGACY_TOPIC', 'FALLBACK']).optional(),
  selectedCentralClaim: z.string().min(1).optional(),
  depthPlan: postDepthPlanSchema,
  depthClass: z.enum(['COMPACT', 'STANDARD', 'DEEP']).optional(),
  targetLengthRange: z.object({ min: z.number().int().positive(), max: z.number().int().positive() })
    .refine((range) => range.min <= range.max, 'targetLengthRange min must not exceed max')
    .optional(),
});

export const batchPlanSchema = z.array(batchPlanItemSchema);
