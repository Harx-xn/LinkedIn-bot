import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import type {
  AuthorContext,
  BatchPostPlan,
  GeneratedPostContent,
  ImageContent,
  PostLayout,
  QualityIssue,
  TechnicalReviewIssue,
  TechnicalReviewResult,
  TrendCandidate,
} from './generationTypes';
import {
  GHOSTWRITER_SYSTEM,
  HASHTAG_RULES,
  LANGUAGE_RULES,
  SPECIFICITY_RULES,
  VARIED_FORMAT_RULES,
  buildAuthorBlock,
  buildExpandSpecificityPrompt,
  buildImageCopyPrompt,
  buildImageRepairPrompt,
  buildJsonRepairPrompt,
  buildPlanBlock,
  buildRepairPrompt,
  buildTechnicalReviewPrompt,
} from './ghostwriterPrompts';
import {
  GeneratedOutputParseError,
  parseGeneratedJsonDetailed,
} from './ghostwriterJsonParser';
import {
  batchPlanSchema,
  GENERATED_POST_OPENAI_JSON_SCHEMA,
  imageContentSchema,
  technicalReviewSchema,
} from './ghostwriterSchemas';
import type { SpecificityResult } from './generationTypes';
import { buildDeterministicBatchPlan } from './ghostwriterBatchPlanner';
import { evaluateTopicCombination } from './ghostwriterQualityService';
import { MANUAL_POST_OPENAI_JSON_SCHEMA } from './manualPost/manualPostSchemas';

dotenv.config();

const OPENAI_CONTENT_MODEL = process.env.OPENAI_CONTENT_MODEL || 'gpt-4o-mini';
const GEMINI_CONTENT_MODEL = process.env.GEMINI_CONTENT_MODEL || 'gemini-flash-latest';
const OPENAI_PLAN_TEMPERATURE = Number(process.env.OPENAI_PLAN_TEMPERATURE ?? 0.3);
const OPENAI_WRITE_TEMPERATURE = Number(process.env.OPENAI_WRITE_TEMPERATURE ?? 0.65);
const OPENAI_REPAIR_TEMPERATURE = Number(process.env.OPENAI_REPAIR_TEMPERATURE ?? 0.25);
const MAX_JSON_REPAIRS = 2;

export class ContentService {
  private geminiKeys: string[] = [];
  private currentKeyIndex = 0;
  private openai: OpenAI | null = null;

  constructor(keys?: { openaiApiKey?: string | null; geminiApiKeys?: string[] | null }) {
    if (keys?.geminiApiKeys && keys.geminiApiKeys.length) {
      this.geminiKeys = keys.geminiApiKeys.filter(Boolean) as string[];
    } else {
      if (process.env.GEMINI_API_KEY) this.geminiKeys.push(process.env.GEMINI_API_KEY);
      if (process.env.GEMINI_API_KEY_2) this.geminiKeys.push(process.env.GEMINI_API_KEY_2);
      let i = 3;
      while (process.env[`GEMINI_API_KEY_${i}`]) {
        this.geminiKeys.push(process.env[`GEMINI_API_KEY_${i}`] as string);
        i++;
      }
    }

    const openaiKey = keys?.openaiApiKey || process.env.OPENAI_API_KEY;
    if (openaiKey) this.openai = new OpenAI({ apiKey: openaiKey });
  }

  private getGeminiModel() {
    const key = this.geminiKeys[this.currentKeyIndex] || 'dummy_key';
    const genAI = new GoogleGenerativeAI(key);
    return genAI.getGenerativeModel({ model: GEMINI_CONTENT_MODEL });
  }

  private async generateWithFallback(
    prompt: string,
    provider: 'GEMINI' | 'OPENAI',
    temperature: number,
  ): Promise<string> {
    try {
      if (provider === 'GEMINI') return await this.generateGeminiPost(prompt, temperature);
      return await this.generateOpensAiPost(prompt, temperature);
    } catch (error) {
      console.warn(`[ghostwriter] Primary provider ${provider} failed, attempting fallback`);
      if (provider === 'GEMINI' && this.openai) {
        return await this.generateOpensAiPost(prompt, temperature);
      }
      if (provider === 'OPENAI' && this.geminiKeys.length > 0) {
        return await this.generateGeminiPost(prompt, temperature);
      }
      throw error;
    }
  }

