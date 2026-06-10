export function extractTopicKeywords(text: string): string[] {
  return [...new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 4),
  )];
}

export function topicKeywordOverlap(topic: string, sampleTopic: string | null, content: string): number {
  const keywords = extractTopicKeywords(topic);
  if (keywords.length === 0) return 0;

  const haystack = `${sampleTopic ?? ''} ${content}`.toLowerCase();
  const hits = keywords.filter((keyword) => haystack.includes(keyword)).length;
  return hits / keywords.length;
}
