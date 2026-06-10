import { z } from 'zod';

export const manualContentPlanSchema = z.object({
  angle: z.string().min(1),
  coreClaim: z.string().min(1),
  audience: z.string().min(1),
  structure: z.string().min(1),
  hookType: z.string().min(1),
  evidenceType: z.string().min(1),
  ctaType: z.string().min(1),
});

export const manualGeneratedPostSchema = z.object({
  contentPlan: manualContentPlanSchema,
  hook: z.string().min(1),
  body: z.string().min(40),
  closingLine: z.string().min(1),
  hashtags: z.array(z.string()).max(3).default([]),
  sourceTopic: z.string().optional(),
});

/** Strict OpenAI schema for manual-composer output only. Batch must not use this. */
export const MANUAL_POST_OPENAI_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['contentPlan', 'hook', 'body', 'closingLine', 'hashtags', 'sourceTopic'],
  properties: {
    contentPlan: {
      type: 'object',
      additionalProperties: false,
      required: ['angle', 'coreClaim', 'audience', 'structure', 'hookType', 'evidenceType', 'ctaType'],
      properties: {
        angle: { type: 'string', minLength: 1 },
        coreClaim: { type: 'string', minLength: 1 },
        audience: { type: 'string', minLength: 1 },
        structure: { type: 'string', minLength: 1 },
        hookType: { type: 'string', minLength: 1 },
        evidenceType: { type: 'string', minLength: 1 },
        ctaType: { type: 'string', minLength: 1 },
      },
    },
    hook: { type: 'string', minLength: 1 },
    body: { type: 'string', minLength: 40 },
    closingLine: { type: 'string', minLength: 1 },
    hashtags: { type: 'array', items: { type: 'string' }, maxItems: 3 },
    sourceTopic: { type: 'string' },
  },
} as const;
