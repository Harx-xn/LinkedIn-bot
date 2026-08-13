import type { AuthorContext } from '../generationTypes';
import { buildAuthorBlock } from '../ghostwriterPrompts';
import type { ManualVoiceContext } from './manualVoiceProfileService';
import { buildManualVoiceContextBlocks } from './manualVoicePromptBlocks';
import type { ManualPostFingerprintRecord } from './manualPostFingerprintService';
import { buildManualFingerprintContextBlock } from './manualPostFingerprintPrompts';
import type { ExpressionMode } from '../generationTypes';
import type { ManualGeneratedPost, SelectedManualPlan } from './manualPostTypes';
import { buildExpressionModePromptBlock } from '../expressionModeService';

/** Manual-composer system instructions — isolated from batch GHOSTWRITER_SYSTEM usage in planned-post prompts. */
export const MANUAL_COMPOSER_SYSTEM = `You are a LinkedIn composer assistant for the manual post editor.

Write for the supplied author profile. The user provides a topic or rewrite instructions.
Do not invent statistics, customers, incidents, revenue, costs, timelines, quotes, regulatory outcomes, or personal experiences unless explicitly supplied in the author profile or user-provided supporting context.

Priority order:
1. Author credibility and supplied profile
2. User topic, supporting context, or rewrite suggestions
3. Practical, credible technical insight`;

export const MANUAL_QUALITY_RULES = `Quality requirements:
- One central argument for a clear target audience; a separate hook is optional when the Expression Mode starts directly with the claim.
- Develop the idea with a useful explanation. Include consequences only when relevant.
- Let the post finish naturally when the idea is complete; a separate closing line, takeaway, or CTA is optional.
- Do not add a forced engagement question unless the user explicitly requests one.
- Without supplied personal evidence, rely on sound technical reasoning or a reasoned observation. Use a technical example or labeled hypothetical only when it materially helps.
- Never imply the author personally experienced something unless the author profile or supporting context supports it.
- No invented metrics, clients, incidents, revenue, costs, timelines, quotes, or regulatory outcomes.
- Avoid generic AI phrasing and filler transitions.
- Maximum three relevant hashtags.
- Respect the saved short/medium/long preference and topic complexity. Complete the idea without padding.
- Do not use Markdown bold markers or double asterisks. Do not include ** anywhere.
- Target approximately 1,800–2,500 characters. The completed post should normally contain at least 1,600 characters and must remain below 3,000 characters.
- Use additional length only for useful reasoning, examples, specificity, contrast, practical implications, or narrative development. Never pad with repetition, filler, redundant conclusions, or generic advice.`;

export const MANUAL_OUTPUT_SCHEMA_RULES = `Output MUST be valid JSON with this exact shape:
{
  "contentPlan": {
    "angle": "string",
    "coreClaim": "string",
    "audience": "string",
    "structure": "string",
    "hookType": "string",
    "evidenceType": "technical_example | reasoned_observation | labeled_hypothetical | supplied_experience",
    "ctaType": "takeaway | implication | none"
  },
  "hook": "opening hook lines",
  "body": "main argument and explanation",
  "closingLine": "optional closing line; use an empty string when the body already ends naturally",
  "hashtags": ["#Tag1", "#Tag2"],
  "sourceTopic": "topic string"
}`;

export const EDITORIAL_AUTHORITY = `EDITORIAL AUTHORITY — FINAL:
Develop a thought instead of exhausting a topic.
Once an idea has been established, do not explain it again in different words.
Prefer observation -> interpretation over observation -> another observation -> another observation.
Every major paragraph must introduce a materially new proposition or perform a new argumentative function: claim, observation, evidence, cause, mechanism, interpretation, consequence, contrast, qualification, application, supported personal shift, or resolution.
If a paragraph performs essentially the same job as an earlier paragraph, do not write it.
Depth comes from interpretation, not from the number of points covered.
The selected Expression Mode and explicit user controls remain authoritative. Listicles, checklists, how-to posts, and Walkthrough mode may enumerate intentionally.
Prefer a declarative claim, specific observation, pattern, mechanism insight, or counterintuitive statement over a generic question unless the user's voice or requested structure makes a question stronger.
End by sharpening, reframing, resolving, exposing a tension, or stopping. Do not restate the opening thesis or append generic advice.`;

