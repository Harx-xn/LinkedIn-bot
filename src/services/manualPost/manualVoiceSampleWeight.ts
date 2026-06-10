import { topicKeywordOverlap } from './manualVoiceKeywordUtils';
import type { VoiceSamplePost } from './manualVoiceSampleEligibility';

export function calculateManualVoiceSampleWeight(post: VoiceSamplePost, topic?: string): number {
  let weight = 0;

  if (!post.aiGenerated) weight += 40;
  else weight += 22;

  if (post.status === 'PUBLISHED') weight += 30;
  if (post.publishedAt) {
    const ageDays = (Date.now() - post.publishedAt.getTime()) / (24 * 60 * 60 * 1000);
    weight += Math.max(0, 20 - ageDays);
  }

  const recencyDays = (Date.now() - post.updatedAt.getTime()) / (24 * 60 * 60 * 1000);
  weight += Math.max(0, 15 - recencyDays * 0.5);

  if (topic) {
    weight += topicKeywordOverlap(topic, post.manualTopic, post.content) * 20;
  }

  return weight;
}