  private logRejectedProviderOutput(
    provider: 'GEMINI' | 'OPENAI',
    result: Extract<ReturnType<typeof parseGeneratedJsonDetailed>, { ok: false }>,
    raw: string,
  ) {
    console.warn('[ghostwriter] provider output rejected', {
      provider,
      stage: result.stage,
      message: result.message,
      issues: result.issues,
      rawPreview: raw.slice(0, 240),
    });
  }

  private toGeneratedPostContent(
    parsed: Extract<ReturnType<typeof parseGeneratedJsonDetailed>, { ok: true }>['data'],
  ): GeneratedPostContent {
    return {
      ...parsed,
      bulletPoints: parsed.bulletPoints ?? [],
      layout: parsed.layout as PostLayout | undefined,
    };
  }

  async parseProviderOutput(
    raw: string,
    provider: 'GEMINI' | 'OPENAI',
    repairContext: string,
  ): Promise<{ content: GeneratedPostContent; jsonRepairAttempts: number }> {
    let result = parseGeneratedJsonDetailed(raw);
    if (result.ok) {
      return { content: this.toGeneratedPostContent(result.data), jsonRepairAttempts: 0 };
    }

    this.logRejectedProviderOutput(provider, result, raw);
    let jsonRepairAttempts = 0;
    let lastFailure = result;

    for (; jsonRepairAttempts < MAX_JSON_REPAIRS; jsonRepairAttempts++) {
      const repairPrompt = buildJsonRepairPrompt({
        repairContext,
        stage: lastFailure.stage,
        message: lastFailure.message,
        issues: lastFailure.issues,
        invalidOutput: raw,
      });
      const repairedRaw = await this.generateWithFallback(repairPrompt, provider, OPENAI_REPAIR_TEMPERATURE);
      result = parseGeneratedJsonDetailed(repairedRaw);
      if (result.ok) {
        return { content: this.toGeneratedPostContent(result.data), jsonRepairAttempts: jsonRepairAttempts + 1 };
      }
      this.logRejectedProviderOutput(provider, result, repairedRaw);
      lastFailure = result;
      raw = repairedRaw;
    }

    throw new GeneratedOutputParseError(
      lastFailure.stage,
      lastFailure.message,
      lastFailure.issues ?? [],
    );
  }

  private async parseWithRepair(
    raw: string,
    provider: 'GEMINI' | 'OPENAI',
    repairContext: string,
  ): Promise<GeneratedPostContent> {
    const { content } = await this.parseProviderOutput(raw, provider, repairContext);
    return content;
  }

  async planBatch(
    trends: TrendCandidate[],
    author: AuthorContext,
    count: number,
    provider: 'GEMINI' | 'OPENAI' = 'OPENAI',
  ): Promise<BatchPostPlan[]> {
    const deterministic = buildDeterministicBatchPlan(trends.slice(0, count), count);

    const prompt = `${GHOSTWRITER_SYSTEM}
${buildAuthorBlock(author)}

Create a batch plan for ${count} LinkedIn posts.

Available trends (inspiration only):
${trends.slice(0, count + 3).map((t, i) => `${i}: ${t.topic}`).join('\n')}

Rules:
- Distribute angles: technical_mistake, practical_tutorial, architecture_tradeoff, defensible_opinion, debugging_story, product_lesson, reflection
- No more than 2 question endings in ${count} posts
- No hook style repeated more than twice
- At least 2 takeaway endings
- Do not repeat source topics unless necessary

Output JSON array only:
[
  {
    "trendIndex": 0,
    "sourceTopic": "...",
    "angle": "technical_mistake",
    "hookStyle": "observation",
    "endingStyle": "takeaway",
    "layout": "problem_mechanism_fix",
    "rationale": "..."
  }
]`;

    try {
      const raw = await this.generateWithFallback(prompt, provider, OPENAI_PLAN_TEMPERATURE);
      const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
      const json = JSON.parse(cleaned);
      const validated = batchPlanSchema.safeParse(json);
      if (validated.success && validated.data.length >= count) {
        console.log('[ghostwriter] AI batch plan accepted', { count: validated.data.length });
        return validated.data.slice(0, count) as BatchPostPlan[];
      }
      console.warn('[ghostwriter] AI batch plan invalid; using deterministic plan');
    } catch (err) {
      console.warn('[ghostwriter] AI batch plan failed; using deterministic plan', err);
    }

    return deterministic;
  }

