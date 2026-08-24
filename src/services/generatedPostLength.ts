import type { PostTargetLengthRange } from './generationTypes';

export const MIN_GENERATED_POST_LENGTH = 1600;
export const PREFERRED_GENERATED_POST_MIN = 1800;
export const PREFERRED_GENERATED_POST_MAX = 2500;
export const MAX_LINKEDIN_POST_LENGTH = 3000;
export const MAX_LENGTH_REPAIR_ATTEMPTS = 2;

export type PostLengthStatus = 'TOO_SHORT' | 'ACCEPTABLE' | 'PREFERRED' | 'TOO_LONG';

export function evaluateGeneratedPostLength(
  content: string,
  targetLengthRange?: PostTargetLengthRange,
  minimumCompleteLength?: number,
): PostLengthStatus {
  const length = content.length;
  const minimum = minimumCompleteLength ?? targetLengthRange?.min ?? MIN_GENERATED_POST_LENGTH;
  const preferredMin = targetLengthRange?.min ?? PREFERRED_GENERATED_POST_MIN;
  const preferredMax = targetLengthRange?.max ?? PREFERRED_GENERATED_POST_MAX;
  if (length < minimum) return 'TOO_SHORT';
  if (length > MAX_LINKEDIN_POST_LENGTH) return 'TOO_LONG';
  if (length <= preferredMax && length >= preferredMin) return 'PREFERRED';
  return 'ACCEPTABLE';
}

export function isExplicitShorteningInstruction(instruction?: string | null): boolean {
  return /\b(shorten|shorter|make (?:it|this) short|more concise|condense|brief(?:er)?|reduce (?:the )?length|cut (?:it|this) down)\b/i.test(instruction ?? '');
}

export function buildLengthRepairInstruction(
  status: 'TOO_SHORT' | 'TOO_LONG',
  targetLengthRange?: PostTargetLengthRange,
): string {
  if (status === 'TOO_LONG') {
    if (targetLengthRange) {
      return `Condense this LinkedIn post below 3,000 characters while preserving its strongest ideas, hook, argument, useful specificity, and voice.

The assigned plan's soft guidance range is ${targetLengthRange.min.toLocaleString('en-US')}–${targetLengthRange.max.toLocaleString('en-US')} characters. Move toward that range only by removing repetition and unnecessary wording. Keep any substance required to complete the claim, and do not silently truncate the post.`;
    }
    return `Condense this LinkedIn post below 3,000 characters while preserving its strongest ideas, hook, argument, useful specificity, and voice.

Target approximately 2,200–2,700 characters. Remove repetition and unnecessary wording rather than important reasoning. Do not silently truncate the post.`;
  }
  const rangeContext = targetLengthRange
    ? `The plan's soft guidance range is ${targetLengthRange.min.toLocaleString('en-US')}–${targetLengthRange.max.toLocaleString('en-US')} characters, but reaching that range is not the objective.`
    : `The draft is below Veyrais's preferred minimum length.`;
  const stoppingInstruction = targetLengthRange
    ? 'Stop as soon as the missing substance is complete. Do not expand merely to reach a character target, and remain below 3,000 characters.'
    : 'Target approximately 1,800–2,300 characters and remain below 3,000 characters.';
  return `Complete this LinkedIn post while preserving its original thesis, voice, and natural structure.

${rangeContext} First identify the one or at most two meaningful argumentative dimensions missing from it. Choose only dimensions that materially improve understanding, such as an underlying cause, observable symptom, real consequence, hidden trade-off, counterintuitive tension, practical implication, decision boundary, failure pattern, specific example, supported personal observation, change in approach, or qualification.

Add only those missing dimensions. Every new paragraph must introduce a materially new proposition. Do not make the post longer by rephrasing or further explaining an idea that is already clear. Do not restate the thesis, repeat a benefit or downside, add generic context, force an industry example, append advice, or add a second conclusion.

When an approved Depth Plan is supplied, choose the missing or underdeveloped dimension from that plan. Do not independently invent a new generic argument.

Preserve the central claim, voice, Expression Mode, and argument direction. ${stoppingInstruction}`;
}
