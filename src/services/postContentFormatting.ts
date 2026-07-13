import { normalizeLinkedInLineBody } from './linkedinLineFormatting';

/**
 * Post content shaping helpers shared by the bot generation flow and the
 * rewrite flow. These run AFTER the AI returns JSON and BEFORE we save a post:
 *
 *   - normalizeTaplioStyleBody: enforce punchy, line-by-line LinkedIn style
 *   - normalizeHashtags: dynamic, content-based hashtags (no stale constants)
 *   - appendOptionalContactAndWebsite: optionally append website/contact CTA
 *
 * Nothing here invents user data: contact/website come only from the user's own
 * BotConfig fields (contactInfo, websiteUrl) or, as a fallback, description /

 */

// Safe boolean coercion so strings like "false" / 0 don't become true.
export function parseBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
  if (typeof value === 'number') return value === 1;
  return fallback;
}

// Trim and cap optional text fields; empty string -> null.
export function cleanOptionalText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLength);
}

// Normalize a website URL for storage. Throws on invalid input.
export function normalizeWebsiteUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const url = new URL(withProtocol);

    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('Invalid protocol');
    }

    if (!url.hostname.includes('.')) {
      throw new Error('Invalid hostname');
    }

    return url.toString().replace(/\/$/, '');
  } catch {
    throw new Error('Invalid website URL');
  }
}

// ---------------------------------------------------------------------------
// Generated content parsing (unwrap raw JSON before saving)
// ---------------------------------------------------------------------------

export type ParsedGeneratedContent = {
  headline: string;
  subheadline: string;
  bulletPoints: string[];
  body: string;
  hashtags: string;
};

function safeJsonParse(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function parseGeneratedContent(input: unknown, fallbackContent = 'LinkedIn post'): ParsedGeneratedContent {
  let value: any = input;

  if (typeof value === 'string') {
    const parsed = safeJsonParse(value.trim());
    if (parsed && typeof parsed === 'object') {
      value = parsed;
    } else {
      return {
        headline: value.split('\n').find(Boolean)?.slice(0, 120) || 'LinkedIn post',
        subheadline: '',
        bulletPoints: [],
        body: value,
        hashtags: '',
      };
    }
  }

  if (typeof value?.body === 'string') {
    const bodyTrimmed = value.body.trim();
    if (
      (bodyTrimmed.startsWith('{') && bodyTrimmed.endsWith('}')) ||
      bodyTrimmed.includes('"body"') ||
      bodyTrimmed.includes('"hashtags"')
    ) {
      const nested = safeJsonParse(bodyTrimmed);
      if (nested && typeof nested === 'object') {
        console.warn('[content-formatting] Unwrapped raw JSON from generated body');
        value = { ...value, ...nested };
      }
    }
  }

  const rawBody =
    typeof value?.body === 'string' && value.body.trim()
      ? value.body.trim()
      : typeof fallbackContent === 'string' && fallbackContent.trim()
        ? fallbackContent.trim()
        : 'LinkedIn post';

  const headline =
    typeof value?.headline === 'string' && value.headline.trim()
      ? value.headline.trim()
      : rawBody.split('\n').find(Boolean)?.slice(0, 120) || 'LinkedIn post';

  const subheadline = typeof value?.subheadline === 'string' ? value.subheadline.trim() : '';

  const bulletPoints = Array.isArray(value?.bulletPoints)
    ? value.bulletPoints.filter((x: unknown): x is string => typeof x === 'string')
    : [];

  const hashtags = typeof value?.hashtags === 'string' ? value.hashtags.trim() : '';

  return { headline, subheadline, bulletPoints, body: rawBody, hashtags };
}

export function stripRawJsonIfNeeded(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{')) return content;

  const parsed = safeJsonParse(trimmed);
  if (!parsed || typeof parsed !== 'object') return content;

  const extracted = parseGeneratedContent(parsed, '');
  return extracted.body || content;
}

export function looksMostlyArabic(text: string): boolean {
  const arabicMatches = text.match(/[\u0600-\u06FF]/g)?.length || 0;
  const letterMatches = text.match(/\p{L}/gu)?.length || 0;
  return letterMatches > 20 && arabicMatches / letterMatches > 0.35;
}

function guardEnglishBody(body: string, headline: string, language?: string | null): string {
  if (language && language !== 'en') return body;
  if (!looksMostlyArabic(body)) return body;

  console.warn('[content-formatting] Body appears mostly non-English; using headline-based fallback');
  const topic = headline.trim() || 'This topic';
  return `${topic} deserves more than a surface-level summary.\n\nThere is a real strategic angle here worth unpacking.\n\nWhat is your take?`;
}

// ---------------------------------------------------------------------------
// URL / contact extraction
// ---------------------------------------------------------------------------

// First http(s) URL found in free text, with trailing punctuation trimmed.
export function extractFirstUrl(text?: string | null): string | null {
  if (!text) return null;
  const match = text.match(/https?:\/\/[^\s)<>\]]+/i);
  if (!match) return null;
  return match[0].replace(/[.,;:!?)\]]+$/, '');
}