export const MANUAL_GENERATION_CONTRACT = `GENERATION CONTRACT - HARD POSTCONDITION:
- A normal AI-generated post must contain at least 1,600 and at most 3,000 visible characters; aim for 1,800-2,500.
- Achieve the range through the strongest planned substance: concrete manifestations, cause/mechanism, interpretation, consequence, or a useful qualification.
- Do not pad, repeat the thesis, manufacture evidence, or add rhetorical moves unrelated to the approved Depth Plan.
- Expression Mode controls presentation and concision, but its stopping condition applies only after this generation contract is satisfied.`;

export const PARAGRAPH_PROGRESSION_RULES = EDITORIAL_AUTHORITY;

export const MANUAL_REWRITE_SCOPE_RULES = `Rewrite scope rules:
- Follow USER SUGGESTIONS narrowly. Change only what the suggestion requires.
- "Make it shorter" / "shorter": preserve the same angle, facts, and claims; compress wording only.
- "Add a stronger hook": strengthen opening lines only; preserve the body unless a tiny edit is needed for coherence.
- "Make it less formal": adjust voice/register only; do not invent new experience or facts.
- Do not add engagement questions unless the suggestion explicitly requests one.
- Do not invent unverifiable facts, metrics, clients, incidents, or unsupported first-person claims.
- Contact/website lines are controlled by app settings; do not add or preserve them unless suggestions explicitly ask.`;

function buildSupportingContextBlock(supportingContext?: string): string {
  if (!supportingContext?.trim()) return '';
  return `
User-supplied supporting context (factual or experiential — treat as allowed evidence only when explicitly stated):
${supportingContext.trim()}

Evidence rules with supporting context:
- You may reference supplied context as author evidence when it clearly supports a claim.
- Do not embellish, extrapolate, or imply additional personal experience beyond what was supplied.
- If context is absent or insufficient, use technical examples, reasoned observations, or labeled hypotheticals instead.`;
}

function buildEvidenceRulesBlock(hasSupportingContext: boolean): string {
  if (hasSupportingContext) {
    return `- Use supplied supporting context only for claims it explicitly supports.
- Do not imply broader personal experience than the context provides.`;
  }
  return `- No personal experience claims ("I", "my team", "we built", "last year I") unless present in the author profile.
- Prefer sound technical reasoning or a reasoned observation. Use an example or labeled hypothetical only when it materially improves clarity, and integrate it naturally.`;
}

export function buildManualPostPromptV2(input: {
  topic: string;
  additionalInstructions?: string;
  supportingContext?: string;
  author: AuthorContext;
  voiceContext?: ManualVoiceContext;
}): string {
  const extraInstructions = input.additionalInstructions?.trim()
    ? `\nAdditional user instructions:\n${input.additionalInstructions.trim()}`
    : '';
  const supportingBlock = buildSupportingContextBlock(input.supportingContext);
  const evidenceRules = buildEvidenceRulesBlock(!!input.supportingContext?.trim());

  const voiceBlocks = buildManualVoiceContextBlocks(input.voiceContext);

  return `${MANUAL_COMPOSER_SYSTEM}
${buildAuthorBlock(input.author, { includeQualityContext: false })}
${voiceBlocks}
Write an original LinkedIn post for the manual composer based on this topic or instruction:
${input.topic.trim()}
${extraInstructions}
${supportingBlock}

${MANUAL_QUALITY_RULES}

Evidence rules:
${evidenceRules}

${MANUAL_OUTPUT_SCHEMA_RULES}`;
}

export function buildManualRewritePromptV2(input: {
  currentContent: string;
  suggestions: string;
  author: AuthorContext;
  voiceContext?: ManualVoiceContext;
}): string {
  const voiceBlocks = buildManualVoiceContextBlocks(input.voiceContext);

  return `${MANUAL_COMPOSER_SYSTEM}
${buildAuthorBlock(input.author, { includeQualityContext: false })}
${voiceBlocks}
CURRENT POST:
${input.currentContent}

USER SUGGESTIONS:
${input.suggestions || 'Improve clarity, specificity, and technical accuracy while keeping the same topic.'}

${MANUAL_REWRITE_SCOPE_RULES}

${MANUAL_QUALITY_RULES}

${MANUAL_OUTPUT_SCHEMA_RULES}`;
}

