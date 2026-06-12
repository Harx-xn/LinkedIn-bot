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

  private buildLinkedInImagePrompt(input: GenerateLinkedInPostImageInput): string {
    const {
      postText,
      instructions,
      brandName,
      style = 'professional',
      aspectRatio = '1:1',
    } = input;

    return `
Create a high-quality LinkedIn feed image based on the post below.

POST TEXT:
${postText.trim()}

USER IMAGE INSTRUCTIONS:
${instructions?.trim() || 'Create a professional visual that supports the main idea of the post.'}

IMAGE REQUIREMENTS:
- Platform: LinkedIn professional feed.
- Aspect ratio: ${aspectRatio}.
- Visual style: ${style}.
- Brand name: ${brandName?.trim() || 'No specific brand'}.
- Premium, polished, clear, and suitable for a professional audience.
- Communicate the core idea visually without clutter.
- Avoid tiny or unreadable text.
- If text appears in the image, keep it short, bold, and legible.
- Do not create fake screenshots unless explicitly requested.
- Do not include copyrighted logos, real company logos, or recognizable real people.
- Prefer conceptual business, SaaS, technology, productivity, marketing, or founder-style visuals.
- Support the post message; do not repeat the full post text inside the image.
`.trim();
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
      const prompt = this.buildLinkedInImagePrompt(input);

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
