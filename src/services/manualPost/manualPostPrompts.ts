import type { AuthorContext } from '../generationTypes';
import { buildAuthorBlock } from '../ghostwriterPrompts';
import type { ManualVoiceContext } from './manualVoiceProfileService';
import { buildManualVoiceContextBlocks } from './manualVoicePromptBlocks';
import type { ManualPostFingerprintRecord } from './manualPostFingerprintService';
import { buildManualFingerprintContextBlock } from './manualPostFingerprintPrompts';
import type { ExpressionMode } from '../generationTypes';
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
  "closingLine": "optional closing line; use an empty string when the body already ends naturally",
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
    "audienceFit": 8,
    "conversationPotential": 8,
    "dwellQuality": 8,
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
- Each angle must contain one central claim, audience, a concise reasoning direction in the structure field, evidenceMode, numeric planning scores, and 2-3 optional hookCandidates.
- The selected Expression Mode will own final rhetorical structure; do not prescribe the same hook/problem/example/advice/closing sequence for every angle.
- Reject vague hooks such as "One overlooked detail...", "In today's rapidly evolving landscape...", "Many businesses struggle with...", "Have you ever wondered...", "In the world of...", "This one thing can change everything...".
- Do not mix unrelated concepts.
- Do not propose angles that require invented stories or unsupported facts.
- Do not merely restate the topic without a viewpoint.
- Treat the input as a topic unless it already states a specific claim. Preserve an already-specific claim; otherwise narrow it before drafting.
- Every coreClaim must assert one debatable relationship, condition, mechanism, trade-off, or decision. Reject claims that only say the topic is important, improves performance, drives success, reduces risk, or increases efficiency.
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
    : 'No hook was selected. Do not invent a hook wrapper. Return hook: "" and let the body begin directly in the form required by the Expression Mode.';

  const voiceBlocks = buildManualVoiceContextBlocks(input.voiceContext);
  const diversityBlock = buildExpressionModePromptBlock(input.expressionMode, input.recentPosts ?? [], input.author.strategy);

  return `${MANUAL_COMPOSER_SYSTEM}
${buildAuthorBlock(input.author)}
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

${hookInstruction}

Drafting rules:
- Preserve the selected CENTRAL CLAIM and evidence mode. Do not broaden, substitute, or add a second thesis.
- Follow the Expression Mode's structure even when the planning direction or hook hint suggests a more conventional essay shape.
- Do not invent personal experience, metrics, clients, incidents, or timelines.
- Do not add a forced engagement question unless the user explicitly requested one.

Evidence rules:
${evidenceRules}

${MANUAL_QUALITY_RULES}

FINAL RHETORICAL AUTHORITY:
The CENTRAL CLAIM above controls what the post argues. The following Expression Mode contract controls how the thought unfolds. It overrides any earlier generic suggestion about explanation, evidence, length, value, readability, hooks, or completeness when those suggestions would add rhetorical moves the mode does not need.
${diversityBlock}

${MANUAL_DRAFT_OUTPUT_SCHEMA}`;
}

export function buildManualCriticAndRevisionPrompt(input: {
  topic: string;
  author: AuthorContext;
  voiceContext?: ManualVoiceContext;
  expressionMode?: ExpressionMode;
  recentPosts?: string[];
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
  const diversityBlock = buildExpressionModePromptBlock(input.expressionMode, input.recentPosts ?? [], input.author.strategy);

  return `${MANUAL_COMPOSER_SYSTEM}
${buildAuthorBlock(input.author)}
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
- Score hook, specificity, voiceMatch, focus, credibility, originality, audienceFit, conversationPotential, dwellQuality, readability, and genericAiRisk (0-10).
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