  async generatePlannedPost(
    plan: BatchPostPlan,
    author: AuthorContext,
    sourceLink = '',
    provider: 'GEMINI' | 'OPENAI' = 'OPENAI',
    trend?: TrendCandidate | null,
  ): Promise<GeneratedPostContent> {
    const prompt = `${GHOSTWRITER_SYSTEM}
${buildAuthorBlock(author)}
${buildPlanBlock(plan, sourceLink, trend)}

${SPECIFICITY_RULES}
${VARIED_FORMAT_RULES}
${HASHTAG_RULES}
${LANGUAGE_RULES}

Output MUST be valid JSON with headline, subheadline, bulletPoints, body, hashtags, sourceTopic, angle, layout.`;

    const raw = await this.generateStructuredPost(prompt, provider, OPENAI_WRITE_TEMPERATURE);
    const parsed = await this.parseWithRepair(raw, provider, prompt);
    return {
      ...parsed,
      sourceTopic: plan.sourceTopic,
      angle: plan.angle,
      layout: plan.layout,
    };
  }

  async expandSpecificity(
    post: GeneratedPostContent,
    specificity: SpecificityResult | undefined,
    author: AuthorContext,
    plan: BatchPostPlan,
    provider: 'GEMINI' | 'OPENAI' = 'OPENAI',
  ): Promise<GeneratedPostContent> {
    const prompt = buildExpandSpecificityPrompt(post, specificity, author, plan);
    const raw = await this.generateStructuredPost(prompt, provider, OPENAI_REPAIR_TEMPERATURE);
    return this.parseWithRepair(raw, provider, prompt);
  }

