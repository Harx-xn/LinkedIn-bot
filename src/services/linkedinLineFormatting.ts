const ABBREVIATIONS = /\b(e\.g\.|i\.e\.|etc\.|vs\.|U\.S\.|Node\.js|v\d+\.\d+\.\d+)\b/gi;
const URL_PATTERN = /https?:\/\/[^\s]+/g;

export type FormattingValidationIssue = {
  code: 'dense_paragraph' | 'excessive_fragmentation' | 'list_spacing_invalid' | 'missing_section_spacing';
  severity: 'warning' | 'error';
  evidence?: string[];
};

function protectTokens(text: string): { protectedText: string; restore: (value: string) => string } {
  const tokens: string[] = [];
  let protectedText = text;
  const patterns = [URL_PATTERN, ABBREVIATIONS];
  for (const pattern of patterns) {
    protectedText = protectedText.replace(pattern, (match) => {
      const token = `__TOK${tokens.length}__`;
      tokens.push(match);
      return token;
    });
  }
  return {
    protectedText,
    restore: (value: string) => {
      let out = value;
      tokens.forEach((token, index) => {
        out = out.replace(`__TOK${index}__`, token);
      });
      return out;
    },
  };
}

function splitSentences(paragraph: string): string[] {
  const { protectedText, restore } = protectTokens(paragraph);
  const parts = protectedText
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"(\[])/)
    .map((s) => restore(s.trim()))
    .filter(Boolean);
  return parts.length ? parts : [paragraph.trim()];
}

function countSentences(paragraph: string): number {
  return splitSentences(paragraph).length;
}

function isListLine(line: string): boolean {
  return /^\s*(\d+\.|[-*•])\s+/.test(line);
}

function isCodeFenceLine(line: string): boolean {
  return line.trim().startsWith('```');
}

export function normalizeLinkedInLineBody(body: string): string {
  if (!body) return '';

  const normalized = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  const lines = normalized.split('\n');
  const blocks: string[] = [];
  let listBuffer: string[] = [];
  let proseBuffer: string[] = [];
  let inCodeFence = false;

  const flushList = () => {
    if (listBuffer.length) {
      blocks.push(listBuffer.join('\n'));
      listBuffer = [];
    }
  };

  const flushProse = () => {
    if (!proseBuffer.length) return;
    const paragraph = proseBuffer.join(' ').replace(/\s+/g, ' ').trim();
    proseBuffer = [];
    if (!paragraph) return;

    const sentences = splitSentences(paragraph);
    if (sentences.length <= 2) {
      blocks.push(sentences.join('\n\n'));
      return;
    }

    for (let i = 0; i < sentences.length; i += 2) {
      const chunk = sentences.slice(i, i + 2).join(' ');
      blocks.push(chunk);
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/[ \t]{2,}/g, ' ').replace(/^\s*👉\s*/, '').trimEnd();

    if (isCodeFenceLine(line)) {
      flushProse();
      flushList();
      inCodeFence = !inCodeFence;
      blocks.push(line);
      continue;
    }

    if (inCodeFence) {
      blocks.push(line);
      continue;
    }

    if (!line.trim()) {
      flushProse();
      flushList();
      continue;
    }

    if (isListLine(line)) {
      flushProse();
      listBuffer.push(line.trim());
      continue;
    }

    flushList();
    proseBuffer.push(line.trim());
  }

  flushProse();
  flushList();

  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function validateLinkedInFormatting(body: string): FormattingValidationIssue[] {
  const issues: FormattingValidationIssue[] = [];
  if (!body.trim()) return issues;

  const paragraphs = body.split(/\n\n+/);
  let tinyLineStreak = 0;

  for (const paragraph of paragraphs) {
    const lines = paragraph.split('\n');
    const listLines = lines.filter((l) => isListLine(l));
    if (listLines.length > 0) {
      if (lines.some((l) => !l.trim())) {
        issues.push({ code: 'list_spacing_invalid', severity: 'error', evidence: [paragraph.slice(0, 120)] });
      }
      continue;
    }

    const sentenceCount = countSentences(paragraph);
    if (sentenceCount >= 3 || paragraph.length > 320) {
      issues.push({ code: 'dense_paragraph', severity: 'error', evidence: [paragraph.slice(0, 120)] });
    }

    for (const line of lines) {
      const words = line.trim().split(/\s+/).filter(Boolean);
      if (words.length <= 2 && line.trim().length < 24) tinyLineStreak++;
      else tinyLineStreak = 0;
      if (tinyLineStreak >= 4) {
        issues.push({ code: 'excessive_fragmentation', severity: 'warning' });
        tinyLineStreak = 0;
      }
    }
  }

  if (paragraphs.length > 2) {
    const hasSpacing = body.includes('\n\n');
    if (!hasSpacing) {
      issues.push({ code: 'missing_section_spacing', severity: 'warning' });
    }
  }

  return issues;
}
