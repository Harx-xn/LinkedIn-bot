import { GoogleGenAI, Modality } from '@google/genai';

const DEFAULT_GEMINI_IMAGE_MODEL =
  process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';

export type LinkedInImageAspectRatio = '1:1' | '4:5' | '16:9';

export interface GenerativeImagesServiceKeys {
  geminiApiKeys: string[];
}

export interface GenerateLinkedInPostImageInput {
  postText: string;
  instructions?: string;
  brandName?: string;
  profileDescription?: string;
  style?: string;
  aspectRatio?: LinkedInImageAspectRatio;
  model?: string;
}

export interface GeneratedLinkedInImageResult {
  buffer: Buffer;
  mimeType: string;
  model: string;
  usedKeyIndex: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GenerativeImageError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'GenerativeImageError';
    this.status = status;
    this.code = code;
  }
}

function isRateLimitError(error: unknown): boolean {
  const err = error as {
    status?: number;
    code?: number | string;
    message?: string;
    response?: { status?: number };
    error?: { code?: number | string };
  };

  const status = err?.status ?? err?.response?.status ?? err?.error?.code ?? err?.code;
  const message = String(err?.message ?? '').toLowerCase();

  return (
    status === 429 ||
    message.includes('429') ||
    message.includes('quota') ||
    message.includes('rate limit') ||
    message.includes('rate_limit') ||
    message.includes('resource_exhausted') ||
    message.includes('resource exhausted')
  );
}

export function buildLinkedInImagePrompt(input: GenerateLinkedInPostImageInput): string {
    const {
      postText,
      instructions,
      brandName,
      profileDescription,
      style = 'professional',
      aspectRatio = '1:1',
    } = input;

    return `
Create a high-quality LinkedIn feed image based on the post below.

POST TEXT:
${postText.trim()}

CREATOR / PROFILE CONTEXT:
${profileDescription?.trim() || 'No specific creator profile context provided.'}

USER IMAGE INSTRUCTIONS:
${instructions?.trim() || 'Create a clean professional visual that supports the main idea of the post.'}

IMAGE REQUIREMENTS:
- Platform: LinkedIn professional feed.
- Aspect ratio: ${aspectRatio}.
- Visual style: ${style}.
- Brand name: ${brandName?.trim() || 'No specific brand'}.
- Create a clean, polished LinkedIn visual that supports the post's specific business idea.
- Use the creator/profile context to personalize the industry, audience, and visual metaphor.
- Do not include the full creator/profile context as visible text.
- Do not add random labels, taglines, or category names such as "AI Automation" unless explicitly requested in the user instructions or brand name.
- Avoid weird surreal 3D scenes, random megaphones, lighthouses, diamonds, badges, fake logos, or decorative icons unless they directly support the post.
- Prefer clean editorial business graphics, simple diagrams, abstract SaaS/productivity visuals, content strategy metaphors, or professional creator-style visuals.
- Premium, polished, clear, and suitable for a professional LinkedIn audience.
- Communicate one strong idea visually without clutter.
- Avoid tiny or unreadable text.
- If text appears in the image, use at most one short headline of 3-7 words; keep it bold and legible.
- Never include hashtags or text beginning with # anywhere in the image.
- Never render the creator's niche name, industry category, or profile label as visible text in the image.
- Do not repeat the full post text inside the image.
- Do not create fake screenshots unless explicitly requested.
- Do not include copyrighted logos, real company logos, or recognizable real people.
- The image should feel specific to the post, not like a generic AI/tech motivational poster.

VISUAL DECISION RULE:
Before creating the image, identify the single clearest idea from the post and design around that. For comparison or positioning posts, show a clear contrast between vague/generic and specific/targeted. For SaaS or business posts, prefer clear strategic metaphors over literal objects.

For posts about generic versus specific B2B messaging, prefer a targeting or focus metaphor, a clean content strategy board, a funnel narrowing from broad messaging to a precise audience, or blurry generic messages contrasted with one sharp specific message. Avoid unrelated "AI Automation" labels unless AI automation is explicitly central to the post, user instructions, brand name, or creator context.
`.trim();
}

