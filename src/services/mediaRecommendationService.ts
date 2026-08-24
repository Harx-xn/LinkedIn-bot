import type { ShareabilityProfile } from './shareabilityIntelligenceService';

export type MediaRecommendation =
  | 'TEXT_ONLY'
  | 'SIMPLE_IMAGE'
  | 'DIAGRAM'
  | 'FRAMEWORK_VISUAL'
  | 'CAROUSEL';

export type MediaBehavior = 'DISABLED' | 'SUGGEST_ONLY' | 'AUTO_WHEN_RECOMMENDED';

export type MediaRecommendationResult = {
  recommendation: MediaRecommendation;
  confidence: number;
  reason: string;
};

export type MediaEntitlementSnapshot = {
  imageGenerationEnabled: boolean;
  imagesRemaining: number | null;
  carouselAiGenerationEnabled: boolean;
  carouselGenerationsRemaining: number | null;
  convertPostToCarouselEnabled: boolean;
};

export type MediaAction = 'NONE' | 'SUGGEST' | 'GENERATE_IMAGE' | 'GENERATE_CAROUSEL';

export type ResolvedMediaDecision = {
  behavior: MediaBehavior;
  action: MediaAction;
  reason: string;
  preservesExistingAttachment: boolean;
  entitlementBlocked: boolean;
};

const compact = (value: number) => Math.max(0, Math.min(1, Number(value.toFixed(2))));

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

/** Deterministic, niche-generic classification of whether media adds editorial information. */
export function recommendMediaForPost(
  content: string,
  context: { rhetoricalStructure?: string | null; contentObjective?: string | null; shareabilityProfile?: ShareabilityProfile | null } = {},
): MediaRecommendationResult {
  const text = content.trim();
  if (!text) return { recommendation: 'TEXT_ONLY', confidence: 1, reason: 'There is no post content to visualize.' };
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const words = text.split(/\s+/).filter(Boolean).length;
  const explicitSteps = lines.filter((line) => /^(?:step\s+)?\d+[.)\s:-]|^[-*•]\s+|^(?:first|second|third|fourth|fifth|sixth|next|finally)\b/i.test(line)).length;
  const sequenceSignals = countMatches(text, /\b(?:step|stage|phase|sequence|workflow|process|checklist|playbook|roadmap)\b/gi);
  const comparisonSignals = countMatches(text, /\b(?:versus|vs\.?|compared with|difference|trade-?off|before|after)\b/gi);
  const relationshipSignals = countMatches(text, /\b(?:causes?|leads? to|depends? on|influences?|flows? (?:to|through)|feeds? into|results? in|connects? to)\b/gi);
  const frameworkSignals = countMatches(text, /\b(?:framework|matrix|quadrant|two axes|2x2|decision model|heuristic)\b/gi);
  const quantifiedSignals = countMatches(text, /\b\d+(?:\.\d+)?%\b|\b\d+(?:\.\d+)?x\b/gi);
  const structure = (context.rhetoricalStructure ?? '').toUpperCase();
  const shareabilityPresentation = context.shareabilityProfile?.recommendedPresentation;

  if (explicitSteps >= 5 || (explicitSteps >= 4 && sequenceSignals >= 1)
    || (shareabilityPresentation === 'CAROUSEL_CANDIDATE' && explicitSteps >= 4)
    || (structure === 'FRAMEWORK_EXPLANATION_APPLICATION' && explicitSteps >= 4)) {
    return {
      recommendation: 'CAROUSEL',
      confidence: compact(.7 + Math.min(.22, explicitSteps * .035)),
      reason: 'The post has a multi-part sequence that benefits from slide-by-slide presentation.',
    };
  }
  if ((frameworkSignals >= 1 || shareabilityPresentation === 'FRAMEWORK') && (explicitSteps >= 2 || comparisonSignals >= 1)) {
    return {
      recommendation: 'FRAMEWORK_VISUAL',
      confidence: compact(.72 + Math.min(.18, frameworkSignals * .05)),
      reason: 'A compact framework visual would make the decision model easier to reference.',
    };
  }
  if (relationshipSignals >= 2 || (relationshipSignals >= 1 && comparisonSignals >= 2)) {
    return {
      recommendation: 'DIAGRAM',
      confidence: compact(.68 + Math.min(.2, relationshipSignals * .06)),
      reason: 'A diagram would clarify the relationships between the concepts.',
    };
  }
  if (explicitSteps >= 4 || comparisonSignals >= 3) {
    return {
      recommendation: 'FRAMEWORK_VISUAL',
      confidence: .68,
      reason: 'A structured visual would make the comparison easier to scan and reuse.',
    };
  }
  if (quantifiedSignals >= 2 && words >= 80) {
    return {
      recommendation: 'SIMPLE_IMAGE',
      confidence: .62,
      reason: 'A focused visual could reinforce the post’s concrete result without adding decoration.',
    };
  }
  return {
    recommendation: 'TEXT_ONLY',
    confidence: words < 180 ? .88 : .72,
    reason: 'The idea is clear in prose and a visual would add little information.',
  };
}

