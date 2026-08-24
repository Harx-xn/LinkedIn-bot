import type { EffectiveBotStrategy, WritingStyle } from './botStrategyService';
import type { ExpressionMode, PostAngle } from './generationTypes';

export const RECENT_STYLE_POST_LIMIT = 5;

const MODES: ExpressionMode[] = ['direct', 'analytical', 'diagnostic', 'conversational', 'opinionated', 'walkthrough', 'reflective'];

const MODE_RULES: Record<ExpressionMode, string[]> = {
  direct: ['State the claim immediately, give its strongest support, then stop.', 'Use concise declarative prose; setup, examples, advice, conclusions, and CTAs are optional.'],
  analytical: ['Develop the assigned relationship through causal reasoning and only the implication or condition it needs.', 'Use denser reasoning where useful; do not automatically pivot into a checklist or advice.'],
  diagnostic: ['Move from a concrete signal toward the relevant cause and response.', 'A scenario, diagnostic check, correction, and prevention step are each optional.'],
  conversational: ['Use a natural spoken progression, mixed cadence, and unsymmetrical paragraphs.', 'Avoid staged article transitions and stop where the thought naturally completes.'],
  opinionated: ['Make the position clear early and defend it with credible reasoning.', 'Qualification is optional; forced balance and engagement questions are not required.'],
  walkthrough: ['Keep setup brief and make the actual sequence or process the body.', 'Include only intrinsic steps; the last meaningful step may be the ending.'],
  reflective: ['Develop a precise observation into its useful implication.', 'Use a thoughtful cadence; advice, lessons, lists, conclusions, and CTAs are optional.'],
};

const MODE_FALLBACK_STRUCTURES: Record<ExpressionMode, string> = {
  direct: 'claim -> support',
  analytical: 'claim -> causal reasoning -> implication or condition',
  diagnostic: 'symptom -> trace -> cause -> fix or decision',
  conversational: 'observation -> free-form discussion',
  opinionated: 'position -> reasons; qualification optional',
  walkthrough: 'goal -> implementation sequence',
  reflective: 'observation -> implication',
};

export function getExpressionModeFallbackStructure(mode: ExpressionMode = 'direct'): string {
  return MODE_FALLBACK_STRUCTURES[mode];
}

export function expressionModeFromPrompt(prompt: string): ExpressionMode | undefined {
  const match = prompt.match(/EXPRESSION MODE:\s*(DIRECT|ANALYTICAL|DIAGNOSTIC|CONVERSATIONAL|OPINIONATED|WALKTHROUGH|REFLECTIVE)/i);
  const mode = match?.[1]?.toLowerCase() as ExpressionMode | undefined;
  return mode && MODES.includes(mode) ? mode : undefined;
}

export function buildExpressionModeSystemInstruction(mode: ExpressionMode | undefined): string {
  if (!mode) return '';
  return `EXPRESSION MODE: ${mode.toUpperCase()}\n${MODE_RULES[mode].map((rule) => `- ${rule}`).join('\n')}`;
}

export function selectBatchExpressionMode(index: number, angle: PostAngle): ExpressionMode {
  const preferredByAngle: Partial<Record<PostAngle, ExpressionMode>> = {
    practical_tutorial: 'walkthrough', technical_mistake: 'diagnostic', architecture_tradeoff: 'analytical',
    defensible_opinion: 'opinionated', debugging_story: 'diagnostic', product_lesson: 'direct', reflection: 'reflective',
  };
  const preferred = preferredByAngle[angle];
  if (preferred && MODES[(index - 1 + MODES.length) % MODES.length] !== preferred) return preferred;
  return MODES[index % MODES.length];
}

function inferRecentModes(posts: string[]): Set<ExpressionMode> {
  const text = posts.join('\n').toLowerCase(); const modes = new Set<ExpressionMode>();
  if ((text.match(/\b(?:however|therefore|ultimately|consequently)\b/g) ?? []).length >= 2) modes.add('analytical');
  if (/\b(?:trace|symptom|debug|failure path|root cause)\b/.test(text)) modes.add('diagnostic');
  if (/\b(?:step 1|first,|second,|→|->)\b/.test(text)) modes.add('walkthrough');
  if ((text.match(/\?/g) ?? []).length >= 2) modes.add('conversational');
  return modes;
}