export const MANUAL_PLANNING_OUTPUT_SCHEMA = `Output MUST be valid JSON with this exact shape:
{
  "angles": [
    {
      "title": "string",
      "coreClaim": "string",
      "audience": "string",
      "structure": "string",
      "evidenceMode": "technical_example | reasoned_observation | labeled_hypothetical | supplied_experience",
      "specificity": 8,
      "novelty": 8,
      "audienceFit": 8,
      "voiceFit": 7,
      "evidenceAvailability": 8,
      "hookCandidates": [
        {
          "text": "string",
          "type": "SPECIFIC_WARNING | CONTRARIAN_CLAIM | CONCRETE_OBSERVATION | MECHANISM_INSIGHT",
          "specificity": 9,
          "curiosity": 7,
          "topicRelevance": 9,
          "clarity": 9,
          "voiceFit": 8
        }
      ],
      "depthPlan": {
        "centralClaim": "string",
        "whyThisClaimIsInteresting": "string or null",
        "strongestObservations": ["maximum three concrete manifestations"],
        "underlyingCauseOrMechanism": "string or null",
        "deeperInterpretation": "one useful non-obvious interpretation or null",
        "meaningfulConsequence": "string or null",
        "usefulTensionOrQualification": "string or null",
        "personalPerspective": { "supported": false, "insight": null },
        "endingInsight": "string or null",
        "avoidIdeas": ["obvious or redundant propositions not worth repeating"]
      }
    }
  ]
}`;

export const MANUAL_DRAFT_OUTPUT_SCHEMA = MANUAL_OUTPUT_SCHEMA_RULES;

export const MANUAL_CRITIC_OUTPUT_SCHEMA = `Output MUST be valid JSON with this exact shape:
{
  "scores": {
    "hook": 8,
    "specificity": 8,
    "voiceMatch": 7,
    "focus": 9,
    "credibility": 9,
    "originality": 7,
    "audienceFit": 8,
    "conversationPotential": 8,
    "dwellQuality": 8,
    "readability": 8,
    "argumentProgression": 8,
    "semanticRedundancy": 1,
    "centralClaimClarity": 9,
    "depthInterpretation": 8,
    "structuralFit": 9,
    "endingQuality": 8,
    "nicheNaturalness": 9,
    "lengthFit": 8,
    "genericAiRisk": 2
  },
  "issues": ["string"],
  "decision": "PASS",
  "revised": {
    "hook": "optional revised hook",
    "body": "optional revised body",
    "closingLine": "optional revised closing line"
  }
}`;

export function buildManualPlanningPrompt(input: {
  topic: string;
  additionalInstructions?: string;
  supportingContext?: string;
  author: AuthorContext;
  voiceContext?: ManualVoiceContext;
  recentFingerprints?: ManualPostFingerprintRecord[];
  planningRetryIssues?: string[];
}): string {
  const extraInstructions = input.additionalInstructions?.trim()
    ? `\nAdditional user instructions:\n${input.additionalInstructions.trim()}`
    : '';
  const supportingBlock = buildSupportingContextBlock(input.supportingContext);
  const evidenceRules = buildEvidenceRulesBlock(!!input.supportingContext?.trim());

  const voiceBlocks = buildManualVoiceContextBlocks(input.voiceContext);
  const fingerprintBlocks = buildManualFingerprintContextBlock(input.recentFingerprints ?? []);
  const retryBlock = input.planningRetryIssues?.length
    ? `\nPLANNING RETRY — repair these deterministic failures:\n${input.planningRetryIssues.map((issue) => `- ${issue}`).join('\n')}\nReturn a materially deeper plan; do not paraphrase the rejected fields.`
    : '';

  return `${MANUAL_COMPOSER_SYSTEM}
${buildAuthorBlock(input.author, { includeQualityContext: false })}
${voiceBlocks}
${fingerprintBlocks}

Plan 3-5 distinct LinkedIn post angles for this manual-composer topic:
${input.topic.trim()}
${extraInstructions}
${supportingBlock}
${retryBlock}

Planning rules:
- Generate 3-5 candidate angles internally in the JSON output.
- Each angle must contain one central claim, audience, a concise reasoning direction in the structure field, evidenceMode, numeric planning scores, and 2-3 optional hookCandidates.
- The selected Expression Mode will own final rhetorical structure; do not prescribe the same hook/problem/example/advice/closing sequence for every angle.
- Explicit Direction, Format, Tone, Angle, and Structure instructions take precedence over the default editorial bias. Treat broad labels such as "hook -> body -> close" and "three-part insight" as framing preferences, not mandatory equal-sized paragraph templates.
- Reject vague hooks such as "One overlooked detail...", "In today's rapidly evolving landscape...", "Many businesses struggle with...", "Have you ever wondered...", "In the world of...", "This one thing can change everything...".
- Do not mix unrelated concepts.
- Do not propose angles that require invented stories or unsupported facts.
- Do not merely restate the topic without a viewpoint.
- Treat the input as a topic unless it already states a specific claim. Preserve an already-specific claim; otherwise narrow it before drafting.
- Every coreClaim must assert one debatable relationship, condition, mechanism, trade-off, or decision. Reject claims that only say the topic is important, improves performance, drives success, reduces risk, or increases efficiency.
- Build a compact Depth Plan for every angle before drafting. Its key question is: "What do these observations reveal that is not already obvious from the topic?"
- Choose only useful dimensions. Distinguish OBSERVATION (what happens), CAUSE (why), INTERPRETATION (what it reveals), CONSEQUENCE (why it matters), and PERSONAL SHIFT (a supported change in thinking or approach).
- Prefer the strongest two or three observations, then interpret them. Do not enumerate every plausible reason, benefit, risk, or recommendation.
- Attempt one useful interpretation beyond surface advice when the topic supports it. Never manufacture fake profundity.
- Populate only dimensions that genuinely deepen the claim. Record obvious restatements and generic recommendations in avoidIdeas.
- Set personalPerspective.supported to true only when the author profile, writing samples, or supporting context directly supports the insight. Otherwise use false and null.
- Use the author profile, target audience, niche strategy, and supplied context to choose what to narrow. This rule is domain-agnostic: do not assume the subject is software or force technical vocabulary.

Evidence rules:
${evidenceRules}

Do not write the final post body yet. Planning only.

${MANUAL_PLANNING_OUTPUT_SCHEMA}`;
}

