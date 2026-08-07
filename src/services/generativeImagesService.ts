import { GoogleGenAI, Modality } from '@google/genai';

const DEFAULT_GEMINI_IMAGE_MODEL =
  process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';

export type LinkedInImageAspectRatio = '1:1' | '4:5' | '16:9';
export type VisualFormat = 'auto' | 'visual_comparison' | 'process_flow' | 'comic' | 'annotated_explainer' | 'concept_poster' | 'timeline_transformation' | 'data_graphic' | 'diagram' | 'editorial_illustration' | 'screenshot_explainer' | 'visual_metaphor' | 'scene';
export type ImageType = 'auto' | 'photorealistic' | 'editorial' | 'conceptual' | 'infographic' | 'illustration' | '3d' | 'branded_graphic';
export type ImageMood = 'auto' | 'professional' | 'bold' | 'premium' | 'trustworthy' | 'energetic' | 'calm' | 'thought_provoking' | 'friendly' | 'playful';
export type ImageColorPalette = 'auto' | 'brand' | 'clean' | 'dark' | 'high_contrast' | 'vibrant' | 'pastel' | 'monochrome' | 'neutral';
export type ImageComplexity = 'auto' | 'minimal' | 'balanced' | 'detailed' | 'highly_detailed';
export type ImageComposition = 'auto' | 'hero_subject' | 'centered' | 'split' | 'wide_scene' | 'close_up' | 'text_space_left' | 'text_space_right' | 'layered_editorial' | 'grid' | 'progression';
export type ImageHumanPresence = 'auto' | 'none' | 'single_person' | 'team' | 'hands_only' | 'abstract_human';
export type ImageBackgroundStyle = 'auto' | 'clean' | 'abstract' | 'environmental' | 'gradient' | 'isolated' | 'architectural' | 'spatial';
export type ImageTextMode = 'auto' | 'none' | 'headline' | 'minimal' | 'structured';

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
  visualFormat?: VisualFormat;
  imageType?: ImageType;
  mood?: ImageMood;
  colorPalette?: ImageColorPalette;
  complexity?: ImageComplexity;
  composition?: ImageComposition;
  humanPresence?: ImageHumanPresence;
  backgroundStyle?: ImageBackgroundStyle;
  textMode?: ImageTextMode;
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

export interface ResolvedImageCreativeDirection {
  visualFormat: Exclude<VisualFormat, 'auto'>;
  centralMessage: string;
  visualConcept: string;
  visualMetaphor: string;
  imageType: Exclude<ImageType, 'auto'>;
  mood: Exclude<ImageMood, 'auto'>;
  colorPalette: Exclude<ImageColorPalette, 'auto'>;
  complexity: Exclude<ImageComplexity, 'auto'>;
  composition: Exclude<ImageComposition, 'auto'>;
  humanPresence: Exclude<ImageHumanPresence, 'auto'>;
  backgroundStyle: Exclude<ImageBackgroundStyle, 'auto'>;
  textMode: Exclude<ImageTextMode, 'auto'>;
  aspectRatio: LinkedInImageAspectRatio;
  visualRelationship: string;
  primarySubject: string;
  supportingElements: string[];
  avoidElements: string[];
}

const CREATIVE_OPTION_VALUES = {
  visualFormat: new Set(['auto', 'visual_comparison', 'process_flow', 'comic', 'annotated_explainer', 'concept_poster', 'timeline_transformation', 'data_graphic', 'diagram', 'editorial_illustration', 'screenshot_explainer', 'visual_metaphor', 'scene']),
  imageType: new Set(['auto', 'photorealistic', 'editorial', 'conceptual', 'infographic', 'illustration', '3d', 'branded_graphic']),
  mood: new Set(['auto', 'professional', 'bold', 'premium', 'trustworthy', 'energetic', 'calm', 'thought_provoking', 'friendly', 'playful']),
  colorPalette: new Set(['auto', 'brand', 'clean', 'dark', 'high_contrast', 'vibrant', 'pastel', 'monochrome', 'neutral']),
  complexity: new Set(['auto', 'minimal', 'balanced', 'detailed', 'highly_detailed']),
  composition: new Set(['auto', 'hero_subject', 'centered', 'split', 'wide_scene', 'close_up', 'text_space_left', 'text_space_right', 'layered_editorial', 'grid', 'progression']),
  humanPresence: new Set(['auto', 'none', 'single_person', 'team', 'hands_only', 'abstract_human']),
  backgroundStyle: new Set(['auto', 'clean', 'abstract', 'environmental', 'gradient', 'isolated', 'architectural', 'spatial']),
  textMode: new Set(['auto', 'none', 'headline', 'minimal', 'structured']),
} as const;

