import type { ManualVoiceContext } from './manualVoiceProfileService';

export const STYLE_REFERENCE_INSTRUCTIONS = `Infer sentence rhythm, paragraph length, directness, vocabulary, hook style, explanation style, and closing style from the style references below.
Do not reuse exact phrases, examples, stories, or arguments from the references.`;

export function buildManualVoiceContextBlocks(voiceContext?: ManualVoiceContext): string {
  if (!voiceContext) return '';

  const { explicitPreferences, learnedVoiceProfile, selectedWritingSamples } = voiceContext;
  const blocks: string[] = [];

  blocks.push(`AUTHOR IDENTITY
- Tone: ${explicitPreferences.tone}
- Description: ${explicitPreferences.description || 'Not provided'}
- Niches: ${explicitPreferences.niches.join(', ') || 'none'}`);

  blocks.push(`EXPLICIT PREFERENCES
- Include contact info in final formatting: ${explicitPreferences.includeContactInfo ? 'yes' : 'no'}
- Include website link in final formatting: ${explicitPreferences.includeWebsiteLink ? 'yes' : 'no'}
- BotConfig description is the authoritative voice profile for manual posts.`);

  if (learnedVoiceProfile) {
    blocks.push(`VOICE PROFILE (from BotConfig)
- Author description:
${explicitPreferences.description.trim()}
- Tone: ${explicitPreferences.tone}
- Niches: ${explicitPreferences.niches.join(', ') || 'none'}`);
  } else {
    blocks.push(`VOICE PROFILE
- BotConfig description is missing. Complete your ghostwriter profile before generating posts.`);
  }

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
