import type { ManualPostFingerprintRecord } from './manualPostFingerprintService';

export function buildManualFingerprintContextBlock(
  fingerprints: ManualPostFingerprintRecord[],
): string {
  if (fingerprints.length === 0) {
    return `RECENT MANUAL FINGERPRINTS
- No recent manual fingerprints available.
- Avoid repeating the same core claim, hook pattern, structure, evidence style, and closing style from recent posts.
- Discussing the same broad niche is allowed when the argument and presentation are meaningfully different.`;
  }

  const lines = fingerprints.slice(0, 12).map((fp, index) => {
    return `${index + 1}. Topic: ${fp.primaryTopic}
   Core claim: ${fp.coreClaim}
   Structure: ${fp.structure ?? 'unknown'}
   Hook type: ${fp.hookType ?? 'unknown'}
   Evidence: ${fp.evidenceType ?? 'unknown'}
   Closing: ${fp.ctaType ?? 'unknown'}`;
  });

  return `RECENT MANUAL FINGERPRINTS
Use these only to avoid repeating the same argument and presentation.
Do not blacklist the entire niche or broad topic area.

${lines.join('\n\n')}`;
}
