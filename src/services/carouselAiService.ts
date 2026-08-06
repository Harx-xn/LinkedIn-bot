import { randomUUID } from 'crypto';
import { z } from 'zod';
import { ContentService } from './contentService';
import { getContentServiceForUser } from './userContentContext';
import { prisma } from '../prismaClient';
import { getUserPlanEntitlements, PlanLimitError } from './planEntitlementService';

export const CAROUSEL_AI_DAILY_LIMIT = 8;
export const MAX_AI_CAROUSEL_SLIDES_PER_GENERATION = 20;
export const MIN_POST_CAROUSEL_SLIDES = 5;

const generatedSlideSchema = z.object({
  type: z.enum(['TITLE', 'BODY', 'RECAP', 'CLOSING']),
  label: z.string().max(80).default(''),
  heading: z.string().min(1).max(180),
  body: z.string().max(700).default(''),
  bullets: z.array(z.string().min(1).max(180)).max(6).default([]),
  cta: z.string().max(180).default(''),
});

const generatedCarouselSchema = z.object({
  title: z.string().min(1).max(120),
  slides: z.array(generatedSlideSchema),
});

type QuotaEntry = { day: string; used: number };
const quotas = new Map<string, QuotaEntry>();

function today() { return new Date().toISOString().slice(0, 10); }
function resetsAt() { const date = new Date(); date.setUTCDate(date.getUTCDate() + 1); date.setUTCHours(0, 0, 0, 0); return date.toISOString(); }

export function getCarouselAiQuota(key: string) {
  const day = today();
  const current = quotas.get(key);
  const used = current?.day === day ? current.used : 0;
  return { limit: CAROUSEL_AI_DAILY_LIMIT, used, remaining: Math.max(0, CAROUSEL_AI_DAILY_LIMIT - used), resetsAt: resetsAt() };
}

function recordGeneration(key: string) {
  const quota = getCarouselAiQuota(key);
  quotas.set(key, { day: today(), used: quota.used + 1 });
  return getCarouselAiQuota(key);
}

function parseJson(raw: string) {
  const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first < 0 || last < first) throw new Error('AI returned an invalid carousel response');
  return JSON.parse(cleaned.slice(first, last + 1));
}

export async function generateCarouselWithAi(input: { topic: string; instructions?: string; userId?: string }) {
  const service = input.userId ? await getContentServiceForUser(input.userId) : new ContentService();
  const provider = service.hasProvider('OPENAI') ? 'OPENAI' : service.hasProvider('GEMINI') ? 'GEMINI' : null;
  if (!provider) throw new Error('AI generation is not configured. Please try again later.');

  const prompt = `Create an original LinkedIn carousel about: ${input.topic}\n
Additional instructions: ${input.instructions || 'None'}\n
Choose the ideal number of slides for the topic, between 3 and 20. Return the finished content in slide format as JSON: {"title":"...","slides":[{"type":"TITLE|BODY|RECAP|CLOSING","label":"...","heading":"...","body":"...","bullets":[],"cta":""}]}.\n
Rules:\n
- Slide 1 must be TITLE with a strong, specific promise.\n
- The final slide must be CLOSING with a useful call to action.\n
- When there are 5 or more slides, the penultimate slide must be RECAP with 3-5 concise bullets.\n
- All remaining slides must be BODY slides with one practical idea each.\n
- Use short mobile-readable copy, concrete language, and a coherent narrative.\n
- Do not invent statistics, customers, quotes, or personal experiences.\n
- Labels should be concise running headers. Output JSON only.`;

  // Generic JSON mode is required here; the manual composer call enforces its own post schema.
  const raw = await service.fetchComposerRewriteRaw(prompt, provider, 5000);
  const parsed = generatedCarouselSchema.safeParse(parseJson(raw));
  if (!parsed.success || parsed.data.slides.length < 3 || parsed.data.slides.length > 20) {
    throw new Error('AI returned an incomplete carousel. Please generate again.');
  }

  const slideCount = parsed.data.slides.length;

  return {
    title: parsed.data.title,
    slides: parsed.data.slides.map((item, index) => {
      const isFirst = index === 0;
      const isLast = index === slideCount - 1;
      const isRecap = slideCount >= 5 && index === slideCount - 2;
      const type = isFirst ? 'TITLE' : isLast ? 'CLOSING' : isRecap ? 'RECAP' : 'BODY';
      return {
        id: randomUUID(), type, label: item.label, heading: item.heading,
        body: item.body, bullets: type === 'RECAP' ? item.bullets : [], cta: type === 'CLOSING' ? item.cta : '',
        layout: type === 'BODY' ? 'Editorial' : 'Classic', backgroundDesign: 'clean', backgroundIntensity: 'balanced',
      };
    }),
  };
}

