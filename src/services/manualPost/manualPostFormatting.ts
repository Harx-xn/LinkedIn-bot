import {
  finalizeGeneratedPostContent,
  normalizeHashtags,
  normalizeTaplioStyleBody,
} from '../postContentFormatting';
import type { BotVoice } from '../userContentContext';
import { calculateManualGenericAiRisk } from './manualGenericAiDetector';
import type { ManualGeneratedPost } from './manualPostTypes';

export const MANUAL_LINKEDIN_CHAR_LIMIT = 3000;

export function normalizeManualLinkedInBodyV2(body: string): string {
  return normalizeTaplioStyleBody(body);
}

export function assembleManualPostBody(manual: ManualGeneratedPost): string {
  const parts = [manual.hook.trim(), manual.body.trim(), manual.closingLine.trim()].filter(Boolean);
  return normalizeManualLinkedInBodyV2(parts.join('\n\n'));
}

export function normalizeManualHashtags(
  hashtags: string[],
  body: string,
  topic?: string,
): string {
  const joined = hashtags.join(' ');
  return normalizeHashtags(joined, body, topic);
}

export type FinalizeManualPostOptions = {
  topic?: string;
  voice: BotVoice;
  language?: string | null;
};

export function finalizeManualGeneratedPostV2(
  manual: ManualGeneratedPost,
  fallbackContent: string,
  options: FinalizeManualPostOptions,
) {
  const body = assembleManualPostBody(manual);
  const hashtags = normalizeManualHashtags(manual.hashtags, body, options.topic);

  const risk = calculateManualGenericAiRisk(body);
  if (risk.score > 0) {
    console.warn('[manual-post-v2] generic AI patterns detected', {
      score: risk.score,
      matchCount: risk.matches.length,
    });
  }

  const finalized = finalizeGeneratedPostContent(
    {
      headline: manual.hook.split('\n').find(Boolean)?.slice(0, 120) || options.topic || 'LinkedIn post',
      subheadline: '',
      bulletPoints: [],
      body,
      hashtags,
    },
    fallbackContent,
    {
      topic: options.topic,
      language: options.language,
      includeContactInfo: options.voice.includeContactInfo,
      includeWebsiteLink: options.voice.includeWebsiteLink,
      contactInfo: options.voice.contactInfo,
      websiteUrl: options.voice.websiteUrl,
      description: options.voice.description,
      customLinks: options.voice.customLinks,
    },
  );

  if (finalized.content.length > MANUAL_LINKEDIN_CHAR_LIMIT) {
    throw new Error(`Generated content exceeds ${MANUAL_LINKEDIN_CHAR_LIMIT} characters`);
  }

  return finalized;
}
