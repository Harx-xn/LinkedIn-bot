import type { AuthorContext } from '../generationTypes';
import { buildAuthorBlock } from '../ghostwriterPrompts';
import type { ManualVoiceContext } from './manualVoiceProfileService';
import { buildManualVoiceContextBlocks } from './manualVoicePromptBlocks';
import type { ManualPostFingerprintRecord } from './manualPostFingerprintService';
import { buildManualFingerprintContextBlock } from './manualPostFingerprintPrompts';

/** Manual-composer system instructions — isolated from batch GHOSTWRITER_SYSTEM usage in planned-post prompts. */
export const MANUAL_COMPOSER_SYSTEM = `You are a LinkedIn composer assistant for the manual post editor.

Write for the supplied author profile. The user provides a topic or rewrite instructions.
Do not invent statistics, customers, incidents, revenue, costs, timelines, quotes, regulatory outcomes, or personal experiences unless explicitly supplied in the author profile or user-provided supporting context.

Priority order:
1. Author credibility and supplied profile
2. User topic, supporting context, or rewrite suggestions
3. Practical, credible technical insight`;

export const MANUAL_QUALITY_RULES = `Quality requirements:
- One central argument with a specific hook and clear target audience.
- Include a concrete consequence or useful explanation with logical progression.
- End with a strong closing line (takeaway, implication, or specific observation).
- Do not add a forced engagement question unless the user explicitly requests one.
- Without supplied personal evidence, use a technical example, reasoned observation, or clearly labeled hypothetical.
- Never imply the author personally experienced something unless the author profile or supporting context supports it.
- No invented metrics, clients, incidents, revenue, costs, timelines, quotes, or regulatory outcomes.
- Avoid generic AI phrasing and filler transitions.
- Maximum three relevant hashtags.
- Keep assembled post content within LinkedIn's 3,000-character limit.`;

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
  "closingLine": "strong closing line without forced question unless requested",
  "hashtags": ["#Tag1", "#Tag2"],
  "sourceTopic": "topic string"
}`;

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
- Prefer a technical example, reasoned observation, or clearly labeled hypothetical ("Consider a SaaS app where...").`;
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
${buildAuthorBlock(input.author)}
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
${buildAuthorBlock(input.author)}
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
      ]
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
    "readability": 8,
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
}): string {
  const extraInstructions = input.additionalInstructions?.trim()
    ? `\nAdditional user instructions:\n${input.additionalInstructions.trim()}`
    : '';
  const supportingBlock = buildSupportingContextBlock(input.supportingContext);
  const evidenceRules = buildEvidenceRulesBlock(!!input.supportingContext?.trim());

  const voiceBlocks = buildManualVoiceContextBlocks(input.voiceContext);
  const fingerprintBlocks = buildManualFingerprintContextBlock(input.recentFingerprints ?? []);

  return `${MANUAL_COMPOSER_SYSTEM}
${buildAuthorBlock(input.author)}
${voiceBlocks}
${fingerprintBlocks}

Plan 3-5 distinct LinkedIn post angles for this manual-composer topic:
${input.topic.trim()}
${extraInstructions}
${supportingBlock}

Planning rules:
- Generate 3-5 candidate angles internally in the JSON output.
- Each angle must contain one central claim, audience, structure, evidenceMode, numeric planning scores, and 2-3 hookCandidates.
- Reject vague hooks such as "One overlooked detail...", "In today's rapidly evolving landscape...", "Many businesses struggle with...", "Have you ever wondered...", "In the world of...", "This one thing can change everything...".
- Do not mix unrelated concepts.
- Do not propose angles that require invented stories or unsupported facts.
- Do not merely restate the topic without a viewpoint.

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
  selectedPlan: {
    title: string;
    coreClaim: string;
    audience: string;
    structure: string;
    evidenceMode: string;
    hook: string;
    selectedHookType: string;
  };
}): string {
  const extraInstructions = input.additionalInstructions?.trim()
    ? `\nAdditional user instructions:\n${input.additionalInstructions.trim()}`
    : '';
  const supportingBlock = buildSupportingContextBlock(input.supportingContext);
  const evidenceRules = buildEvidenceRulesBlock(!!input.supportingContext?.trim());
  const hookInstruction = input.selectedPlan.hook.trim()
    ? `Use this selected hook exactly unless a tiny coherence edit is required:\n${input.selectedPlan.hook.trim()}`
    : 'Create a specific hook aligned with the selected plan.';

  const voiceBlocks = buildManualVoiceContextBlocks(input.voiceContext);

  return `${MANUAL_COMPOSER_SYSTEM}
${buildAuthorBlock(input.author)}
${voiceBlocks}
Write the LinkedIn post draft for the manual composer using this fixed selected plan.
Do not choose a different angle or core claim.

Topic:
${input.topic.trim()}
${extraInstructions}
${supportingBlock}

Selected plan:
- Angle title: ${input.selectedPlan.title}
- Core claim: ${input.selectedPlan.coreClaim}
- Audience: ${input.selectedPlan.audience}
- Structure: ${input.selectedPlan.structure}
- Evidence mode: ${input.selectedPlan.evidenceMode}
- Hook type: ${input.selectedPlan.selectedHookType}

${hookInstruction}

Drafting rules:
- Preserve the selected core claim and evidence mode.
- Do not invent personal experience, metrics, clients, incidents, or timelines.
- Do not add a forced engagement question unless the user explicitly requested one.

Evidence rules:
${evidenceRules}

${MANUAL_QUALITY_RULES}

${MANUAL_DRAFT_OUTPUT_SCHEMA}`;
}

export function buildManualCriticAndRevisionPrompt(input: {
  topic: string;
  author: AuthorContext;
  voiceContext?: ManualVoiceContext;
  selectedPlan: {
    title: string;
    coreClaim: string;
    audience: string;
    structure: string;
    evidenceMode: string;
    hook: string;
  };
  draft: {
    hook: string;
    body: string;
    closingLine: string;
    hashtags: string[];
  };
  deterministicIssues: string[];
}): string {
  const voiceBlocks = buildManualVoiceContextBlocks(input.voiceContext);

  return `${MANUAL_COMPOSER_SYSTEM}
${buildAuthorBlock(input.author)}
${voiceBlocks}
You are a critic and bounded editor for one manual LinkedIn draft.
Evaluate the draft against the fixed selected plan. You are not a general writing agent.

Topic: ${input.topic.trim()}

Fixed selected plan:
- Angle title: ${input.selectedPlan.title}
- Core claim: ${input.selectedPlan.coreClaim}
- Audience: ${input.selectedPlan.audience}
- Structure: ${input.selectedPlan.structure}
- Evidence mode: ${input.selectedPlan.evidenceMode}
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
- Score hook, specificity, voiceMatch, focus, credibility, originality, readability, and genericAiRisk (0-10).
- Use decision PASS when the draft is strong enough.
- Use decision REVISE only when a bounded rewrite is needed.
- If REVISE, return revised.hook/body/closingLine with targeted fixes only.
- Do not choose a new angle.
- Do not change the core claim.
- Do not add facts, personal experience, metrics, or a forced question.
- Do not change the evidence mode.
- Rewrite only failing sections unless a tiny coherence edit is required elsewhere.

${MANUAL_CRITIC_OUTPUT_SCHEMA}`;
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
  count: number;
}): string {
  const voiceBlocks = buildManualVoiceContextBlocks(input.voiceContext);
  const niches = input.voice.niches.filter(Boolean).join(', ') || 'none';
  const website = input.voice.websiteUrl?.trim() || 'not provided';

  return `${MANUAL_COMPOSER_SYSTEM}

TASK:
Suggest ${input.count} concise LinkedIn post topic ideas for this author to write about manually.

AUTHOR PROFILE (authoritative — do not invent facts beyond this):
- Tone: ${input.voice.tone}
- Description: ${input.voice.description.trim()}
- Niches: ${niches}
- Website / company context: ${website}

${voiceBlocks}

TOPIC RULES:
- Make each topic specific to the saved author profile, niches, tone, and website context.
- Prefer practical, LinkedIn-ready angles a professional could post about credibly.
- Avoid generic AI slop, vague inspiration, or broad "thought leadership" with no angle.
- Do not invent company metrics, customers, launches, personal stories, or achievements not supported by the profile.
- Do not hallucinate user facts that are not present in the author profile or learned voice context.
- Each topic should be distinct and immediately usable as a manual-post prompt.
- Titles should be short and specific (under 120 characters).
- Descriptions should be one short sentence explaining the post angle.
- Reasons should briefly explain why the topic fits this author's botConfig/profile.

OUTPUT:
Return valid JSON only with this exact shape:
{
  "topics": [
    {
      "title": "string",
      "description": "string",
      "reason": "string"
    }
  ]
}

Return exactly ${input.count} topics in the topics array.`;
}