function compactRecentPostFingerprint(post: string, index: number): string {
  const lines = post.split('\n').map((line) => line.trim()).filter(Boolean);
  const firstLine = lines[0] ?? '';
  const lastLine = lines.at(-1) ?? '';
  const inferredMode = [...inferRecentModes([post])][0] ?? 'unknown';
  const hookType = firstLine.endsWith('?') ? 'question' : /^\s*(?:[-*•]|\d+[.)])/.test(firstLine) ? 'list' : 'declarative';
  const structure = /^\s*(?:[-*•]|\d+[.)])/m.test(post) ? 'enumerated' : post.split(/\n\s*\n+/).length <= 2 ? 'compact' : 'multi-paragraph';
  const evidenceType = /\b(?:I|we|my|our)\b/.test(post) ? 'first-person' : /\b\d+(?:\.\d+)?%?\b/.test(post) ? 'numeric' : /\b(?:because|mechanism|cause|underlying)\b/i.test(post) ? 'causal' : 'observation';
  const closingType = lastLine.endsWith('?') ? 'question' : /\b(?:should|try|start|remember|takeaway)\b/i.test(lastLine) ? 'recommendation' : 'declarative-stop';
  const topicHint = firstLine.replace(/\s+/g, ' ').slice(0, 96) || '(empty)';
  return `${index + 1}. topicHint="${topicHint}"; mode=${inferredMode}; hook=${hookType}; structure=${structure}; evidence=${evidenceType}; closing=${closingType}`;
}

export function selectManualExpressionMode(topic: string, instructions: string | undefined, style: WritingStyle | undefined, recentPosts: string[]): ExpressionMode {
  const input = `${topic} ${instructions ?? ''}`.toLowerCase();
  const controls = (instructions ?? '').toLowerCase();
  const candidates: ExpressionMode[] = [];
  // Explicit structural requests take precedence over the default editorial bias.
  if (/preferred (?:format|angle):[^\n]*(?:listicle|bullet list|how-to)|preferred structure:[^\n]*(?:steps|walkthrough)/.test(controls)) candidates.push('walkthrough');
  if (/desired variation:\s*storytelling|preferred structure:[^\n]*story|preferred structure:[^\n]*question/.test(controls)) candidates.push('conversational');
  if (/preferred angle:[^\n]*lessons learned/.test(controls)) candidates.push('reflective');
  if (/preferred tone override:[^\n]*analytical/.test(controls)) candidates.push('analytical');
  if (/preferred format:[^\n]*single insight|preferred tone override:[^\n]*bold/.test(controls)) candidates.push('direct');
  if (/preferred angle:[^\n]*contrarian/.test(controls)) candidates.push('opinionated');
  if (/\b(?:debug|failure|broken|error|bug|trace|why.*fails)\b/.test(input)) candidates.push('diagnostic');
  if (/\b(?:how to|steps|implement|setup|configure|walkthrough|listicle|checklist)\b/.test(input)) candidates.push('walkthrough');
  if (/\b(?:story|storytelling|narrative)\b/.test(input)) candidates.push('conversational');
  if (/\b(?:opinion|hot take|should|must|wrong|contrarian)\b/.test(input)) candidates.push('opinionated');
  if (/\b(?:compare|tradeoff|versus|why|analysis|analytical)\b/.test(input)) candidates.push('analytical');
  if (/\b(?:reflect|lesson|observation)\b/.test(input)) candidates.push('reflective');
  if ((style?.tone ?? []).some((tone) => /conversational|casual/i.test(tone))) candidates.push('conversational');
  if (/\b(?:isn'?t|is not|rarely|usually|often|biggest|real obstacle|real problem)\b/.test(input)) candidates.push('direct');
  // With no strong control, prefer thought-leadership architectures that
  // develop one claim through reasoning rather than enumerate a topic.
  candidates.push('analytical', 'direct', 'reflective', 'conversational');
  const recentModes = inferRecentModes(recentPosts);
  return candidates.find((mode) => !recentModes.has(mode)) ?? candidates[0];
}

export function buildExpressionModePromptBlock(mode: ExpressionMode | undefined, recentPosts: string[], strategy?: EffectiveBotStrategy): string {
  if (!mode) return '';
  const recent = recentPosts.slice(0, RECENT_STYLE_POST_LIMIT).map(compactRecentPostFingerprint).join('\n');
  return `EXPRESSION MODE: ${mode.toUpperCase()}
This controls cadence and movement within the assigned editorial form; it does not add mandatory sections.
${MODE_RULES[mode].map((rule) => `- ${rule}`).join('\n')}
- Keep the author's identity stable. Saved style: ${(strategy?.writingStyle.tone ?? []).join(', ') || 'supplied author tone'}; ${strategy?.writingStyle.formality ?? 'balanced'} formality; ${strategy?.writingStyle.postLength ?? 'medium'} preferred length.

RECENT RHETORICAL FINGERPRINTS (full post bodies omitted):
${recent || '(No recent posts available.)'}
- Avoid repeating the same opening, structure, evidence placement, list usage, cadence, or closing type. Change the thought ordering, not merely synonyms.`;
}
