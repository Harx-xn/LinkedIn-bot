const LINKEDIN_POST_LIMIT = 3000;

/** Prepare text for LinkedIn without ever shortening it. */
export function prepareLinkedInCommentary(content: string): string {
  const commentary = content
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    // AI output can contain invisible terminator/control characters. Some
    // downstream consumers treat these as end-of-string and drop the rest.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!commentary) {
    throw new Error('LinkedIn post content is empty after normalization');
  }
  if (commentary.length > LINKEDIN_POST_LIMIT) {
    throw new Error(`LinkedIn post content exceeds ${LINKEDIN_POST_LIMIT} characters`);
  }
  return commentary;
}
