import type { EffectiveBotStrategy, WritingStyle } from './botStrategyService';
import type { ExpressionMode, PostAngle } from './generationTypes';

export const RECENT_STYLE_POST_LIMIT = 5;

const MODES: ExpressionMode[] = ['direct', 'analytical', 'diagnostic', 'conversational', 'opinionated', 'walkthrough', 'reflective'];

const MODE_RULES: Record<ExpressionMode, string[]> = {
  direct: ['Preferred movement: CLAIM -> SUPPORT -> STOP: one narrow claim -> its strongest concrete manifestations -> an underlying interpretation or strongest consequence when needed -> stop.', 'State the point immediately; no topic overview is required.', 'Use only the planned substance needed to make the claim credible and satisfy the generation contract.', 'Optional moves: one compact example or one correction, only when necessary.', 'Avoid by default: scenarios, recommendation sections, summaries, motivational endings, CTAs, and rhetorical questions.', 'Use short or medium declarative sentences, minimal transitions, and either compact paragraphs or selective standalone lines.', 'Stopping condition: after the few strongest planned moves have completed the argument and satisfied the generation contract, end the post. Do not manufacture a conclusion.'],
  analytical: ['Preferred movement: OBSERVATION OR CLAIM -> CAUSAL REASONING -> IMPLICATION OR CONDITION.', 'Explain why one relationship occurs; use denser reasoning where useful.', 'Optional moves: an integrated example, qualification, or recommendation.', 'Avoid by default: checklists and an automatic pivot from analysis into advice, benefits, and takeaway.', 'Stopping condition: end when the causal relationship and its implication are clear.'],
  diagnostic: ['Preferred movement: symptom -> trace -> cause -> fix or decision.', 'Begin with a concrete symptom and trace it toward the root cause.', 'Optional moves: a directly stated scenario or one corrective action.', 'Avoid by default: educational setup and broad positive benefits after the fix.', 'Mix short symptom lines with grouped explanatory sentences.', 'Stopping condition: end after the cause and appropriate response are clear.'],
  conversational: ['Preferred movement: observation -> free-form discussion through a natural thought progression.', 'Use spoken rhythm, contractions, mixed sentence lengths, mixed paragraph sizes, and an occasional natural fragment.', 'Optional moves: reader address, examples, advice, questions, or a conclusion.', 'Avoid by default: polished article transitions, symmetrical paragraphs, announced hypothetical stories, and corporate consultant language.', 'Stopping condition: stop where a real person would naturally stop making the point.'],
  opinionated: ['Preferred movement: POSITION -> REASONS -> OPTIONAL QUALIFICATION.', 'Make the position obvious early and defend it with real reasoning.', 'Optional moves: one qualification, example, question, or recommendation.', 'Avoid by default: softening every assertion, forced balance, broad educational setup, and generic engagement questions.', 'Stopping condition: end after the position has been sufficiently defended.'],
  walkthrough: ['Preferred movement: GOAL -> SEQUENCE OR PROCESS.', 'Keep context brief; compact steps or naturally ordered actions are appropriate.', 'Optional moves: an example integrated into a step or a necessary warning.', 'Avoid by default: unrelated best practices, a lesson after the final step, and motivational recap.', 'Stopping condition: the last meaningful step may be the final line.'],
  reflective: ['Preferred movement: OBSERVATION -> IMPLICATION.', 'Use a slower, thoughtful cadence and few or no lists; ambiguity is allowed where honest.', 'Optional moves: a qualification or integrated example.', 'Do not force recommendations, action steps, lessons, CTAs, or motivational endings.', 'Stopping condition: end on the implication or observation.'],
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

const MODE_EXECUTION_GUARDS: Record<ExpressionMode, string[]> = {
  direct: ['For this draft, omit examples and hypothetical scenarios.', 'Do not pivot into advice, benefits, a takeaway, or a conclusion.', 'Use the smallest set of planned moves that can complete the argument and satisfy the generation contract, then stop.'],
  analytical: ['For this draft, develop one causal relationship without a hypothetical scenario.', 'Do not pivot into recommendations or a positive-outcome ending.', 'End on the implication or governing condition.'],
  diagnostic: ['Open with the observable symptom, not background or a general claim.', 'Trace the symptom to one cause and give at most one direct response.', 'Do not add broad benefits or a concluding lesson after the response.'],
  conversational: ['For this draft, do not use an announced example, imagined scenario, or analogy.', 'Let the thought move in spoken language without a recommendation section or polished conclusion.', 'Use visibly mixed cadence and stop naturally.'],
  opinionated: ['Open with an unmistakable position.', 'Defend it without a hypothetical scenario, balanced overview, recommendation section, or engagement question.', 'End on the defended position rather than a takeaway.'],
  walkthrough: ['Write an actual ordered process, not an explanatory essay about the process.', 'Keep setup minimal and make the last meaningful step the ending.', 'Do not add a recap, lesson, or positive-outcome paragraph after the steps.'],
  reflective: ['For this draft, use observation followed by implication only.', 'Do not add a scenario, recommendation, action step, lesson, or CTA.', 'End on the implication without summarizing it.'],
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
  return `SELECTED EXPRESSION MODE: ${mode.toUpperCase()}. This is the highest authority for rhetorical presentation. Follow this contract even when generic LinkedIn-writing habits suggest adding setup, examples, advice, benefits, or a conclusion.\n${MODE_RULES[mode].map((rule) => `- ${rule}`).join('\n')}\nEXECUTION REQUIREMENTS FOR THIS DRAFT:\n${MODE_EXECUTION_GUARDS[mode].map((rule) => `- ${rule}`).join('\n')}\nA complete post may use only 2 or 3 rhetorical moves when they provide enough substance to satisfy the applicable generation contract. Then stop.`;
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
The fixed CENTRAL CLAIM controls the argument; this mode controls its rhetorical movement and stopping behavior.
${MODE_RULES[mode].map((rule) => `- ${rule}`).join('\n')}
- Keep the author's identity stable. Saved style: ${(strategy?.writingStyle.tone ?? []).join(', ') || 'supplied author tone'}; ${strategy?.writingStyle.formality ?? 'balanced'} formality; ${strategy?.writingStyle.postLength ?? 'medium'} preferred length.
- Use only the rhetorical moves the claim needs. Examples, scenarios, advice, questions, and conclusions are optional.
- A complete post may use only 2 or 3 rhetorical moves when that is enough.

RECENT RHETORICAL FINGERPRINTS (full post bodies omitted):
${recent || '(No recent posts available.)'}
- Avoid repeating the same opening, structure, evidence placement, list usage, cadence, or closing type. Change the thought ordering, not merely synonyms.`;
}
