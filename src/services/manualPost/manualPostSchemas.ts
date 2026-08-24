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
  hook: z.string(),
  body: z.string().min(40),
  closingLine: z.string(),
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
    hook: { type: 'string' },
    body: { type: 'string', minLength: 40 },
    closingLine: { type: 'string' },
    hashtags: { type: 'array', items: { type: 'string' }, maxItems: 3 },
    sourceTopic: { type: 'string' },
  },
} as const;

/** Strict OpenAI schema for manual planning only. Draft generation must not use this. */
export const MANUAL_PLANNING_OPENAI_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['angles'],
  properties: {
    angles: {
      type: 'array',
      minItems: 3,
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'title', 'coreClaim', 'audience', 'structure', 'evidenceMode',
          'experienceRelevance',
          'specificity', 'novelty', 'audienceFit', 'voiceFit',
          'evidenceAvailability', 'hookCandidates',
          'depthPlan',
        ],
        properties: {
          title: { type: 'string', minLength: 1 },
          coreClaim: { type: 'string', minLength: 1 },
          audience: { type: 'string', minLength: 1 },
          structure: { type: 'string', minLength: 1 },
          evidenceMode: {
            type: 'string',
            enum: ['technical_example', 'reasoned_observation', 'labeled_hypothetical', 'supplied_experience'],
          },
          experienceRelevance: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
          specificity: { type: 'number', minimum: 0, maximum: 10 },
          novelty: { type: 'number', minimum: 0, maximum: 10 },
          audienceFit: { type: 'number', minimum: 0, maximum: 10 },
          voiceFit: { type: 'number', minimum: 0, maximum: 10 },
          evidenceAvailability: { type: 'number', minimum: 0, maximum: 10 },
          hookCandidates: {
            type: 'array',
            minItems: 0,
            maxItems: 3,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['text', 'type', 'specificity', 'curiosity', 'topicRelevance', 'clarity', 'voiceFit'],
              properties: {
                text: { type: 'string', minLength: 1 },
                type: { type: 'string', minLength: 1 },
                specificity: { type: 'number', minimum: 0, maximum: 10 },
                curiosity: { type: 'number', minimum: 0, maximum: 10 },
                topicRelevance: { type: 'number', minimum: 0, maximum: 10 },
                clarity: { type: 'number', minimum: 0, maximum: 10 },
                voiceFit: { type: 'number', minimum: 0, maximum: 10 },
              },
            },
          },
          depthPlan: {
            type: 'object',
            additionalProperties: false,
            required: ['centralClaim', 'whyThisClaimIsInteresting', 'strongestObservations', 'underlyingCauseOrMechanism', 'deeperInterpretation', 'meaningfulConsequence', 'usefulTensionOrQualification', 'personalPerspective', 'endingInsight', 'avoidIdeas'],
            properties: {
              centralClaim: { type: 'string', minLength: 1 },
              whyThisClaimIsInteresting: { type: ['string', 'null'] },
              strongestObservations: { type: 'array', items: { type: 'string' }, maxItems: 3 },
              underlyingCauseOrMechanism: { type: ['string', 'null'] },
              deeperInterpretation: { type: ['string', 'null'] },
              meaningfulConsequence: { type: ['string', 'null'] },
              usefulTensionOrQualification: { type: ['string', 'null'] },
              personalPerspective: {
                type: 'object', additionalProperties: false, required: ['supported', 'insight'],
                properties: { supported: { type: 'boolean' }, insight: { type: ['string', 'null'] } },
              },
              endingInsight: { type: ['string', 'null'] },
              avoidIdeas: { type: 'array', items: { type: 'string' }, maxItems: 5 },
            },
          },
        },
      },
    },
  },
} as const;
