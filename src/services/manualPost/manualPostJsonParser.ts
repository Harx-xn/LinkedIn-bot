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

export function normalizeManualPayload(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;

  const hook = typeof obj.hook === 'string' ? obj.hook.trim() : '';
  const body = typeof obj.body === 'string' ? obj.body.trim() : '';
  const closingLine = typeof obj.closingLine === 'string' ? obj.closingLine.trim() : '';

  if (!hook || !body || !closingLine) return null;

  const planRaw = obj.contentPlan;
  if (!planRaw || typeof planRaw !== 'object' || Array.isArray(planRaw)) return null;
  const plan = planRaw as Record<string, unknown>;

  const requiredPlanFields = ['angle', 'coreClaim', 'audience', 'structure', 'hookType', 'evidenceType', 'ctaType'];
  const contentPlan: Record<string, string> = {};
  for (const field of requiredPlanFields) {
    if (typeof plan[field] !== 'string' || !plan[field].trim()) return null;
    contentPlan[field] = (plan[field] as string).trim();
  }

  return {
    contentPlan,
    hook,
    body,
    closingLine,
    hashtags: normalizeHashtagArray(obj.hashtags),
    sourceTopic: typeof obj.sourceTopic === 'string' ? obj.sourceTopic.trim() : undefined,
  };
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

  const normalized = normalizeManualPayload(extracted);
  if (!normalized) {
    return {
      ok: false,
      stage: 'normalization',
      message: 'Manual post JSON failed normalization',
    };
  }

  const parsed = manualGeneratedPostSchema.safeParse(normalized);
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
