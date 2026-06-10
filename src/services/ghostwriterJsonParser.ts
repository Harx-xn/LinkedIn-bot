import { generatedPostSchema } from './ghostwriterSchemas';
import type { GeneratedJsonParseResult } from './generationTypes';

export class GeneratedOutputParseError extends Error {
  stage: GeneratedJsonParseResult extends { ok: false } ? GeneratedJsonParseResult['stage'] : string;
  issues: string[];

  constructor(
    stage: GeneratedJsonParseResult extends { ok: false } ? GeneratedJsonParseResult['stage'] : string,
    message: string,
    issues: string[] = [],
  ) {
    super(message);
    this.name = 'GeneratedOutputParseError';
    this.stage = stage;
    this.issues = issues;
  }
}

function stripMarkdownFences(raw: string): string {
  return raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
}

/**
 * Extract the first complete balanced JSON object, respecting strings and escapes.
 */
export function extractBalancedJsonObject(raw: string): string | null {
  const text = stripMarkdownFences(raw);
  const start = text.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid JSON syntax';
    return { ok: false, message };
  }
}

function coerceConfidence(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function normalizeGeneratedPayload(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;

  const body = obj.body ?? obj.content ?? obj.post ?? obj.text;
  const headline = obj.headline ?? obj.title ?? obj.subject;
  if (typeof body !== 'string' || typeof headline !== 'string') return null;

  const bulletPoints = Array.isArray(obj.bulletPoints)
    ? obj.bulletPoints.map(String)
    : typeof obj.bulletPoints === 'string'
      ? [obj.bulletPoints]
      : [];

  return {
    headline: headline.trim(),
    subheadline: typeof obj.subheadline === 'string' ? obj.subheadline : '',
    bulletPoints,
    body: body.trim(),
    hashtags: typeof obj.hashtags === 'string' ? obj.hashtags : '',
    sourceTopic: typeof obj.sourceTopic === 'string' ? obj.sourceTopic : obj.sourceTopic === null ? null : undefined,
    angle: typeof obj.angle === 'string' ? obj.angle : undefined,
    layout: typeof obj.layout === 'string' ? obj.layout : undefined,
    confidence: coerceConfidence(obj.confidence),
    warnings: Array.isArray(obj.warnings) ? obj.warnings.map(String) : undefined,
  };
}

export function parseGeneratedJsonDetailed(raw: string): GeneratedJsonParseResult {
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
      return {
        ok: false,
        stage: 'json_extraction',
        message: 'Could not extract a balanced JSON object',
        issues: [direct.message],
      };
    }

    const parsed = tryParseJson(balanced);
    if (!parsed.ok) {
      return {
        ok: false,
        stage: 'json_parse',
        message: parsed.message,
        extracted: balanced.slice(0, 500),
      };
    }
    extracted = parsed.value;
  }

  const normalized = normalizeGeneratedPayload(extracted);
  if (!normalized) {
    return {
      ok: false,
      stage: 'normalization',
      message: 'JSON parsed but required post fields were missing or invalid',
      extracted,
    };
  }

  const validated = generatedPostSchema.safeParse(normalized);
  if (!validated.success) {
    return {
      ok: false,
      stage: 'schema_validation',
      message: 'Generated post JSON failed schema validation',
      issues: validated.error.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`),
      extracted: normalized,
    };
  }

  return { ok: true, data: validated.data };
}

export function parseGeneratedJson(raw: string) {
  const result = parseGeneratedJsonDetailed(raw);
  return result.ok ? result.data : null;
}
