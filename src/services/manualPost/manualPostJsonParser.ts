import { extractBalancedJsonObject } from '../ghostwriterJsonParser';
import { manualGeneratedPostSchema } from './manualPostSchemas';
import type { ManualGeneratedPost, ManualJsonParseResult } from './manualPostTypes';

function stripMarkdownFences(raw: string): string {
  return raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid JSON syntax';
    return { ok: false, message };
  }
}

function normalizeHashtagArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String).map((tag) => tag.trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/[\s,]+/)
      .map((tag) => tag.trim())
      .filter(Boolean);
  }
  return [];
}

type ManualNormalizationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; issues: string[] };

function unwrapManualPayload(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const obj = value as Record<string, unknown>;
  for (const key of ['result', 'post', 'data']) {
    const nested = obj[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) return nested;
  }
  return value;
}

function normalizeManualPayloadDetailed(value: unknown): ManualNormalizationResult {
  const unwrapped = unwrapManualPayload(value);
  if (!unwrapped || typeof unwrapped !== 'object' || Array.isArray(unwrapped)) {
    return { ok: false, issues: ['schema_mismatch: root must be a JSON object'] };
  }
  const obj = unwrapped as Record<string, unknown>;

  const hook = typeof obj.hook === 'string' ? obj.hook.trim() : '';
  const bodyValue = obj.body ?? obj.content ?? obj.postContent ?? obj.text;
  const body = typeof bodyValue === 'string' ? bodyValue.trim() : '';
  const closingLine = typeof obj.closingLine === 'string'
    ? obj.closingLine.trim()
    : typeof obj.closing === 'string'
      ? obj.closing.trim()
      : '';

  if (!body) {
    return {
      ok: false,
      issues: [bodyValue == null ? 'missing_required_field: body' : `invalid_field_type: body (${typeof bodyValue})`],
    };
  }

  const planRaw = obj.contentPlan;
  const suppliedPlan = planRaw && typeof planRaw === 'object' && !Array.isArray(planRaw)
    ? planRaw as Record<string, unknown>
    : {};
  const bodyClaim = body.split(/(?<=[.!?])\s+/)[0]?.trim() || body.slice(0, 160);
  const planDefaults: Record<string, string> = {
    angle: 'manual_post',
    coreClaim: bodyClaim,
    audience: 'supplied target audience',
    structure: 'expression-mode-led',
    hookType: hook ? 'provided' : 'none',
    evidenceType: 'reasoned_observation',
    ctaType: closingLine ? 'natural' : 'none',
  };
  const contentPlan: Record<string, string> = {};
  for (const field of Object.keys(planDefaults)) {
    contentPlan[field] = typeof suppliedPlan[field] === 'string' && suppliedPlan[field].trim()
      ? (suppliedPlan[field] as string).trim()
      : planDefaults[field];
  }

  return {
    ok: true,
    value: {
      contentPlan,
      hook,
      body,
      closingLine,
      hashtags: normalizeHashtagArray(obj.hashtags),
      sourceTopic: typeof obj.sourceTopic === 'string' ? obj.sourceTopic.trim() : undefined,
    },
  };
}

export function normalizeManualPayload(value: unknown): Record<string, unknown> | null {
  const result = normalizeManualPayloadDetailed(value);
  return result.ok ? result.value : null;
}

export function parseManualJsonDetailed(raw: string): ManualJsonParseResult {
  const cleaned = stripMarkdownFences(raw);
  if (!cleaned) {
    return { ok: false, stage: 'json_extraction', message: 'Empty provider output' };
  }

  const direct = tryParseJson(cleaned);
  let extracted: unknown = null;

  if (direct.ok) {
    extracted = direct.value;
  } else {
    const balanced = extractBalancedJsonObject(cleaned);
    if (!balanced) {
      return { ok: false, stage: 'json_syntax', message: direct.message };
    }
    const nested = tryParseJson(balanced);
    if (!nested.ok) {
      return { ok: false, stage: 'json_syntax', message: nested.message };
    }
    extracted = nested.value;
  }

  const normalization = normalizeManualPayloadDetailed(extracted);
  if (!normalization.ok) {
    return {
      ok: false,
      stage: 'normalization',
      message: 'Manual post JSON failed normalization',
      issues: normalization.issues,
    };
  }

  const parsed = manualGeneratedPostSchema.safeParse(normalization.value);
  if (!parsed.success) {
    return {
      ok: false,
      stage: 'schema_validation',
      message: 'Manual post JSON failed schema validation',
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    };
  }

  return { ok: true, data: parsed.data as ManualGeneratedPost };
}

export function parseManualGeneratedPostV2(raw: string): ManualGeneratedPost {
  const result = parseManualJsonDetailed(raw);
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.data;
}