export function buildManualDraftPrompt(input: {
  topic: string;
  additionalInstructions?: string;
  supportingContext?: string;
  author: AuthorContext;
  voiceContext?: ManualVoiceContext;
  expressionMode?: ExpressionMode;
  recentPosts?: string[];
  selectedPlan: SelectedManualPlan;
}): string {
  const extraInstructions = input.additionalInstructions?.trim()
    ? `\nAdditional user instructions:\n${input.additionalInstructions.trim()}`
    : '';
  const supportingBlock = buildSupportingContextBlock(input.supportingContext);
  const evidenceRules = buildEvidenceRulesBlock(!!input.supportingContext?.trim());
  const hookInstruction = input.selectedPlan.hook.trim()
    ? `Use this selected hook exactly unless a tiny coherence edit is required:\n${input.selectedPlan.hook.trim()}`
    : 'No hook was selected. Do not invent a hook wrapper. Return hook: "" and let the body begin directly in the form required by the Expression Mode.';

  const voiceBlocks = buildManualVoiceContextBlocks(input.voiceContext);
  const diversityBlock = buildExpressionModePromptBlock(input.expressionMode, input.recentPosts ?? [], input.author.strategy);

  return `${MANUAL_COMPOSER_SYSTEM}
${buildAuthorBlock(input.author, { includeQualityContext: false })}
${voiceBlocks}
Write the LinkedIn post draft using the selected Expression Mode as the authority for rhetorical structure and paragraph rhythm.
Do not choose a different angle or CENTRAL CLAIM.

Topic:
${input.topic.trim()}
${extraInstructions}
${supportingBlock}

Selected plan:
- Angle title: ${input.selectedPlan.title}
- CENTRAL CLAIM (fixed): ${input.selectedPlan.coreClaim}
- Audience: ${input.selectedPlan.audience}
- Planning direction (not a mandatory section sequence): ${input.selectedPlan.structure}
- Evidence mode: ${input.selectedPlan.evidenceMode}
- Hook type: ${input.selectedPlan.selectedHookType}

DEPTH PLAN — intellectual backbone, not a mandatory section template:
- Why interesting: ${input.selectedPlan.depthPlan.whyThisClaimIsInteresting ?? '(not needed)'}
- Strongest observations (maximum three): ${input.selectedPlan.depthPlan.strongestObservations.join(' | ') || '(none planned)'}
- Cause/mechanism: ${input.selectedPlan.depthPlan.underlyingCauseOrMechanism ?? '(not needed)'}
- Deeper interpretation: ${input.selectedPlan.depthPlan.deeperInterpretation ?? '(not needed)'}
- Consequence: ${input.selectedPlan.depthPlan.meaningfulConsequence ?? '(not needed)'}
- Tension/qualification: ${input.selectedPlan.depthPlan.usefulTensionOrQualification ?? '(not needed)'}
- Supported personal shift: ${input.selectedPlan.depthPlan.personalPerspective.supported ? input.selectedPlan.depthPlan.personalPerspective.insight : '(not supported; do not invent first-person experience)'}
- Ending insight: ${input.selectedPlan.depthPlan.endingInsight ?? '(natural stop is allowed)'}
- Avoid repeating: ${input.selectedPlan.depthPlan.avoidIdeas.join(' | ') || '(none listed)'}

${hookInstruction}

Drafting rules:
- Preserve the selected CENTRAL CLAIM and evidence mode. Do not broaden, substitute, or add a second thesis.
- Follow the Expression Mode's structure even when the planning direction or hook hint suggests a more conventional essay shape.
- Do not invent personal experience, metrics, clients, incidents, or timelines.
- Do not add a forced engagement question unless the user explicitly requested one.
- Turn the approved Depth Plan into prose; do not redesign the argument or add adjacent dimensions merely to appear comprehensive.
- Separate evidence from interpretation. Group related symptoms together, then use the next paragraph for cause, interpretation, or consequence rather than another symptom list.
- Direct mode means no unnecessary rhetorical moves. It does not waive the normal 1,600-character generation minimum; develop the few strongest planned moves with enough substance to satisfy it.

Evidence rules:
${evidenceRules}

${MANUAL_QUALITY_RULES}

FINAL RHETORICAL AUTHORITY:
The CENTRAL CLAIM above controls what the post argues. The following Expression Mode contract controls how the thought unfolds. It overrides generic suggestions about explanation, evidence, value, readability, hooks, or completeness when those suggestions would add rhetorical moves the mode does not need. It does not override the hard generation-length contract below.
${diversityBlock}

${EDITORIAL_AUTHORITY}

${MANUAL_GENERATION_CONTRACT}

${MANUAL_DRAFT_OUTPUT_SCHEMA}`;
}