export class GenerativeImagesService {
  private readonly geminiKeys: string[];
  private currentKeyIndex = 0;

  constructor(keys: GenerativeImagesServiceKeys) {
    this.geminiKeys = (keys.geminiApiKeys ?? []).map((k) => k.trim()).filter(Boolean);
  }

  private getGeminiClient(keyIndex = this.currentKeyIndex): GoogleGenAI {
    const apiKey = this.geminiKeys[keyIndex];

    if (!apiKey) {
      throw new Error(
        'No Gemini API keys available for image generation. Pass decrypted regional Gemini keys into GenerativeImagesService.',
      );
    }

    return new GoogleGenAI({ apiKey });
  }

  private rotateGeminiKey(): void {
    if (this.geminiKeys.length <= 1) return;
    this.currentKeyIndex = (this.currentKeyIndex + 1) % this.geminiKeys.length;
  }

  async generateLinkedInPostImage(
    input: GenerateLinkedInPostImageInput,
    retryCount = 0,
  ): Promise<GeneratedLinkedInImageResult> {
    if (!input.postText?.trim()) {
      throw new Error('postText is required for LinkedIn image generation.');
    }

    if (!this.geminiKeys.length) {
      throw new Error(
        'No Gemini API keys available. Pass decrypted regional Gemini keys into GenerativeImagesService.',
      );
    }

    const model = input.model || DEFAULT_GEMINI_IMAGE_MODEL;
    const aspectRatio = input.aspectRatio || '1:1';
    const usedKeyIndex = this.currentKeyIndex;

    try {
      const ai = this.getGeminiClient(usedKeyIndex);
      const prompt = buildLinkedInImagePrompt(input);

      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          responseModalities: [Modality.IMAGE],
          imageConfig: {
            aspectRatio,
          },
        },
      });

      const parts = response.candidates?.[0]?.content?.parts ?? [];
      const imagePart = parts.find((part) => part.inlineData?.data);

      if (!imagePart?.inlineData?.data) {
        throw new Error(
          'Gemini image generation did not return an image. Try adjusting the post text or instructions.',
        );
      }

      const mimeType = imagePart.inlineData.mimeType || 'image/png';
      const buffer = Buffer.from(imagePart.inlineData.data, 'base64');

      return {
        buffer,
        mimeType,
        model,
        usedKeyIndex,
      };
    } catch (error: unknown) {
      if (isRateLimitError(error)) {
        const canRotate =
          this.geminiKeys.length > 1 && retryCount < this.geminiKeys.length - 1;

        if (canRotate) {
          this.rotateGeminiKey();

          console.warn('[generative-images] Gemini image key limit hit. Rotating key.', {
            previousKeyIndex: usedKeyIndex,
            nextKeyIndex: this.currentKeyIndex,
            retryCount: retryCount + 1,
          });

          return this.generateLinkedInPostImage(input, retryCount + 1);
        }

        if (retryCount < 3) {
          console.warn('[generative-images] Gemini image generation rate limited. Retrying.', {
            keyIndex: usedKeyIndex,
            retryCount: retryCount + 1,
          });

          await sleep(30000);
          return this.generateLinkedInPostImage(input, retryCount + 1);
        }

        throw new GenerativeImageError(
          429,
          'GEMINI_IMAGE_QUOTA_EXCEEDED',
          'Gemini image quota is exhausted for the configured API keys. Check Gemini billing/limits or try again later.',
        );
      }

      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes('no gemini api keys')) {
        throw new GenerativeImageError(
          400,
          'GEMINI_NOT_CONFIGURED',
          'Gemini is not configured for image generation in your region.',
        );
      }

      throw new GenerativeImageError(
        502,
        'GEMINI_IMAGE_GENERATION_FAILED',
        'Could not generate an AI image. Try again or adjust the post text.',
      );
    }
  }
}