export async function generateCarouselFromPost(input: { postContent: string; slideCount: number; instructions?: string; userId: string }) {
  if (!Number.isInteger(input.slideCount) || input.slideCount < MIN_POST_CAROUSEL_SLIDES || input.slideCount > MAX_AI_CAROUSEL_SLIDES_PER_GENERATION) {
    throw new Error(`Slide count must be between ${MIN_POST_CAROUSEL_SLIDES} and ${MAX_AI_CAROUSEL_SLIDES_PER_GENERATION}.`);
  }
  const service = await getContentServiceForUser(input.userId);
  const provider = service.hasProvider('OPENAI') ? 'OPENAI' : service.hasProvider('GEMINI') ? 'GEMINI' : null;
  if (!provider) throw new Error('AI generation is not configured. Please try again later.');
  const prompt = `Transform the LinkedIn post below into exactly ${input.slideCount} carousel slides.

SOURCE POST (preserve its main argument and meaningful factual claims):
${input.postContent}

OPTIONAL INSTRUCTIONS:
${input.instructions || 'None'}

Return JSON only: {"title":"...","slides":[{"type":"TITLE|BODY|RECAP|CLOSING","label":"...","heading":"...","body":"...","bullets":[],"cta":""}]}.

Rules:
- Return exactly ${input.slideCount} slides. Slide 1 is TITLE and slide ${input.slideCount} is CLOSING.
- Use one primary idea per slide and a logical sequence. Use a RECAP near the end when appropriate.
- Preserve the source argument and facts. Never invent statistics, quotes, customers, or personal experiences.
- Keep copy concise and mobile-readable. Avoid repetition, HTML, CSS, and headings such as "Slide 1".
- The closing slide must contain a useful CTA.`;
  const raw = await service.fetchComposerRewriteRaw(prompt, provider, 7000);
  const parsed = generatedCarouselSchema.safeParse(parseJson(raw));
  if (!parsed.success || parsed.data.slides.length !== input.slideCount) {
    throw new Error(`AI must return exactly ${input.slideCount} valid slides.`);
  }
  return {
    title: parsed.data.title,
    slides: parsed.data.slides.map((item, index) => {
      const type = index === 0 ? 'TITLE' : index === input.slideCount - 1 ? 'CLOSING' : item.type === 'RECAP' ? 'RECAP' : 'BODY';
      return { id: randomUUID(), type, label: item.label, heading: item.heading, body: item.body, bullets: type === 'RECAP' ? item.bullets : [], cta: type === 'CLOSING' ? item.cta : '' };
    }),
  };
}

export function completeCarouselAiGeneration(key: string) { return recordGeneration(key); }

export async function getPlanCarouselAiQuota(userId: string) {
  const entitlements = await getUserPlanEntitlements(userId);
  const limit = entitlements.carouselAiGenerationLimit;
  const used = entitlements.usage.carouselAiGenerationsThisPeriod;
  return {
    limit,
    used,
    remaining: limit == null ? null : Math.max(0, limit - used),
    resetsAt: entitlements.periodEnd.toISOString(),
  };
}

export async function assertCanGenerateCarouselWithAi(userId: string) {
  const quota = await getPlanCarouselAiQuota(userId);
  if (quota.remaining !== null && quota.remaining <= 0) {
    throw new PlanLimitError(
      'CAROUSEL_AI_GENERATION_LIMIT_REACHED',
      'AI carousel generation limit reached for your current billing period.',
      429,
    );
  }
  return quota;
}

export async function recordPlanCarouselAiGeneration(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { regionId: true } });
  await prisma.carouselAiGenerationUsage.create({ data: { userId, regionId: user?.regionId ?? null } });
  return getPlanCarouselAiQuota(userId);
}