export function buildManualTargetedRepairPrompt(input: {
  topic: string;
  author: AuthorContext;
  voiceContext?: ManualVoiceContext;
  expressionMode?: ExpressionMode;
  selectedPlan: SelectedManualPlan;
  draft: ManualGeneratedPost;
  detectedIssues: string[];
  missingPlanDimension?: string | null;
  currentLength?: number;
  usedDepthDimensions?: string[];
  unusedDepthDimensions?: Array<{ label: string; value: string }>;
  finalRecovery?: boolean;
}): string {
  const voiceBlock = buildManualVoiceContextBlocks(input.voiceContext);
  const modeBlock = buildExpressionModePromptBlock(input.expressionMode, [], input.author.strategy);
  const missingDimension = input.missingPlanDimension
    ? `The post is below the minimum length. Develop the planned ${input.missingPlanDimension}; do not add an unrelated cause, example, list, or summary.`
    : '';
  const isShort = input.detectedIssues.includes('POST_BELOW_MINIMUM_LENGTH');
  const hasStagnation = input.detectedIssues.includes('POSSIBLE_SEMANTIC_STAGNATION')
    || input.detectedIssues.includes('THESIS_RESTATEMENT')
    || input.detectedIssues.includes('ENUMERATION_WITHOUT_INTERPRETATION');
  const jointObjective = [
    isShort
      ? `- Expand the complete visible post from ${input.currentLength ?? 'its current length'} to 1,600-3,000 characters. This is a hard acceptance condition.`
      : '',
    isShort && hasStagnation
      ? '- Replace repetitive reasoning with one or two unused Depth Plan dimensions AND expand the post above 1,600 characters. Satisfy both objectives jointly; do not solve repetition by merely deleting text.'
      : '',
    '- Resolve every detected issue below in the same candidate. A candidate that misses any requested objective will be rejected.',
  ].filter(Boolean).join('\n');
  const usageBlock = `Current draft uses these planned roles:
${input.usedDepthDimensions?.length ? input.usedDepthDimensions.map((label) => `- ${label}`).join('\n') : '- no planned role was confidently detected'}

Unused valuable Depth Plan dimensions:
${input.unusedDepthDimensions?.length
    ? input.unusedDepthDimensions.map((item) => `- ${item.label}: ${item.value}`).join('\n')
    : '- none confidently identified; deepen an existing planned role without restating it'}`;
  const taskLabel = input.finalRecovery
    ? 'FINAL BOUNDED RECOVERY: the previous repair did not satisfy its postconditions.'
    : 'Repair this draft once, using only the deterministic issues listed below.';
  return `${MANUAL_COMPOSER_SYSTEM}
${buildAuthorBlock(input.author, { includeQualityContext: false })}
${voiceBlock}
${taskLabel} Return the repaired post directly.

Topic: ${input.topic.trim()}
CENTRAL CLAIM (fixed): ${input.selectedPlan.coreClaim}
Expression Mode: ${input.expressionMode ?? 'selected default'}
Depth Plan:
- central claim: ${input.selectedPlan.depthPlan.centralClaim}
- observations: ${input.selectedPlan.depthPlan.strongestObservations.join(' | ') || '(none)'}
- cause/mechanism: ${input.selectedPlan.depthPlan.underlyingCauseOrMechanism ?? '(none)'}
- interpretation: ${input.selectedPlan.depthPlan.deeperInterpretation ?? '(none)'}
- consequence: ${input.selectedPlan.depthPlan.meaningfulConsequence ?? '(none)'}
- qualification: ${input.selectedPlan.depthPlan.usefulTensionOrQualification ?? '(none)'}
- ending insight: ${input.selectedPlan.depthPlan.endingInsight ?? '(natural stop)'}
- avoid ideas: ${input.selectedPlan.depthPlan.avoidIdeas.join(' | ') || '(none)'}

${usageBlock}

DETECTED ISSUES:
${input.detectedIssues.map((issue) => `- ${issue}`).join('\n')}
${missingDimension}

JOINT REPAIR OBJECTIVE:
${jointObjective}

CURRENT DRAFT:
Hook: ${input.draft.hook}
Body: ${input.draft.body}
Closing: ${input.draft.closingLine}
Hashtags: ${input.draft.hashtags.join(' ')}

Repair only these problems. Preserve the central claim, strongest material, credible facts, voice, and mode-shaped structure. Replace redundant or shallow paragraphs with the planned interpretation or missing dimension where needed. Do not rewrite the post unnecessarily or invent facts or experience.

${modeBlock}

${EDITORIAL_AUTHORITY}

${MANUAL_GENERATION_CONTRACT}

${MANUAL_DRAFT_OUTPUT_SCHEMA}`;
}