export function safeRecommendMediaForPost(
  content: string,
  context?: { rhetoricalStructure?: string | null; contentObjective?: string | null; shareabilityProfile?: ShareabilityProfile | null },
  classifier: typeof recommendMediaForPost = recommendMediaForPost,
): MediaRecommendationResult {
  try {
    return classifier(content, context);
  } catch (error) {
    console.warn('[media-recommendation] classification failed; preserving text post', {
      message: error instanceof Error ? error.message : String(error),
    });
    return { recommendation: 'TEXT_ONLY', confidence: 0, reason: 'Media recommendation was unavailable.' };
  }
}

/** Existing settings remain authoritative. Legacy background users retain template behavior. */
export function resolveMediaBehavior(config: { imageMode?: string | null; backgroundImageUrl?: string | null }): {
  behavior: MediaBehavior;
  legacyAlwaysGenerateTemplate: boolean;
} {
  const mode = config.imageMode?.trim();
  if (mode === 'none') return { behavior: 'DISABLED', legacyAlwaysGenerateTemplate: false };
  if (mode === 'aiGenerated') return { behavior: 'AUTO_WHEN_RECOMMENDED', legacyAlwaysGenerateTemplate: false };
  if (mode === 'providedBackground') return { behavior: 'AUTO_WHEN_RECOMMENDED', legacyAlwaysGenerateTemplate: true };
  if (!mode && config.backgroundImageUrl?.trim()) return { behavior: 'AUTO_WHEN_RECOMMENDED', legacyAlwaysGenerateTemplate: true };
  return { behavior: 'DISABLED', legacyAlwaysGenerateTemplate: false };
}

export function resolveMediaDecision(input: {
  behavior: MediaBehavior;
  recommendation: MediaRecommendationResult;
  entitlements?: MediaEntitlementSnapshot;
  existingAttachmentType?: string | null;
  allowedAutomaticTypes?: Array<'IMAGE' | 'CAROUSEL'>;
  legacyAlwaysGenerateTemplate?: boolean;
}): ResolvedMediaDecision {
  const existing = Boolean(input.existingAttachmentType && input.existingAttachmentType !== 'NONE');
  if (input.behavior === 'DISABLED') return { behavior: input.behavior, action: 'NONE', reason: 'Media is disabled by the user.', preservesExistingAttachment: existing, entitlementBlocked: false };
  if (existing) return { behavior: input.behavior, action: input.behavior === 'SUGGEST_ONLY' ? 'SUGGEST' : 'NONE', reason: 'The existing attachment is preserved.', preservesExistingAttachment: true, entitlementBlocked: false };
  if (input.behavior === 'SUGGEST_ONLY') return { behavior: input.behavior, action: input.recommendation.recommendation === 'TEXT_ONLY' ? 'NONE' : 'SUGGEST', reason: input.recommendation.reason, preservesExistingAttachment: false, entitlementBlocked: false };
  if (input.recommendation.recommendation === 'TEXT_ONLY' && !input.legacyAlwaysGenerateTemplate) return { behavior: input.behavior, action: 'NONE', reason: input.recommendation.reason, preservesExistingAttachment: false, entitlementBlocked: false };

  const allowed = new Set(input.allowedAutomaticTypes ?? ['IMAGE']);
  const wantsCarousel = input.recommendation.recommendation === 'CAROUSEL';
  if (wantsCarousel && allowed.has('CAROUSEL')) {
    const enabled = input.entitlements?.convertPostToCarouselEnabled && input.entitlements.carouselAiGenerationEnabled
      && input.entitlements.carouselGenerationsRemaining !== 0;
    return enabled
      ? { behavior: input.behavior, action: 'GENERATE_CAROUSEL', reason: input.recommendation.reason, preservesExistingAttachment: false, entitlementBlocked: false }
      : { behavior: input.behavior, action: 'NONE', reason: 'Carousel generation is not available under the current plan or quota.', preservesExistingAttachment: false, entitlementBlocked: true };
  }
  if (wantsCarousel && !input.legacyAlwaysGenerateTemplate) return { behavior: input.behavior, action: 'NONE', reason: 'Automatic carousel creation is not enabled by the user.', preservesExistingAttachment: false, entitlementBlocked: false };

  const imageAllowed = input.entitlements === undefined
    || (input.entitlements.imageGenerationEnabled && input.entitlements.imagesRemaining !== 0);
  if (!allowed.has('IMAGE') || !imageAllowed) return { behavior: input.behavior, action: 'NONE', reason: 'Image generation is not available under the current plan or quota.', preservesExistingAttachment: false, entitlementBlocked: true };
  return { behavior: input.behavior, action: 'GENERATE_IMAGE', reason: input.recommendation.reason, preservesExistingAttachment: false, entitlementBlocked: false };
}

export async function runOptionalMediaOperation<T>(
  operation: () => Promise<T>,
  context = 'media',
): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    console.warn('[media-recommendation] optional media operation failed; preserving text post', {
      context,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
