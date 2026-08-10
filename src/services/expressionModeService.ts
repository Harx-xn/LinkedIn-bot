import type { EffectiveBotStrategy, WritingStyle } from './botStrategyService';
import type { ExpressionMode, PostAngle } from './generationTypes';

export const RECENT_STYLE_POST_LIMIT = 5;

const MODES: ExpressionMode[] = ['direct', 'analytical', 'diagnostic', 'conversational', 'opinionated', 'walkthrough', 'reflective'];

const MODE_RULES: Record<ExpressionMode, string[]> = {
  direct: ['Preferred movement: CLAIM -> SUPPORT -> STOP.', 'State the point immediately; no topic overview is required.', 'Use only the support needed to make the claim credible.', 'Optional moves: one compact example or one correction, only when necessary.', 'Avoid by default: scenarios, consequence sections, recommendations, summaries, motivational endings, CTAs, and rhetorical questions.', 'Use short or medium declarative sentences, minimal transitions, and either compact paragraphs or selective standalone lines.', 'Stopping condition: once the claim has concrete support, end the post. Do not manufacture a conclusion.'],
  analytical: ['Preferred movement: OBSERVATION OR CLAIM -> CAUSAL REASONING -> IMPLICATION OR CONDITION.', 'Explain why one relationship occurs; use denser reasoning where useful.', 'Optional moves: an integrated example, qualification, or recommendation.', 'Avoid by default: checklists and an automatic pivot from analysis into advice, benefits, and takeaway.', 'Stopping condition: end when the causal relationship and its implication are clear.'],
  diagnostic: ['Preferred movement: OBSERVABLE PROBLEM -> INVESTIGATION -> UNDERLYING CAUSE -> RESPONSE OR DECISION.', 'Begin with a concrete symptom and trace it toward the root cause.', 'Optional moves: a directly stated scenario or one corrective action.', 'Avoid by default: educational setup and broad positive benefits after the fix.', 'Mix short symptom lines with grouped explanatory sentences.', 'Stopping condition: end after the cause and appropriate response are clear.'],
  conversational: ['Preferred movement: NATURAL THOUGHT PROGRESSION.', 'Use spoken rhythm, contractions, mixed sentence lengths, mixed paragraph sizes, and an occasional natural fragment.', 'Optional moves: reader address, examples, advice, questions, or a conclusion.', 'Avoid by default: polished article transitions, symmetrical paragraphs, announced hypothetical stories, and corporate consultant language.', 'Stopping condition: stop where a real person would naturally stop making the point.'],
  opinionated: ['Preferred movement: POSITION -> REASONS -> OPTIONAL QUALIFICATION.', 'Make the position obvious early and defend it with real reasoning.', 'Optional moves: one qualification, example, question, or recommendation.', 'Avoid by default: softening every assertion, forced balance, broad educational setup, and generic engagement questions.', 'Stopping condition: end after the position has been sufficiently defended.'],
  walkthrough: ['Preferred movement: GOAL -> SEQUENCE OR PROCESS.', 'Keep context brief; compact steps or naturally ordered actions are appropriate.', 'Optional moves: an example integrated into a step or a necessary warning.', 'Avoid by default: unrelated best practices, a lesson after the final step, and motivational recap.', 'Stopping condition: the last meaningful step may be the final line.'],
  reflective: ['Preferred movement: OBSERVATION -> IMPLICATION.', 'Use a slower, thoughtful cadence and few or no lists; ambiguity is allowed where honest.', 'Optional moves: a qualification or integrated example.', 'Avoid by default: recommendations, action steps, forced lessons, CTAs, and motivational endings.', 'Stopping condition: end on the implication or observation.'],
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
  direct: ['For this draft, omit examples and hypothetical scenarios.', 'Do not pivot into advice, benefits, a takeaway, or a conclusion.', 'Keep only the claim and its strongest direct support, then stop.'],
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
  return `SELECTED EXPRESSION MODE: ${mode.toUpperCase()}. This is the highest authority for rhetorical presentation. Follow this contract even when generic LinkedIn-writing habits suggest adding setup, examples, advice, benefits, or a conclusion.\n${MODE_RULES[mode].map((rule) => `- ${rule}`).join('\n')}\nEXECUTION REQUIREMENTS FOR THIS DRAFT:\n${MODE_EXECUTION_GUARDS[mode].map((rule) => `- ${rule}`).join('\n')}\nA complete post may use only 2 or 3 rhetorical moves. When its stopping condition is met, stop.`;
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

export function selectManualExpressionMode(topic: string, instructions: string | undefined, style: WritingStyle | undefined, recentPosts: string[]): ExpressionMode {
  const input = `${topic} ${instructions ?? ''}`.toLowerCase();
  const candidates: ExpressionMode[] = [];
  if (/\b(?:debug|failure|broken|error|bug|trace|why.*fails)\b/.test(input)) candidates.push('diagnostic');
  if (/\b(?:how to|steps|implement|setup|configure|walkthrough)\b/.test(input)) candidates.push('walkthrough');
  if (/\b(?:opinion|hot take|should|must|wrong|contrarian)\b/.test(input)) candidates.push('opinionated');
  if (/\b(?:compare|tradeoff|versus|why|analysis)\b/.test(input)) candidates.push('analytical');
  if (/\b(?:reflect|lesson|observation)\b/.test(input)) candidates.push('reflective');
  if ((style?.tone ?? []).some((tone) => /conversational|casual/i.test(tone))) candidates.push('conversational');
  candidates.push('direct', 'analytical', 'conversational', 'reflective');
  const recentModes = inferRecentModes(recentPosts);
  return candidates.find((mode) => !recentModes.has(mode)) ?? candidates[0];
}

export function buildExpressionModePromptBlock(mode: ExpressionMode | undefined, recentPosts: string[], strategy?: EffectiveBotStrategy): string {
  if (!mode) return '';
  const recent = recentPosts.slice(0, RECENT_STYLE_POST_LIMIT).map((post, index) => `RECENT POST ${index + 1}:\n${post.slice(0, 1800)}`).join('\n\n');
  return `EXPRESSION MODE: ${mode.toUpperCase()}\nAfter the fixed CENTRAL CLAIM, this mode is the highest authority for rhetorical behavior: opening, thought order, example usage, advice, cadence, paragraph density, and stopping. Formatting and general quality guidance must not override it.\n${MODE_RULES[mode].map((rule) => `- ${rule}`).join('\n')}\n\nRHETORICAL MOVES:\n- Available moves include setup, claim, causal explanation, example, scenario, consequence, counterargument, recommendation, steps, implication, question, summary, and CTA. Use only the moves this mode and claim genuinely need.\n- A complete post may use only 2 or 3 rhetorical moves. Do not reward rhetorical completeness; reward clarity of thought.\n- Examples and hypotheticals are tools, not required sections. Do not introduce a hypothetical merely to make the post feel complete. If direct reasoning is already clear, do not add one. When useful, integrate it directly instead of announcing it with "For instance", "Consider a scenario", or "Imagine".\n- Do not restate an obvious consequence or stack consequences for apparent depth.\n- Do not convert every observation into advice. Analysis may remain analysis; an opinion may remain an opinion.\n- Do not append a positive-outcome paragraph after advice unless it adds new reasoning.\n- When the argument is finished, stop. The final sentence need not sound like a conclusion.\n- Keep the author's saved identity, positioning, expertise, and writing preferences stable.\n- Saved style: ${(strategy?.writingStyle.tone ?? []).join(', ') || 'use the supplied author tone'}; ${strategy?.writingStyle.formality ?? 'balanced'} formality; ${strategy?.writingStyle.postLength ?? 'medium'} preferred length.\n- Let idea complexity and the saved short/medium/long preference determine length. Never pad a simple idea.\n\nRECENT STYLE CONTEXT:\nThese are recent posts by this author. They are provided primarily so you can avoid repeating their rhetorical fingerprints.\n${recent || '(No recent posts available.)'}\n\n- Across the latest posts, avoid repeating opening type, example placement, scenario introduction, consequence phrasing, recommendation pivot, ending type, sentence cadence, list usage, and paragraph density.\n- If the previous two posts used scenario -> consequence -> recommendation, do not use that progression unless the claim truly requires it.\n- Do not solve repetition by substituting synonyms. Pairs such as crucial/essential/vital, lead to/result in/cause, or for instance/for example/consider/imagine are the same construction. Change sentence construction, thought ordering, paragraph function, or rhetorical move.\n- Repetition-sensitive phrases include: "It's crucial to", "It's essential to", "This can lead to", "This can result in", "This often leads to", "By implementing", "To mitigate", "For instance", "For example", "Consider", "Imagine", "Moreover", "Ultimately", "Remember", "In essence", "In summary", "The key is", "This approach", "This not only", and "Prioritizing". Use them only when genuinely natural, never as stock transitions or endings.\n- Prefer a complete idea over a target character count.`;
}
