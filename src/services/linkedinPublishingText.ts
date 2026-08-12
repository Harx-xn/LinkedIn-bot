const LINKEDIN_POST_LIMIT = 3000;
const LITTLE_TEXT_RESERVED = new Set(['\\', '|', '{', '}', '@', '[', ']', '(', ')', '<', '>', '#', '*', '_', '~']);
const HASHTAG_CHARACTER = /[\p{L}\p{N}_]/u;

function normalizeLinkedInContent(content: string): string {
  return content
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    // AI output can contain invisible terminator/control characters. Some
    // downstream consumers treat these as end-of-string and drop the rest.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Escape plain text for LinkedIn's `little` commentary format. */
export function escapeLinkedInLittleText(content: string): string {
  let escaped = '';

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];

    // Preserve an existing valid escape so preparation is idempotent.
    if (character === '\\' && LITTLE_TEXT_RESERVED.has(content[index + 1])) {
      escaped += character + content[index + 1];
      index += 1;
      continue;
    }

    // A hashtag is a supported little-text element. Preserve the complete
    // token, including underscores, instead of escaping its marker/body.
    if (character === '#' && HASHTAG_CHARACTER.test(content[index + 1] ?? '')) {
      let end = index + 1;
      while (end < content.length && HASHTAG_CHARACTER.test(content[end])) end += 1;
      escaped += content.slice(index, end);
      index = end - 1;
      continue;
    }

    escaped += LITTLE_TEXT_RESERVED.has(character) ? `\\${character}` : character;
  }

  return escaped;
}

export function prepareLinkedInCommentaryStages(content: string) {
  const normalizedContent = normalizeLinkedInContent(content);

  if (!normalizedContent) {
    throw new Error('LinkedIn post content is empty after normalization');
  }
  // LinkedIn's visible-content limit applies before transport-only escaping.
  if (normalizedContent.length > LINKEDIN_POST_LIMIT) {
    throw new Error(`LinkedIn post content exceeds ${LINKEDIN_POST_LIMIT} characters`);
  }

  return {
    normalizedContent,
    commentary: escapeLinkedInLittleText(normalizedContent),
  };
}

/** Prepare text for LinkedIn without ever shortening it. */
export function prepareLinkedInCommentary(content: string): string {
  return prepareLinkedInCommentaryStages(content).commentary;
}