// Turn a raw item into a usable URL: accept full URLs or bare domains.
function coerceUrl(raw: string): string | null {
  const s = (raw || '').trim();
  if (!s) return null;
  const withScheme = extractFirstUrl(s);
  if (withScheme) return withScheme;
  // bare domain like example.com or www.example.com/path
  if (/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(s)) {
    return `https://${s.replace(/^\/+/, '')}`;
  }
  return null;
}


// also tolerant of comma/newline separated plain text.
export function extractFirstUrlFromJsonArrayString(value?: string | null): string | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const url = coerceUrl(typeof item === 'string' ? item : String(item ?? ''));
        if (url) return url;
      }
      return null;
    }
    if (typeof parsed === 'string') {
      return coerceUrl(parsed);
    }
  } catch {
    // Not JSON: treat as plain text / comma list.
    for (const part of value.split(/[\n,]/)) {
      const url = coerceUrl(part);
      if (url) return url;
    }
  }
  return null;
}

// Extract a contact line from the user's own description, if present.
// Never invents data — only surfaces an email/phone the user already wrote.
export function extractContactLine(description?: string | null): string | null {
  if (!description) return null;

  const email = description.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (email) return `Contact: ${email[0]}`;

  // Require enough digits to look like a real phone number.
  const phone = description.match(/\+?\d[\d\s().-]{7,}\d/);
  if (phone) return `Contact: ${phone[0].trim()}`;

  return null;
}

// ---------------------------------------------------------------------------
// Optional contact / website append
// ---------------------------------------------------------------------------

export interface ContactWebsiteOptions {
  includeContactInfo: boolean;
  includeWebsiteLink: boolean;
  contactInfo?: string | null;
  websiteUrl?: string | null;
  description?: string | null;

}

// Extract email or phone from free text (supports markdown mailto links).
function extractEmailOrPhoneFromText(text: string): string | null {
  const markdownEmail = text.match(/\[([^\]]+@[^\]]+)\]\(mailto:[^)]+\)/i);
  if (markdownEmail) return markdownEmail[0]; // keep full markdown link

  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (email) return email[0];

  const phone = text.match(/\+?\d[\d\s().-]{7,}\d/);
  if (phone) return phone[0].trim();

  return null;
}

// True when the value is a standalone CTA sentence, not a contact detail.
function isContactCtaSentence(value: string): boolean {
  return /^(want to|dm me|reach out|message me|feel free to)/i.test(value.trim());
}

function formatWebsiteLine(url: string): string {
  return `Learn more: ${url}`;
}

function formatContactLine(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (/^contact:/i.test(trimmed)) return trimmed;
  if (isContactCtaSentence(trimmed)) return trimmed;
  return `Contact: ${trimmed}`;
}


function resolveWebsiteUrl(options: ContactWebsiteOptions): string | null {
  const direct = (options.websiteUrl || '').trim();
  if (direct) return direct;

  const fromContactInfo = extractFirstUrl(options.contactInfo);
  if (fromContactInfo) return fromContactInfo;

  return extractFirstUrl(options.description);
}

