import { createHash } from 'crypto';

const SAMPLE_LENGTH = 80;

export function linkedinPublishTextDiagnostics(content: string) {
  return {
    length: content.length,
    sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
    startSample: content.slice(0, SAMPLE_LENGTH),
    endSample: content.slice(-SAMPLE_LENGTH),
  };
}

export function linkedinPublishMediaType(
  attachmentType: string | null | undefined,
  mediaUrl: string | null | undefined,
) {
  if (attachmentType === 'CAROUSEL') return 'CAROUSEL';
  if (mediaUrl) return 'IMAGE';
  return 'TEXT';
}
