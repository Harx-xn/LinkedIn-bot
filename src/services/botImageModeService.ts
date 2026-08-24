import { uploadBufferToR2 } from '../middleware/r2';
import type { ImageService } from './imageService';
import {
  PlanLimitError,
  canUseImageGeneration,
  isImageGenerationAllowed,
  recordImageGeneration,
} from './planEntitlementService';
import { getGenerativeImagesServiceForUser } from './userContentContext';
import type {
  GenerateLinkedInPostImageInput,
  LinkedInImageAspectRatio,
} from './generativeImagesService';
import { applyOptionalBrandLogo } from './brandLogoService';
import {
  resolveMediaBehavior,
  resolveMediaDecision,
  runOptionalMediaOperation,
  type MediaRecommendationResult,
} from './mediaRecommendationService';

export type BotImageMode = 'none' | 'providedBackground' | 'aiGenerated';

const VALID_IMAGE_MODES = new Set<BotImageMode>([
  'none',
  'providedBackground',
  'aiGenerated',
]);

const VALID_IMAGE_STYLES = new Set([
  'auto', 'professional', 'modern', 'minimal', 'bold', 'corporate', 'abstract',
]);

export function parseBotImageStyleInput(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') throw new Error('Invalid imageStyle');
  const value = raw.trim().toLowerCase();
  if (!VALID_IMAGE_STYLES.has(value)) throw new Error('Invalid imageStyle');
  return value;
}

export function parseBotImageModeInput(raw: unknown): BotImageMode | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  const value = String(raw).trim();
  if (VALID_IMAGE_MODES.has(value as BotImageMode)) {
    return value as BotImageMode;
  }
  throw new Error('imageMode must be none, providedBackground, or aiGenerated');
}

/** Backward-compatible effective mode for batch generation. */
export function resolveBotImageMode(config: {
  imageMode?: string | null;
  backgroundImageUrl?: string | null;
}): BotImageMode {
  const stored = config.imageMode?.trim();
  if (stored && VALID_IMAGE_MODES.has(stored as BotImageMode)) {
    return stored as BotImageMode;
  }
  if (config.backgroundImageUrl?.trim()) {
    return 'providedBackground';
  }
  return 'none';
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  return 'png';
}

export interface BatchPostImageInput {
  userId: string;
  imageMode: BotImageMode;
  backgroundImageUrl?: string | null;
  imageInstructions?: string | null;
  imageStyle?: string | null;
  imageAspectRatio?: string | null;
  brandLogoUrl?: string | null;
  brandLogoEnabled?: boolean;
  brandLogoPosition?: string | null;
  profileDescription?: string | null;
  brandName?: string | null;
  postContent: string;
  imageService: ImageService;
  finalized: {
    headline: string;
    subheadline: string;
    bulletPoints: string[];
  };
  imageContent: {
    mode: string;
    headline: string;
    supportingText?: string;
    bulletPoints?: string[];
  } | null;
  uploadKeyPrefix?: string;
  mediaRecommendation?: MediaRecommendationResult;
  existingAttachmentType?: string | null;
}

export function buildBatchGenerativeImageInput(
  input: BatchPostImageInput,
): GenerateLinkedInPostImageInput {
  return {
    postText: input.postContent,
    instructions: input.imageInstructions ?? undefined,
    style: input.imageStyle ?? undefined,
    aspectRatio: input.imageAspectRatio as LinkedInImageAspectRatio | undefined,
    profileDescription: input.profileDescription ?? undefined,
    brandName: input.brandName ?? undefined,
  };
}

export async function generateBatchPostMediaUrl(
  input: BatchPostImageInput,
): Promise<string | null> {
  const resolvedBehavior = resolveMediaBehavior({ imageMode: input.imageMode, backgroundImageUrl: input.backgroundImageUrl });
  const mediaDecision = resolveMediaDecision({
    behavior: resolvedBehavior.behavior,
    recommendation: input.mediaRecommendation ?? {
      recommendation: 'SIMPLE_IMAGE', confidence: 0, reason: 'Legacy batch media behavior.',
    },
    existingAttachmentType: input.existingAttachmentType,
    allowedAutomaticTypes: ['IMAGE'],
    legacyAlwaysGenerateTemplate: resolvedBehavior.legacyAlwaysGenerateTemplate,
  });
  if (mediaDecision.action !== 'GENERATE_IMAGE') {
    return null;
  }

  if (input.imageMode === 'aiGenerated') {
    try {
      await canUseImageGeneration(input.userId);
    } catch (err) {
      if (err instanceof PlanLimitError) {
        console.warn('[batch] AI image skipped: plan limit reached', {
          userId: input.userId,
          code: err.code,
        });
        return null;
      }
      console.warn('[batch] AI image entitlement check failed; preserving text post', {
        userId: input.userId,
        message: err instanceof Error ? err.message : 'unknown error',
      });
      return null;
    }

    return runOptionalMediaOperation(async () => {
      const generative = await getGenerativeImagesServiceForUser(input.userId);
      const generated = await generative.generateLinkedInPostImage(
        buildBatchGenerativeImageInput(input),
      );

      const branded = await applyOptionalBrandLogo({
        buffer: generated.buffer, mimeType: generated.mimeType, userId: input.userId,
        enabled: input.brandLogoEnabled, logoUrl: input.brandLogoUrl,
        position: input.brandLogoPosition, logContext: 'batch',
      });
      const finalBuffer = branded.buffer;
      const finalMimeType = branded.mimeType;
      const ext = extensionForMimeType(finalMimeType);
      const prefix = input.uploadKeyPrefix ?? `generated/ai-batch-${input.userId}`;
      const mediaUrl = await uploadBufferToR2(
        finalBuffer,
        `${prefix}-${Date.now()}.${ext}`,
        finalMimeType,
      );

      await recordImageGeneration(input.userId);
      return mediaUrl;
    }, `batch-ai-image:${input.userId}`);
  }

  // providedBackground — existing template/background image flow
  if (input.imageContent?.mode === 'none') {
    return null;
  }

  if (!(await isImageGenerationAllowed(input.userId))) {
    console.warn('[batch] Template image skipped: plan limit reached', {
      userId: input.userId,
    });
    return null;
  }

  return runOptionalMediaOperation(async () => {
    const mediaUrl = await input.imageService.createTopicImage(
      input.imageContent?.headline ?? input.finalized.headline,
      input.backgroundImageUrl ?? undefined,
      {
        headline: input.imageContent?.headline ?? input.finalized.headline,
        subheadline: input.imageContent?.supportingText ?? input.finalized.subheadline,
        bulletPoints: (input.imageContent?.bulletPoints ?? input.finalized.bulletPoints).slice(
          0,
          3,
        ),
        mode:
          (input.imageContent?.mode as
            | 'single_insight'
            | 'checklist'
            | 'comparison'
            | 'quote'
            | 'none') ?? 'single_insight',
      },
    );
    await recordImageGeneration(input.userId);
    return mediaUrl;
  }, `batch-template-image:${input.userId}`);
}