export function parseImageCreativeOverrides(body: Record<string, unknown> | undefined): Partial<GenerateLinkedInPostImageInput> {
  const result: Record<string, string> = {};
  for (const [key, values] of Object.entries(CREATIVE_OPTION_VALUES)) {
    const value = body?.[key];
    if (typeof value === 'string' && values.has(value as never)) result[key] = value;
  }
  return result as Partial<GenerateLinkedInPostImageInput>;
}

function firstMeaningfulLine(postText: string): string {
  return postText.split(/\r?\n/).map((line) => line.replace(/^[-*\d.)\s]+/, '').trim())
    .find((line) => line.length >= 12) ?? postText.trim().slice(0, 240);
}

/** Generic, post-first art direction. It deliberately contains no niche mappings. */
export function resolveImageCreativeDirection(input: GenerateLinkedInPostImageInput): ResolvedImageCreativeDirection {
  const post = input.postText.trim();
  const instructions = input.instructions?.trim() ?? '';
  const comparison = /\b(vs\.?|versus|instead of|rather than|compared (?:with|to)|from .{1,50} to|old .{1,30} new)\b/i.test(post);
  const process = /\b(step|steps|process|workflow|framework|sequence|first|second|finally|how to)\b/i.test(post);
  const constraint = /\b(bottleneck|blocked|constraint|friction|congestion|narrow|overload|stuck)\b/i.test(post);
  const disconnect = /\b(disconnect|fragment|silo|misalign|do not communicate|don't communicate|missing connection)\b/i.test(post);
  const transformation = /\b(transform\w*|shift\w*|transition\w*|before and after|become|evolv\w*|change from)\b/i.test(post);
  const growth = /\b(grow|growth|scale|expand|momentum|accelerat)\w*/i.test(post);
  const simplicity = /\b(simple|simplif|clarity|focus|less is more|remove)\w*/i.test(post);
  const reflective = /\b(i realized|i learned|reflection|looking back|sometimes|we forget|lesson)\b/i.test(post);
  const assertive = /(^|\n)\s*(stop|never|the truth|unpopular opinion)|\b(isn't|is not|must|wrong)\b/i.test(post);
  const announcement = /\b(launch|announc|introduc|excited|new product|new service)\w*/i.test(post);
  const realWorld = /\b(customer|client|meeting|conversation|workplace|event|experience|story)\b/i.test(post);
  const humorous = /\b(humor|funny|joke|relatable|again and again|every time|plot twist|expectation|reality)\b|(?:😂|🤣|😅)/iu.test(`${post} ${instructions}`);
  const tutorial = /\b(tutorial|guide|checklist|here's how|try this|do this|tips?\b)\b/i.test(post);
  const system = process || constraint || disconnect || /\b(system|depend|connect|coordinate|input|output|flow)\w*/i.test(post);
  const statistic = /(?:^|\s)(?:\d{1,3}(?:\.\d+)?%|\$\d[\d,.]*|\d+(?:\.\d+)?x)(?:\s|$)/m.test(post);
  const customComic = /\b(comic|panels?|four[- ]stage|4[- ]stage)\b/i.test(instructions);
  const customNoPeople = /\b(no|without|do not include|don't include)\s+(?:any\s+)?(?:people|persons?|humans?|characters?)\b/i.test(instructions);
  const customFormat: Exclude<VisualFormat, 'auto'> | undefined = customComic ? 'comic'
    : /\bvisual comparison|split comparison|before[- ]and[- ]after\b/i.test(instructions) ? 'visual_comparison'
    : /\btimeline|transformation journey\b/i.test(instructions) ? 'timeline_transformation'
    : /\bprocess flow|flowchart\b/i.test(instructions) ? 'process_flow'
    : /\bannotated explainer\b/i.test(instructions) ? 'annotated_explainer'
    : /\bdata graphic\b/i.test(instructions) ? 'data_graphic'
    : /\bdiagram\b/i.test(instructions) ? 'diagram'
    : /\bconcept poster\b/i.test(instructions) ? 'concept_poster'
    : /\bvisual metaphor\b/i.test(instructions) ? 'visual_metaphor'
    : /\breal[- ]world scene|photographic scene\b/i.test(instructions) ? 'scene'
    : undefined;
  const customTextMode: Exclude<ImageTextMode, 'auto'> | undefined = /\b(no|without)\s+(?:visible\s+)?text\b/i.test(instructions) ? 'none'
    : /\bstructured (?:text|labels)|step labels\b/i.test(instructions) ? 'structured'
    : /\bminimal text|short labels?\b/i.test(instructions) ? 'minimal'
    : /\bheadline\b/i.test(instructions) ? 'headline'
    : undefined;

  let visualRelationship = 'central_insight';
  if (comparison) visualRelationship = transformation ? 'transformation' : 'comparison';
  else if (constraint) visualRelationship = 'bottleneck';
  else if (disconnect) visualRelationship = 'fragmentation';
  else if (process) visualRelationship = 'progression';
  else if (transformation) visualRelationship = 'transformation';
  else if (growth) visualRelationship = 'growth';
  else if (simplicity) visualRelationship = 'simplification';

  let autoFormat: Exclude<VisualFormat, 'auto'> = 'visual_metaphor';
  if (customComic || humorous) autoFormat = 'comic';
  else if (comparison && transformation) autoFormat = 'timeline_transformation';
  else if (comparison) autoFormat = 'visual_comparison';
  else if (statistic) autoFormat = 'data_graphic';
  else if (tutorial) autoFormat = 'annotated_explainer';
  else if (system) autoFormat = 'diagram';
  else if (transformation || growth) autoFormat = 'timeline_transformation';
  else if (realWorld) autoFormat = 'editorial_illustration';
  else if (assertive || reflective) autoFormat = 'concept_poster';

  const visualFormat = customFormat
    ? customFormat
    : input.visualFormat && input.visualFormat !== 'auto' ? input.visualFormat : autoFormat;

  let visualConcept = 'One cohesive focal structure that makes the post’s central relationship immediately understandable.';
  let visualMetaphor = 'Use an original concept-led metaphor only if it makes the central message clearer.';
  if (comparison) {
    visualConcept = 'A deliberate contrast between two states or approaches, with one clear relationship connecting them.';
    visualMetaphor = 'Contrast, divergence, or before-and-after structure without generic arrows or labels.';
  } else if (constraint) {
    visualConcept = 'A capable flowing system visibly compressed or restricted at one consequential point.';
    visualMetaphor = 'Restriction, narrowing, congestion, or blocked flow.';
  } else if (disconnect) {
    visualConcept = 'Strong individual components separated by meaningful gaps that prevent the larger system from working.';
    visualMetaphor = 'Fragmentation, missing connections, or conflicting alignment.';
  } else if (process) {
    visualConcept = 'A coherent progression of connected elements with a readable sense of movement and consequence.';
    visualMetaphor = 'Flow, sequence, layering, or coordinated stages—not automatically an infographic.';
  } else if (transformation || growth) {
    visualConcept = 'A stable visual progression from one state into a stronger or expanded state.';
    visualMetaphor = 'Transformation, increasing scale, or momentum without stock graphs or decorative arrows.';
  } else if (simplicity) {
    visualConcept = 'One clear signal emerging from unnecessary complexity, expressed through strong hierarchy.';
    visualMetaphor = 'Noise resolving into clarity or many elements reducing to the essential few.';
  }

  const structuredFormat = ['process_flow', 'annotated_explainer', 'data_graphic', 'diagram', 'screenshot_explainer'].includes(visualFormat);
  const autoType: Exclude<ImageType, 'auto'> = visualFormat === 'scene' ? 'photorealistic' : visualFormat === 'comic' || visualFormat === 'editorial_illustration' ? 'illustration' : structuredFormat ? 'infographic' : visualFormat === 'visual_metaphor' ? 'conceptual' : 'editorial';
  const autoMood: Exclude<ImageMood, 'auto'> = humorous || customComic ? 'playful' : announcement ? 'energetic' : reflective ? 'thought_provoking' : assertive ? 'bold' : 'professional';
  const autoPalette: Exclude<ImageColorPalette, 'auto'> = assertive ? 'high_contrast' : reflective ? 'neutral' : announcement ? 'vibrant' : 'clean';
  const autoComplexity: Exclude<ImageComplexity, 'auto'> = simplicity && !structuredFormat ? 'minimal' : structuredFormat || visualFormat === 'comic' ? 'detailed' : 'balanced';
  const autoComposition: Exclude<ImageComposition, 'auto'> = visualFormat === 'comic' ? 'grid' : visualFormat === 'timeline_transformation' || visualFormat === 'process_flow' ? 'progression' : visualFormat === 'visual_comparison' ? 'split' : structuredFormat ? 'layered_editorial' : realWorld ? 'wide_scene' : 'hero_subject';
  const autoHumans: Exclude<ImageHumanPresence, 'auto'> = realWorld && !constraint && !disconnect ? 'single_person' : 'none';
  const autoBackground: Exclude<ImageBackgroundStyle, 'auto'> = realWorld ? 'environmental' : process || disconnect ? 'spatial' : 'abstract';
  const autoText: Exclude<ImageTextMode, 'auto'> = visualFormat === 'comic' || visualFormat === 'process_flow' || visualFormat === 'annotated_explainer' || visualFormat === 'diagram' ? 'structured' : visualFormat === 'visual_comparison' || visualFormat === 'timeline_transformation' || visualFormat === 'data_graphic' ? 'minimal' : visualFormat === 'concept_poster' ? 'headline' : 'none';
  const resolvedMood = input.mood && input.mood !== 'auto' ? input.mood : autoMood;
  const resolvedTextMode = customTextMode ?? (input.textMode && input.textMode !== 'auto' ? input.textMode : autoText);

  const supportingElements = structuredFormat
    ? ['Only the few nodes, stages, labels, or annotations required to explain the relationship.', 'A clear reading order and visible connections between related elements.']
    : ['Secondary elements that reinforce the same focal idea without becoming decoration.'];
  const avoidElements = ['literal keyword collage', 'generic technology decoration', 'unrelated stock business people', 'invented statistics or claims'];

  return {
    visualFormat, centralMessage: firstMeaningfulLine(post), visualConcept, visualMetaphor,
    visualRelationship,
    primarySubject: 'The single relationship, change, system, or insight at the center of the post—not isolated topic keywords.',
    supportingElements,
    avoidElements,
    aspectRatio: input.aspectRatio ?? '1:1',
    imageType: input.imageType && input.imageType !== 'auto' ? input.imageType : autoType,
    mood: resolvedMood,
    colorPalette: input.colorPalette && input.colorPalette !== 'auto' ? input.colorPalette : autoPalette,
    complexity: input.complexity && input.complexity !== 'auto' ? input.complexity : autoComplexity,
    composition: input.composition && input.composition !== 'auto' ? input.composition : autoComposition,
    humanPresence: customNoPeople ? 'none' : input.humanPresence && input.humanPresence !== 'auto' ? input.humanPresence : autoHumans,
    backgroundStyle: input.backgroundStyle && input.backgroundStyle !== 'auto' ? input.backgroundStyle : autoBackground,
    textMode: resolvedTextMode,
  };
}

const DIRECTIONS = {
  imageType: { photorealistic: 'Photorealistic, believable real-world image craft.', editorial: 'Art-directed editorial imagery with a strong narrative point of view.', conceptual: 'Conceptual imagery built around one intelligent visual metaphor.', infographic: 'A refined information-led composition only where structure genuinely aids understanding.', illustration: 'Sophisticated editorial illustration with intentional forms and materials.', '3d': 'Premium dimensional artwork with purposeful depth; avoid generic surreal 3D decoration.', branded_graphic: 'A polished branded editorial graphic, leaving real logo reproduction to post-processing.' },
  mood: { professional: 'Assured and professional without looking like stock corporate media.', bold: 'Bold, decisive, and visually confident.', premium: 'Restrained, premium, and meticulously crafted.', trustworthy: 'Grounded, credible, and clear.', energetic: 'Energetic with controlled movement and visual momentum.', calm: 'Calm, spacious, and considered.', thought_provoking: 'Thought-provoking with a subtle sense of tension or discovery.', friendly: 'Warm, approachable, and human without becoming childish.', playful: 'Playful and witty with clear visual timing, while remaining polished.' },
  palette: { brand: 'Let available brand context subtly influence the palette without dominating it.', clean: 'Use a clean, crisp palette chosen for the concept and readability.', dark: 'Use a purposeful dark palette with controlled contrast.', high_contrast: 'Use strong, intentional contrast to clarify the focal relationship.', vibrant: 'Use a vibrant but disciplined palette.', pastel: 'Use a nuanced pastel palette with sufficient contrast.', monochrome: 'Use a sophisticated monochrome treatment with tonal depth.', neutral: 'Use a refined neutral palette with selective accents.' },
} as const;

export function buildLinkedInImagePrompt(input: GenerateLinkedInPostImageInput): string {
    const {
      postText,
      instructions,
      brandName,
      profileDescription,
      aspectRatio = '1:1',
    } = input;
    const direction = resolveImageCreativeDirection(input);
    const legacyStyle = input.style?.trim() && input.style !== 'auto'
      ? `Honor this user-selected visual treatment: ${input.style.trim()}.`
      : 'No legacy style preset is imposed; art-direct from the post.';

    return `
OBJECTIVE
Create one intentional, premium LinkedIn feed image art-directed specifically for this post.
Read the complete post and determine the single strongest visual idea representing its central message.
Do not reproduce every sentence or create a collage of unrelated ideas.
The goal is not merely a beautiful image about the topic; it is a visual that communicates the central idea of this specific post.
The image should add information, explanation, humor, contrast, or visual storytelling and make reasonable sense without the full caption.
Do not extract keywords and place literal objects for each keyword into one scene. Identify the relationship between ideas first.

POST TEXT:
${postText.trim()}

SUPPORTING CREATOR / PROFILE CONTEXT
${profileDescription?.trim() || 'No specific creator profile context provided.'}

CENTRAL MESSAGE
${direction.centralMessage}

VISUAL RELATIONSHIP
${direction.visualRelationship}

SELECTED VISUAL COMMUNICATION FORMAT
${direction.visualFormat}. Use this as a feed-native communication structure, not merely an art-style label.

VISUAL CONCEPT
${direction.visualConcept}

OPTIONAL VISUAL METAPHOR
${direction.visualMetaphor}

PRIMARY SUBJECT
${direction.primarySubject}

SUPPORTING INFORMATION
${direction.supportingElements.map((item) => `- ${item}`).join('\n')}

INFORMATION HIERARCHY
- Make the visual idea understandable in roughly 1-2 seconds with one unmistakable focal point.
- Every important element must have a communicative reason to exist.
- Prefer clarity and relationship design over decorative complexity.

USER IMAGE INSTRUCTIONS:
${instructions?.trim() || 'Create a clean professional visual that supports the main idea of the post.'}

ART DIRECTION
- Image type: ${DIRECTIONS.imageType[direction.imageType]}
- Mood: ${DIRECTIONS.mood[direction.mood]}
- Complexity: ${direction.complexity}; use meaningful depth, not clutter.
- ${legacyStyle}

COMPOSITION AND SPATIAL DEPTH
- Composition: ${direction.composition}; treat this as communicative direction, not a rigid template.
- Build foreground, midground, background, scale, perspective, light, material, or texture where they strengthen the concept.

COLOR AND LIGHTING
- ${DIRECTIONS.palette[direction.colorPalette]}
- Choose lighting that reinforces the focal idea and mood.

HUMAN PRESENCE
- Direction: ${direction.humanPresence}. Include people only when they materially communicate this post's idea.

BACKGROUND
- Direction: ${direction.backgroundStyle}. Make it concept-driven, never selected from an industry stereotype.

BRAND CONTEXT
- Brand name/context: ${brandName?.trim() || 'No specific brand'}.
- Use brand context subtly. Never reproduce, invent, or redraw a logo; a real logo may be added later.
- Treat profile context only as supporting audience/positioning context. Never let niche dictate palette, props, setting, people, or style.

ASPECT RATIO
- ${aspectRatio}.
- ${aspectRatio === '4:5' ? 'Use strong vertical storytelling, large central elements, and a clear top-to-bottom hierarchy.' : aspectRatio === '16:9' ? 'Use the horizontal canvas for left/right relationships, wide diagrams, or environmental storytelling.' : 'Use a compact hierarchy with immediate feed readability and no cramped peripheral detail.'}

TEXT RULES
- Text mode: ${direction.textMode}.
- Auto has already been resolved from the visual format. Use only text necessary to understand the visual.
- For structured mode, allow concise step numbers, labels, or short captions with a clear reading order.
- For minimal mode, use only a short heading, comparison labels, date/state labels, or one faithful key number when genuinely present in the post.
- For headline mode, use one short faithful phrase. For none, render no visible text.
- Prefer one to five words per label. Avoid paragraphs, long sentences, small typography, dense copy, caption duplication, invented statistics, or altered factual claims.
- Keep all typography large, high-contrast, legible, and understandable at LinkedIn feed size.
- Create a clean, polished LinkedIn visual that supports the post's specific business idea.
- Do not include the full creator/profile context as visible text.
- Do not add random labels, taglines, or category names such as "AI Automation" unless explicitly requested in the user instructions or brand name.
- Avoid weird surreal 3D scenes, random megaphones, lighthouses, diamonds, badges, fake logos, or decorative icons unless they directly support the post.
- Prefer clean editorial business graphics, simple diagrams, abstract SaaS/productivity visuals, content strategy metaphors, or professional creator-style visuals.
- Premium, polished, clear, and suitable for a professional LinkedIn audience.
- Communicate one strong idea visually without clutter.
- Avoid tiny or unreadable text.
- Never include hashtags or text beginning with # anywhere in the image.
- Never render the creator's niche name, industry category, or profile label as visible text in the image.
- Do not repeat the full post text inside the image.
- Do not create fake screenshots unless explicitly requested.
- Do not include copyrighted logos, real company logos, or recognizable real people.
- The image should feel specific to the post, not like a generic AI/tech motivational poster.

QUALITY REQUIREMENTS AND AVOID
- Create meaningful depth and use secondary elements only when they reinforce the same central idea.
- Avoid overly empty compositions unless minimalism strengthens the concept.
- Avoid generic corporate stock photography, random floating icons, meaningless UI panels, decorative charts, cheap template aesthetics, giant phones, oversized devices, generic glowing brains, humanoid robots, laptop-at-desk scenes, handshakes, business people beside screens, people pointing at dashboards, floating dashboards, random monitors, holographic circles, neon lighting, blue/purple cyber backgrounds, random cinematic technology environments, unnecessary circuitry, and generic growth arrows.
- Do not automatically create futuristic technology artwork because the post mentions software, AI, websites, or business.
- Avoid using perceived visual complexity as a substitute for communication.
- Specifically avoid: ${direction.avoidElements.join(', ')}.
- Avoid niche stereotypes and visual clichés whenever a more original representation communicates the idea.
- The result must feel deliberately art-directed for this specific post.
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