export function buildManualCriticAndRevisionPrompt(input: {
  topic: string;
  author: AuthorContext;
  voiceContext?: ManualVoiceContext;
  expressionMode?: ExpressionMode;
  recentPosts?: string[];
  selectedPlan: SelectedManualPlan;
  draft: {
    hook: string;
    body: string;
    closingLine: string;
    hashtags: string[];
  };
  deterministicIssues: string[];
}): string {
  const voiceBlocks = buildManualVoiceContextBlocks(input.voiceContext);
  const diversityBlock = buildExpressionModePromptBlock(input.expressionMode, input.recentPosts ?? [], input.author.strategy);

  return `${MANUAL_COMPOSER_SYSTEM}
${buildAuthorBlock(input.author, { includeQualityContext: false })}
${voiceBlocks}
You are a critic and bounded editor for one manual LinkedIn draft. Preserve its Expression Mode-shaped structure and unusual successful choices.
Evaluate the draft against the fixed selected plan. You are not a general writing agent.

Topic: ${input.topic.trim()}

Fixed selected plan:
- Angle title: ${input.selectedPlan.title}
- CENTRAL CLAIM (fixed): ${input.selectedPlan.coreClaim}
- Audience: ${input.selectedPlan.audience}
- Planning direction: ${input.selectedPlan.structure}
- Evidence mode: ${input.selectedPlan.evidenceMode}
- Depth interpretation: ${input.selectedPlan.depthPlan.deeperInterpretation ?? '(none planned)'}
- Planned cause/mechanism: ${input.selectedPlan.depthPlan.underlyingCauseOrMechanism ?? '(none planned)'}
- Planned consequence: ${input.selectedPlan.depthPlan.meaningfulConsequence ?? '(none planned)'}
- Avoid ideas: ${input.selectedPlan.depthPlan.avoidIdeas.join(' | ') || '(none)'}
- Selected hook: ${input.selectedPlan.hook || input.draft.hook}

Draft to evaluate:
Hook:
${input.draft.hook}

Body:
${input.draft.body}

Closing line:
${input.draft.closingLine}

Hashtags:
${input.draft.hashtags.join(' ')}

Deterministic issues already detected:
${input.deterministicIssues.length ? input.deterministicIssues.map((issue) => `- ${issue}`).join('\n') : '- none'}

Critic rules:
- Score hook, specificity, voiceMatch, focus, credibility, originality, audienceFit, conversationPotential, dwellQuality, readability, centralClaimClarity, argumentProgression, semanticRedundancy, depthInterpretation, structuralFit, endingQuality, nicheNaturalness, lengthFit, and genericAiRisk (0-10).
- Treat argument progression and genuine interpretation as more important than landing inside the preferred 1,800–2,500 band. lengthFit should pass any coherent post inside the valid 1,600–3,000 range.
- Determine whether each major paragraph adds a new proposition or merely paraphrases an earlier paragraph.
- Flag a conclusion that restates the opening thesis, even when it uses different words.
- Detect material added only to satisfy length. Replace redundant paragraphs with a genuinely missing dimension rather than synonym-swapping or simple deletion.
- Flag SEMANTIC_REPETITION, ARGUMENT_STAGNATION, ENUMERATION_WITHOUT_INTERPRETATION, CONCLUSION_RESTATES_THESIS, FORCED_NICHE_PARAGRAPH, and GENERIC_RECOMMENDATION_ENDING when present.
- Use decision PASS when the draft is strong enough.
- Use decision REVISE only when a bounded rewrite is needed.
- If REVISE, return revised.hook/body/closingLine with targeted fixes only.
- Do not choose a new angle.
- Do not change the core claim.
- Do not add facts, personal experience, metrics, or a forced question.
- Do not change the evidence mode.
- Rewrite only failing sections unless a tiny coherence edit is required elsewhere.
- Fix only the identified issue. Preserve the rhetorical movement, cadence, paragraph grouping, and stopping behavior of the selected Expression Mode.
- Do not add an example, consequence, recommendation, takeaway, CTA, question, or separate closing merely to make the draft look more conventional.

FINAL REPAIR AUTHORITY:
Fix only the identified issue. The following contract overrides generic instincts to make the post more comprehensive, helpful, polished, or conclusive.
${diversityBlock}

${PARAGRAPH_PROGRESSION_RULES}

${MANUAL_CRITIC_OUTPUT_SCHEMA}`;
}

