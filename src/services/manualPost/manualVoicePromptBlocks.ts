import type { ManualVoiceContext } from './manualVoiceProfileService';

export const STYLE_REFERENCE_INSTRUCTIONS = `Infer sentence rhythm, paragraph length, directness, vocabulary, hook style, explanation style, and closing style from the style references below.
Do not reuse exact phrases, examples, stories, or arguments from the references.`;

export function buildManualVoiceContextBlocks(voiceContext?: ManualVoiceContext): string {
  if (!voiceContext) return '';

  const { explicitPreferences, learnedVoiceProfile, selectedWritingSamples } = voiceContext;
  const blocks: string[] = [];

  blocks.push(`VOICE CONTEXT — AUTHORITATIVE
- Tone: ${explicitPreferences.tone}
- Profile: ${explicitPreferences.description || (learnedVoiceProfile ? 'Use the saved BotConfig voice profile.' : 'No detailed voice profile supplied.')}
- Niches: ${explicitPreferences.niches.join(', ') || 'none; do not force niche references'}
- Niche references and hashtags are conditional: use them only when they sharpen the actual reasoning.
- Contact info: ${explicitPreferences.includeContactInfo ? 'enabled' : 'disabled'}; website: ${explicitPreferences.includeWebsiteLink ? 'enabled' : 'disabled'} (final formatting owns these controls).`);

  if (selectedWritingSamples.length > 0) {
    const references = selectedWritingSamples
      .map((sample, index) => `Reference ${index + 1} (${sample.origin}${sample.published ? ', published' : ''}):\n${sample.content.trim()}`)
      .join('\n\n');
    blocks.push(`STYLE REFERENCES
${STYLE_REFERENCE_INSTRUCTIONS}

${references}`);
  } else {
    blocks.push(`STYLE REFERENCES
- No eligible writing samples available yet.
${STYLE_REFERENCE_INSTRUCTIONS}`);
  }

  return `\n${blocks.join('\n\n')}\n`;
}
