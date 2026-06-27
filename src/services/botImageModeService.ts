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

export type BotImageMode = 'none' | 'providedBackground' | 'aiGenerated';

const VALID_IMAGE_MODES = new Set<BotImageMode>([
  'none',
  'providedBackground',
  'aiGenerated',
]);

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
  if (input.imageMode === 'none') {
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
      throw err;
    }

    try {
      const generative = await getGenerativeImagesServiceForUser(input.userId);
      const generated = await generative.generateLinkedInPostImage(
        buildBatchGenerativeImageInput(input),
      );

      const ext = extensionForMimeType(generated.mimeType);
      const prefix = input.uploadKeyPrefix ?? `generated/ai-batch-${input.userId}`;
      const mediaUrl = await uploadBufferToR2(
        generated.buffer,
        `${prefix}-${Date.now()}.${ext}`,
        generated.mimeType,
      );

      await recordImageGeneration(input.userId);
      return mediaUrl;
    } catch (err) {
      console.warn('[batch] AI image generation failed', {
        userId: input.userId,
        message: err instanceof Error ? err.message : 'unknown error',
      });
      return null;
    }
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

  try {
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
  } catch (err) {
    console.warn('[batch] Template image generation failed', {
      userId: input.userId,
      message: err instanceof Error ? err.message : 'unknown error',
    });
    return null;
  }
}