  private async generateStructuredPost(
    prompt: string,
    provider: 'GEMINI' | 'OPENAI',
    temperature: number,
  ): Promise<string> {
    if (provider === 'OPENAI' && this.openai) {
      try {
        return await this.generateOpenAiStructuredPost(prompt, temperature);
      } catch (err) {
        console.warn('[ghostwriter] OpenAI structured output failed; falling back', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return this.generateWithFallback(prompt, provider, temperature);
  }

  hasProvider(provider: 'GEMINI' | 'OPENAI'): boolean {
    if (provider === 'OPENAI') return !!this.openai;
    return this.geminiKeys.length > 0;
  }

  async generateManualPost(
    input: {
      topic: string;
      additionalInstructions?: string;
      tone: string;
      description: string;
      niches?: string[];
    },
    provider: 'GEMINI' | 'OPENAI' = 'OPENAI',
  ): Promise<GeneratedPostContent> {
    const author: AuthorContext = {
      description: input.description,
      tone: input.tone,
      niches: input.niches ?? [],
    };

    const extraInstructions = input.additionalInstructions?.trim()
      ? `\nAdditional user instructions:\n${input.additionalInstructions.trim()}`
      : '';

    const prompt = `${GHOSTWRITER_SYSTEM}
${buildAuthorBlock(author)}

Write an original LinkedIn post for the manual composer based on this topic or instruction:
${input.topic.trim()}
${extraInstructions}

Requirements:
- Follow the configured author voice and expertise.
- Use a strong but non-clickbait hook in the first lines.
- Provide useful specificity and practical insight.
- Do not invent statistics, customers, incidents, or personal experiences.
- Avoid excessive one-line fragments and unnecessary emojis.
- Avoid repetitive generic AI phrasing.
- Keep the final formatted post within LinkedIn's 3,000-character limit.
- Use hashtags only when they add value.

${SPECIFICITY_RULES}
${VARIED_FORMAT_RULES}
${HASHTAG_RULES}
${LANGUAGE_RULES}

Output MUST be valid JSON with headline, subheadline, bulletPoints, body, hashtags, sourceTopic.`;

    const raw = await this.generateStructuredPost(prompt, provider, OPENAI_WRITE_TEMPERATURE);
    const parsed = await this.parseWithRepair(raw, provider, prompt);
    return {
      ...parsed,
      sourceTopic: input.topic.trim(),
    };
  }

  async generatePost(
    topic: string,
    articleLink: string,
    provider: 'GEMINI' | 'OPENAI' = 'OPENAI',
    tone: string = 'Professional',
    description: string = '',
    niches: string[] = [],
  ): Promise<GeneratedPostContent> {
    const author: AuthorContext = { description, tone, niches };
    const plan: BatchPostPlan = {
      trendIndex: 0,
      sourceTopic: topic,
      angle: 'product_lesson',
      hookStyle: 'observation',
      endingStyle: 'takeaway',
      layout: 'short_observation',
      rationale: 'Single-post generation fallback',
    };
    return this.generatePlannedPost(plan, author, articleLink, provider);
  }

  async generateMixedPost(
    trends: { topic: string; link: string }[],
    provider: 'GEMINI' | 'OPENAI' = 'OPENAI',
    tone: string = 'Professional',
    description: string = '',
    niches: string[] = [],
  ): Promise<GeneratedPostContent> {
    const author: AuthorContext = { description, tone, niches };
    if (trends.length < 2) {
      const t = trends[0];
      return this.generatePost(t.topic, t.link, provider, tone, description, niches);
    }

    const combine = evaluateTopicCombination(trends[0].topic, trends[1].topic, author);
    if (!combine.canCombine) {
      console.warn('[ghostwriter] Mixed topics rejected', { reason: combine.reason });
      return this.generatePost(trends[0].topic, trends[0].link, provider, tone, description, niches);
    }

    const plan: BatchPostPlan = {
      trendIndex: null,
      sourceTopic: `${trends[0].topic} + ${trends[1].topic}`,
      angle: 'architecture_tradeoff',
      hookStyle: 'comparison',
      endingStyle: 'takeaway',
      layout: 'comparison',
      rationale: combine.connection ?? 'Related topics with defensible connection',
    };

    const links = trends.map((t) => `- ${t.topic}: ${t.link}`).join('\n');
    const prompt = `${GHOSTWRITER_SYSTEM}
${buildAuthorBlock(author)}
${buildPlanBlock(plan)}

Only combine these topics because: ${combine.connection}
References:
${links}

${VARIED_FORMAT_RULES}
${HASHTAG_RULES}
${LANGUAGE_RULES}

Output valid JSON with headline, subheadline, bulletPoints, body, hashtags.`;

    const raw = await this.generateWithFallback(prompt, provider, OPENAI_WRITE_TEMPERATURE);
    return this.parseWithRepair(raw, provider, prompt);
  }

  async repairPost(
    post: GeneratedPostContent,
    reasons: Array<string | QualityIssue | TechnicalReviewIssue>,
    author: AuthorContext,
    provider: 'GEMINI' | 'OPENAI' = 'OPENAI',
    plan?: BatchPostPlan,
  ): Promise<GeneratedPostContent> {
    const prompt = buildRepairPrompt(post, reasons, author, plan);
    const raw = await this.generateStructuredPost(prompt, provider, OPENAI_REPAIR_TEMPERATURE);
    return this.parseWithRepair(raw, provider, prompt);
  }

  async reviewTechnicalClaims(
    post: GeneratedPostContent,
    author: AuthorContext,
    plan: BatchPostPlan,
    provider: 'GEMINI' | 'OPENAI' = 'OPENAI',
  ): Promise<TechnicalReviewResult> {
    const prompt = buildTechnicalReviewPrompt(post, author, plan);
    const raw = await this.generateWithFallback(prompt, provider, OPENAI_REPAIR_TEMPERATURE);
    const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    try {
      const parsed = technicalReviewSchema.safeParse(JSON.parse(cleaned));
      if (parsed.success) {
        const issues = parsed.data.issues as TechnicalReviewIssue[];
        return {
          passed: !issues.some((i) => i.severity === 'error'),
          confidence: parsed.data.confidence,
          issues,
        };
      }
    } catch {
      // fall through
    }

    return { passed: true, confidence: 0.5, issues: [] };
  }

  async generateImageCopy(
    approvedBody: string,
    plan: BatchPostPlan,
    provider: 'GEMINI' | 'OPENAI' = 'OPENAI',
  ): Promise<ImageContent | null> {
    const prompt = buildImageCopyPrompt(approvedBody, plan);
    const raw = await this.generateWithFallback(prompt, provider, OPENAI_REPAIR_TEMPERATURE);
    const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    try {
      const parsed = imageContentSchema.safeParse(JSON.parse(cleaned));
      if (parsed.success) return parsed.data;
    } catch {
      // fall through
    }
    return null;
  }

  async repairImageCopy(
    approvedBody: string,
    image: ImageContent,
    issues: QualityIssue[],
    provider: 'GEMINI' | 'OPENAI' = 'OPENAI',
  ): Promise<ImageContent | null> {
    const prompt = buildImageRepairPrompt(approvedBody, image, issues);
    const raw = await this.generateWithFallback(prompt, provider, OPENAI_REPAIR_TEMPERATURE);
    const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    try {
      const parsed = imageContentSchema.safeParse(JSON.parse(cleaned));
      if (parsed.success) return parsed.data;
    } catch {
      // fall through
    }
    return null;
  }

  /**
   * Manual-composer only. Returns raw provider text without batch parsing.
   */
  async fetchComposerGenerationRaw(
    prompt: string,
    provider: 'GEMINI' | 'OPENAI' = 'OPENAI',
  ): Promise<string> {
    if (provider === 'OPENAI' && this.openai) {
      try {
        return await this.generateOpenAiManualStructuredPost(prompt, OPENAI_WRITE_TEMPERATURE);
      } catch (err) {
        console.warn('[manual-post-v2] OpenAI manual structured output failed; falling back', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return this.generateWithFallback(prompt, provider, OPENAI_WRITE_TEMPERATURE);
  }

  /**
   * Manual-composer only. Returns raw provider text without batch parsing.
   */
  async fetchComposerRewriteRaw(
    prompt: string,
    provider: 'GEMINI' | 'OPENAI' = 'OPENAI',
  ): Promise<string> {
    return this.generateWithFallback(prompt, provider, OPENAI_WRITE_TEMPERATURE);
  }

  /**
   * Manual-composer only. Used for manual JSON repair attempts.
   */
  async fetchComposerRepairRaw(
    prompt: string,
    provider: 'GEMINI' | 'OPENAI' = 'OPENAI',
  ): Promise<string> {
    return this.generateWithFallback(prompt, provider, OPENAI_REPAIR_TEMPERATURE);
  }

  /**
   * Manual-composer only. Batch generation must not call this method.
   * Runs a pre-built manual prompt through structured generation + JSON repair.
   */
  async executeComposerGenerationPrompt(
    prompt: string,
    provider: 'GEMINI' | 'OPENAI' = 'OPENAI',
  ): Promise<GeneratedPostContent> {
    const raw = await this.generateStructuredPost(prompt, provider, OPENAI_WRITE_TEMPERATURE);
    return this.parseWithRepair(raw, provider, prompt);
  }

  /**
   * Manual-composer only. Batch generation must not call this method.
   * Runs a pre-built manual rewrite prompt through provider fallback + JSON repair.
   */
  async executeComposerRewritePrompt(
    prompt: string,
    provider: 'GEMINI' | 'OPENAI' = 'OPENAI',
  ): Promise<GeneratedPostContent> {
    const raw = await this.generateWithFallback(prompt, provider, OPENAI_WRITE_TEMPERATURE);
    return this.parseWithRepair(raw, provider, prompt);
  }

  async rewritePost(
    currentContent: string,
    suggestions: string,
    provider: 'GEMINI' | 'OPENAI' = 'OPENAI',
    tone: string = 'Professional',
    description: string = '',
  ): Promise<GeneratedPostContent> {
    const author: AuthorContext = { description, tone };
    const prompt = `${GHOSTWRITER_SYSTEM}
${buildAuthorBlock(author)}

CURRENT POST:
${currentContent}

USER SUGGESTIONS:
${suggestions || 'Improve clarity, specificity, and technical accuracy while keeping the same topic.'}

Rules:
- Apply suggestions directly.
- Do not invent unverifiable facts or unsupported first-person claims.
- Contact/website lines are controlled by app settings; do not add or preserve them unless suggestions explicitly ask.

${VARIED_FORMAT_RULES}
${HASHTAG_RULES}
${LANGUAGE_RULES}

Output valid JSON with headline, subheadline, bulletPoints, body, hashtags.`;

    const raw = await this.generateWithFallback(prompt, provider, OPENAI_WRITE_TEMPERATURE);
    return this.parseWithRepair(raw, provider, prompt);
  }

  private async generateOpenAiManualStructuredPost(prompt: string, temperature: number): Promise<string> {
    if (!this.openai) throw new Error('OPENAI_API_KEY not found');
    const response = await this.openai.chat.completions.create({
      model: OPENAI_CONTENT_MODEL,
      temperature,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'manual_post',
          strict: true,
          schema: MANUAL_POST_OPENAI_JSON_SCHEMA,
        },
      },
      messages: [
        {
          role: 'system',
          content: 'You are a LinkedIn manual post composer. Return JSON only matching the requested schema.',
        },
        { role: 'user', content: prompt },
      ],
    });
    return response.choices[0].message.content || '';
  }

  private async generateOpenAiStructuredPost(prompt: string, temperature: number): Promise<string> {
    if (!this.openai) throw new Error('OPENAI_API_KEY not found');
    const response = await this.openai.chat.completions.create({
      model: OPENAI_CONTENT_MODEL,
      temperature,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'generated_post',
          strict: true,
          schema: GENERATED_POST_OPENAI_JSON_SCHEMA,
        },
      },
      messages: [
        { role: 'system', content: GHOSTWRITER_SYSTEM },
        { role: 'user', content: prompt },
      ],
    });
    return response.choices[0].message.content || '';
  }

  private async generateGeminiPost(prompt: string, temperature: number, retryCount = 0): Promise<string> {
    if (this.geminiKeys.length === 0) {
      return `[MOCK] Gemini Post. (Set GEMINI_API_KEY)`;
    }

    try {
      const model = this.getGeminiModel();
      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature,
          responseMimeType: 'application/json',
        },
      });
      const response = await result.response;
      return response.text();
    } catch (error: any) {
      if (error?.status === 429) {
        if (this.geminiKeys.length > 1 && retryCount < this.geminiKeys.length) {
          this.currentKeyIndex = (this.currentKeyIndex + 1) % this.geminiKeys.length;
          return this.generateGeminiPost(prompt, temperature, retryCount + 1);
        }
        if (retryCount < 3) {
          await new Promise((r) => setTimeout(r, 30000));
          return this.generateGeminiPost(prompt, temperature, retryCount + 1);
        }
      }
      throw error;
    }
  }

  private async generateOpensAiPost(prompt: string, temperature: number): Promise<string> {
    if (!this.openai) throw new Error('OPENAI_API_KEY not found');
    const response = await this.openai.chat.completions.create({
      model: OPENAI_CONTENT_MODEL,
      temperature,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: GHOSTWRITER_SYSTEM },
        { role: 'user', content: prompt },
      ],
    });
    return response.choices[0].message.content || '';
  }
}