export function buildManualLengthRepairPrompt(input: {
  topic: string;
  additionalInstructions?: string;
  supportingContext?: string;
  author: AuthorContext;
  voiceContext?: ManualVoiceContext;
  expressionMode?: ExpressionMode;
  recentPosts?: string[];
  selectedPlan: SelectedManualPlan;
  draft: ManualGeneratedPost;
  repairInstruction: string;
}): string {
  const voiceBlocks = buildManualVoiceContextBlocks(input.voiceContext);
  const diversityBlock = buildExpressionModePromptBlock(input.expressionMode, input.recentPosts ?? [], input.author.strategy);
  return `${MANUAL_COMPOSER_SYSTEM}
${buildAuthorBlock(input.author, { includeQualityContext: false })}
${voiceBlocks}
Repair the length of this existing draft without changing its selected architecture.

ORIGINAL TOPIC:
${input.topic}

ADDITIONAL USER INSTRUCTIONS:
${input.additionalInstructions?.trim() || '(none)'}

SUPPORTING EVIDENCE/CONTEXT:
${input.supportingContext?.trim() || '(none supplied — do not invent facts or experience)'}

FIXED GENERATION PLAN:
- Angle: ${input.selectedPlan.title}
- CENTRAL CLAIM (fixed): ${input.selectedPlan.coreClaim}
- Audience: ${input.selectedPlan.audience}
- Planning direction: ${input.selectedPlan.structure}
- Evidence mode: ${input.selectedPlan.evidenceMode}
- Selected hook/opening: ${input.selectedPlan.hook || input.selectedPlan.selectedHookType}
- Why interesting: ${input.selectedPlan.depthPlan.whyThisClaimIsInteresting ?? '(not needed)'}
- Planned observations: ${input.selectedPlan.depthPlan.strongestObservations.join(' | ') || '(none)'}
- Cause/mechanism: ${input.selectedPlan.depthPlan.underlyingCauseOrMechanism ?? '(not planned)'}
- Interpretation: ${input.selectedPlan.depthPlan.deeperInterpretation ?? '(not planned)'}
- Consequence: ${input.selectedPlan.depthPlan.meaningfulConsequence ?? '(not planned)'}
- Tension/qualification: ${input.selectedPlan.depthPlan.usefulTensionOrQualification ?? '(not planned)'}
- Supported personal shift: ${input.selectedPlan.depthPlan.personalPerspective.supported ? input.selectedPlan.depthPlan.personalPerspective.insight : '(unsupported; do not invent)'}
- Ending insight: ${input.selectedPlan.depthPlan.endingInsight ?? '(natural stop allowed)'}
- Avoid ideas: ${input.selectedPlan.depthPlan.avoidIdeas.join(' | ') || '(none)'}

CURRENT DRAFT:
Hook:
${input.draft.hook}

Body:
${input.draft.body}

Closing:
${input.draft.closingLine}

LENGTH REPAIR:
${input.repairInstruction}

Use the Depth Plan above to identify which useful planned dimension is missing or underdeveloped. Do not invent an unrelated generic argument. Prefer an unused observation, cause, interpretation, consequence, qualification, or supported shift already present in the plan.

${PARAGRAPH_PROGRESSION_RULES}

EXPRESSION MODE — PRESERVE THIS ARCHITECTURE:
${diversityBlock}

Return the complete repaired post in the manual-post JSON schema.
${MANUAL_OUTPUT_SCHEMA_RULES}`;
}