// Resolve contact display value; null means use generic CTA fallback.
function resolveContactValue(options: ContactWebsiteOptions): string | null {
  const direct = (options.contactInfo || '').trim();
  if (direct) {
    const emailOrPhone = extractEmailOrPhoneFromText(direct);
    if (emailOrPhone) return emailOrPhone;
    if (/^https?:\/\//i.test(direct)) return null;
    if (isContactCtaSentence(direct)) return direct;
    return direct;
  }

  const extracted = extractContactLine(options.description);
  if (extracted) return extracted.replace(/^Contact:\s*/i, '').trim();

  return null;
}

function lineAlreadyPresent(base: string, lines: string[], line: string, rawValue?: string | null): boolean {
  if (base.includes(line) || lines.includes(line)) return true;
  if (rawValue && (base.includes(rawValue) || lines.some((l) => l.includes(rawValue)))) return true;
  return false;
}

export function appendOptionalContactAndWebsite(body: string, options: ContactWebsiteOptions): string {
  const base = (body || '').replace(/\s+$/, '');
  const extraLines: string[] = [];

  if (options.includeWebsiteLink) {
    const url = resolveWebsiteUrl(options);
    if (url) {
      const line = formatWebsiteLine(url);
      if (!lineAlreadyPresent(base, extraLines, line, url)) extraLines.push(line);
    }
  }

  if (options.includeContactInfo) {
    const contactValue = resolveContactValue(options);
    const line = contactValue
      ? formatContactLine(contactValue)
      : 'Want to discuss this? Reach out via my profile.';

    const alreadyPresent =
      lineAlreadyPresent(base, extraLines, line, contactValue) ||
      (line === 'Want to discuss this? Reach out via my profile.' && /reach out via my profile/i.test(base));

    if (!alreadyPresent) extraLines.push(line);
  }

  if (extraLines.length === 0) return base;
  return `${base}\n\n${extraLines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Hashtags
// ---------------------------------------------------------------------------

// Stale constant sets that should be replaced with content-based tags.
const STALE_HASHTAG_SETS: string[][] = [
  ['#digitaltransformation', '#itconsulting', '#techstrategy', '#linkedin'],
  ['#dataanalytics', '#businessstrategy', '#technology'],
  ['#techtrends', '#linkedin'],
];

const GENERIC_ONLY_TAGS = new Set([
  '#technology',
  '#businessstrategy',
  '#dataanalytics',
  '#growth',
  '#innovation',
  '#linkedin',
]);

// Keyword -> hashtag mapping for fallback generation from content.
const KEYWORD_TAGS: Array<[RegExp, string]> = [
  [/\bjavascript\b|\bjs\b|typescript|\breact\b|\bnode\.?js\b/i, '#JavaScript'],
  [/validation|validate|validator/i, '#DataValidation'],
  [/web dev|web development|frontend|backend/i, '#WebDevelopment'],
  [/\bai\b|artificial intelligence|machine learning|\bml\b|\bllm\b/i, '#AI'],
  [/automation|automate|workflow/i, '#Automation'],
  [/\bsaas\b/i, '#SaaS'],
  [/cyber ?security|infosec/i, '#Cybersecurity'],
  [/\bcloud\b/i, '#CloudComputing'],
  [/\bdata\b|analytics/i, '#DataAnalytics'],
  [/blockchain|crypto|web3/i, '#Blockchain'],
  [/leadership|\bleader\b|managers?/i, '#Leadership'],
  [/\bsales\b|selling|pipeline/i, '#SalesStrategy'],
  [/marketing|brand/i, '#MarketingStrategy'],
  [/startup|founder|entrepreneur/i, '#Startups'],
  [/finance|fintech|revenue|pricing/i, '#Finance'],
  [/product|engineering|developer/i, '#ProductDevelopment'],
  [/\bbusiness\b|\bb2b\b/i, '#BusinessStrategy'],
  [/technology|\btech\b|software/i, '#Technology'],
];

function normalizeHashtagToken(token: string): string | null {
  const cleaned = token.trim().replace(/[,.،؛;:!?]+$/g, '');
  if (!cleaned) return null;

  const withHash = cleaned.startsWith('#') ? cleaned : `#${cleaned}`;
  const normalized = withHash.replace(/[^\p{L}\p{N}_#]/gu, '');

  if (!/^#[\p{L}\p{N}_]{2,}$/u.test(normalized)) return null;

  return normalized;
}

function parseHashtagTokens(hashtags: string): string[] {
  return `${hashtags || ''}`
    .split(/[\s,]+/)
    .map(normalizeHashtagToken)
    .filter((t): t is string => !!t);
}

function tagKey(tag: string): string {
  return tag.toLowerCase();
}

function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const key = tagKey(t);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a.map(tagKey));
  return b.every((t) => sa.has(tagKey(t)));
}

function fallbackTags(text: string): string[] {
  const found: string[] = [];
  for (const [re, tag] of KEYWORD_TAGS) {
    if (found.length >= 2) break;
    if (re.test(text) && !found.some((t) => tagKey(t) === tagKey(tag))) {
      if (!GENERIC_ONLY_TAGS.has(tagKey(tag))) found.push(tag);
    }
  }
  return found;
}

function isStaleOrGenericOnly(tags: string[]): boolean {
  if (tags.length === 0) return true;
  if (STALE_HASHTAG_SETS.some((set) => sameSet(tags, set))) return true;
  if (tags.length >= 3 && tags.every((t) => GENERIC_ONLY_TAGS.has(tagKey(t)))) return true;
  return false;
}

// Produce 0-3 specific hashtags. No forced minimum; empty string is valid.
export function normalizeHashtags(hashtags: string, body: string, topic?: string): string {
  const context = `${topic || ''} ${body || ''}`;
  let tags = dedupeTags(parseHashtagTokens(hashtags)).filter(
    (t) => !GENERIC_ONLY_TAGS.has(tagKey(t)),
  );

  if (isStaleOrGenericOnly(tags)) {
    console.warn('[content-formatting] Dropped stale/generic hashtags');
    tags = [];
  }

  if (tags.length === 0) {
    tags = fallbackTags(context).slice(0, 2);
  }

  return dedupeTags(tags)
    .filter((t) => !GENERIC_ONLY_TAGS.has(tagKey(t)))
    .slice(0, 3)
    .join(' ');
}

// ---------------------------------------------------------------------------
// Taplio-style body normalization
// ---------------------------------------------------------------------------

export function normalizeTaplioStyleBody(body: string): string {
  if (!body) return '';
  const normalized = stripRawJsonIfNeeded(body);
  return normalizeLinkedInLineBody(normalized.replace(/\*\*/g, ''));
}

// ---------------------------------------------------------------------------
// Unified finalization pipeline (generation + rewrite)
// ---------------------------------------------------------------------------

export interface FinalizePostOptions extends ContactWebsiteOptions {
  topic?: string;
  language?: string | null;
}

export function finalizeGeneratedPostContent(
  generatedContent: unknown,
  fallbackContent: string,
  options: FinalizePostOptions = { includeContactInfo: false, includeWebsiteLink: false },
) {
  const parsed = parseGeneratedContent(generatedContent, fallbackContent);

  let cleanBody = normalizeTaplioStyleBody(parsed.body);
  cleanBody = guardEnglishBody(cleanBody, parsed.headline, options.language);

  const bodyWithAddons = appendOptionalContactAndWebsite(cleanBody, options);
  const hashtags = normalizeHashtags(parsed.hashtags, cleanBody, options.topic || parsed.headline);
  const content = `${bodyWithAddons}${hashtags ? `\n\n${hashtags}` : ''}`;

  return {
    headline: parsed.headline,
    subheadline: parsed.subheadline,
    bulletPoints: parsed.bulletPoints,
    body: bodyWithAddons,
    hashtags,
    content,
  };
}