export function buildManualTopicSuggestionPrompt(input: {
  voice: {
    tone: string;
    description: string;
    niches: string[];
    websiteUrl: string | null;
    contactInfo: string | null;
  };
  voiceContext?: ManualVoiceContext;
  trendSources: string[];
  count: number;
  currentYear: number;
}): string {
  const voiceBlocks = buildManualVoiceContextBlocks(input.voiceContext);
  const niches = input.voice.niches.filter(Boolean).join(', ') || 'none';
  const website = input.voice.websiteUrl?.trim() || 'not provided';
  const trendSources = input.trendSources.length > 0 ? input.trendSources.join(', ') : 'google';

  return `${MANUAL_COMPOSER_SYSTEM}

TASK:
You are generating topic ideas for LinkedIn posts, not blog articles or SEO headlines.
Return exactly ${input.count} timely, specific, non-generic post topics for this author.

CURRENT YEAR: ${input.currentYear}
- Do not mention ${input.currentYear - 1}, ${input.currentYear - 2}, ${input.currentYear - 3}, or any earlier year.
- Do not use stale years like 2023, 2022, or 2021.
- Only use ${input.currentYear} when a year is genuinely useful, and never use an outdated year.

USER PROFILE (authoritative — do not invent facts beyond this):
${input.voice.description.trim()}

TARGET NICHES:
${niches}

TONE / STYLE:
${input.voice.tone}

TREND SOURCES CONFIGURED:
${trendSources}

WEBSITE / COMPANY CONTEXT:
${website}

${voiceBlocks}

QUALITY RULES:
- Topics must be specific enough to write a strong LinkedIn post from immediately.
- Make them relevant to this user's expertise, niches, tone, and audience.
- Prefer contrarian, practical, problem-aware, experience-based, or trend-aware angles.
- Use trend sources as inspiration for timeliness, not as generic "AI/news" filler.
- Do not create generic LinkedIn growth clichés.
- Do not use vague words like "leveraging", "unlock", "game-changer", or "authentic connections" unless tied to a concrete angle.
- Do not create broad topics about "AI" unless the angle is concrete and tied to the user's profile.
- Do not invent metrics, customers, launches, or personal experiences not supported by the profile.
- Do not repeat similar angles.
- Titles must sound like post starting points, not blog SEO headlines.
- Each description must be one short sentence explaining the post angle/subtitle.

BAD EXAMPLES (never imitate these patterns):
- Leveraging AI for Effective Content Marketing
- Top Tools for LinkedIn Growth in 2023
- Creating Authentic Connections on LinkedIn
- Common Mistakes in AI Content Automation
- The Future of AI in Marketing
- Why LinkedIn Matters for Your Brand

BETTER EXAMPLES (match this specificity level):
- Why AI-written LinkedIn posts fail when the author voice is missing
- The hidden reason most SaaS content sounds the same
- How founders can turn one customer insight into five LinkedIn posts
- Why content automation needs guardrails, not just better prompts
- What LinkedIn creators should stop outsourcing to AI

OUTPUT:
Return valid JSON only with this exact shape:
{
  "topics": [
    {
      "title": "string",
      "description": "string"
    }
  ]
}

Return exactly ${input.count} topics in the topics array.`;
}
