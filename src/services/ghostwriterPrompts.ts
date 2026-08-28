import type { AuthorContext, BatchPostPlan, GeneratedPostContent, QualityIssue, SpecificityResult, TechnicalReviewIssue, TrendCandidate } from './generationTypes';
import { buildExpressionModePromptBlock } from './expressionModeService';
import { resolvePostDepthMetadata } from './postDepth';

export const LINKEDIN_LINE_FORMAT_RULES = `NATURAL LINKEDIN FORMATTING:
- Use readable mobile paragraphs and varied sentence length; standalone lines are optional emphasis, not a default cadence.
- Use bullets or numbering only when the idea is genuinely a checklist, comparison, or ordered process.
- Avoid broad category openings, engagement bait, stock AI phrases, unnecessary emojis, and Markdown bold markers.
- Do not repeat the headline, image copy, opening claim, or conclusion in different words.
- Zero paragraphs, examples, lists, questions, conclusions, or CTAs are mandatory. Stop when the assigned thought is complete.`;

export const SPECIFICITY_RULES = `DEPTH-PROPORTIONAL COMPLETENESS:
- Add the smallest amount of concrete support needed to make the assigned claim useful and defensible.
- Mechanism, consequence, qualification, trade-off and failure mode are optional reasoning dimensions, not mandatory sections of the final post. Examples, process details, and decision rules are optional too.
- One strong supporting dimension may be sufficient. Prefer information gain over coverage or length.
- Do not add specialist terminology, invented evidence, adjacent advice, or a checklist merely to appear specific.`;

export const POST_QUALITY_CONTEXT = `QUALITY TARGET:
- Preserve one narrow claim, serve the stated audience and objective, and use only evidence-backed authority.
- A compact post is explicitly valid when it completes the thought with high information density.
- Let the idea determine length. Never pad to a character target; LinkedIn's 3,000-character maximum is the only universal limit.`;

export const VARIED_FORMAT_RULES = LINKEDIN_LINE_FORMAT_RULES;

export const HASHTAG_RULES = `HASHTAG RULES:
- Zero to three hashtags only. Target two specific hashtags.
- Hashtags must match this exact post topic and angle.
- No generic filler hashtags.
- Put hashtags only in the JSON "hashtags" field, not in the body.
- TitleCase formatting. Empty string is valid.`;

export const LANGUAGE_RULES = `LANGUAGE RULE:
- English only unless the author configuration explicitly requests another language.`;

export const DEFAULT_EDITORIAL_RULES = `EDITORIAL AUTHORITY — FINAL:
- Follow the assigned editorial form as a flexible rhetorical direction, not a section template.
- Every added passage must contribute evidence, reasoning, qualification, implication, or application that changes what the reader understands.
- End on the final substantive move. A question, conclusion, recommendation, or CTA is optional and must match the assigned ending and conversion objective.`;

export const GHOSTWRITER_SYSTEM = `You write original LinkedIn posts for the supplied author and return the requested JSON.

Follow this hierarchy when instructions compete:
1. Factual and authority safety.
2. Fidelity to the selected claim.
3. Audience relevance and content objective.
4. Assigned editorial form.
5. Supplied evidence.
6. Depth-proportional completeness.
7. Natural LinkedIn formatting.

Never invent or embellish personal experience, biography, clients, projects, results, numbers, dates, achievements, quotations, sources, or factual evidence. First-person experiential claims require explicit supplied evidence. A niche, job title, profile skill, or generated post does not prove that the author personally did something.

Keep source facts, author facts, general knowledge, opinion, hypothetical reasoning, and conditional recommendations distinct. Preserve uncertainty and authority boundaries. Do not present a possibility as a guarantee, a source claim as personal experience, or a general observation as verified evidence.`;

export function buildAuthorBlock(author: AuthorContext, options: { includeQualityContext?: boolean } = {}): string {
  const niches = (author.niches ?? []).join(', ') || 'general professional topics';
  const intelligence = author.contentIntelligence;
  const audience = (author.targetAudience ?? []).join(', ') || 'the intended readers';
  const strategy = author.strategy;
  const authority = author.authorityContext;
  const supportedAuthority = authority?.territories
    .filter((entry) => entry.mode !== 'UNKNOWN' && entry.mode !== 'EXPLORATORY')
    .slice(0, 10)
    .map((entry) => `${entry.topic} (${entry.mode.toLowerCase()}, confidence ${entry.confidence.toFixed(2)})`)
    .join('; ');
  const authorityBlock = authority ? `
USER KNOWLEDGE / AUTHORITY BOUNDARIES (${authority.scope}):
- Evidence-supported familiarity: ${supportedAuthority || 'none established; use neutral or exploratory framing'}
- Repeatedly discussed: ${authority.repeatedlyDiscussedTopics.join(', ') || 'none established'}
- Exploring: ${authority.exploringTopics.slice(0, 12).join(', ') || 'none supplied'}
- First-person boundary: ${authority.scope === 'BATCH' ? 'No anecdote permission; saved experiences and their details are withheld.' : 'Only a deliberately selected PERSONAL EXPERIENCE block permits experiential claims.'}
- Boundaries: ${authority.boundaries.join(' ')}
` : '';
  const strategyBlock = strategy ? `
STRATEGY CONTEXT (use for topic angle and audience fit):
- Positioning: ${strategy.profilePositioning.positioningStatement || strategy.legacy.description || 'Use the author profile above.'}
- Point of view: ${strategy.profilePositioning.uniquePointOfView || 'Choose a defensible, specific point of view from the supplied topic.'}
- Configured audiences: ${audience}
- Audience use: the idea-level claim contract resolves which audience, if any, is natural. Use that context silently; never insert an audience label merely to manufacture relevance.
- Audience pains: ${strategy.targetAudience.painPoints.join('; ') || 'infer only from supplied source facts and author context'}
- Desired outcomes: ${strategy.targetAudience.desiredOutcomes.join('; ') || 'make the post useful to the target audience'}
- Primary goal: ${strategy.contentGoals.primaryGoal}
${intelligence ? `- Positioning promise: ${intelligence.identity.contentPromise}
- Credibility boundaries: ${intelligence.identity.credibilityBoundaries.join('; ')}
- Authority rule: a configured niche indicates intended subject matter, not personal experience or comprehensive expertise. Use neutral or exploratory framing unless explicit author evidence supports stronger authority.` : ''}
- Excluded topics: ${strategy.contentPillars.excludedTopics.join(', ') || 'none specified'}
- Writing style: ${strategy.writingStyle.tone.join(', ') || author.tone}; formality ${strategy.writingStyle.formality}; length ${strategy.writingStyle.postLength}; formats ${strategy.writingStyle.preferredFormats.join(', ') || 'use existing LinkedIn formatting rules'}
` : '';
  return `
AUTHOR PROFILE (highest priority):
${author.description.trim() || 'Professional operator in the selected niches.'}

NICHES: ${niches}
CONFIGURED AUDIENCE OPTIONS: ${audience}
TONE: ${author.tone}
${strategyBlock}
${authorityBlock}
${options.includeQualityContext === false ? '' : POST_QUALITY_CONTEXT}
`;
}


export function buildAngleSpecificityBlock(
  plan: BatchPostPlan,
): string {
  const prefix = `ANGLE LENS (${plan.angle}): This selects what to examine, not a mandatory essay structure.`;
  switch (plan.angle) {
    case 'practical_tutorial':
      return `${prefix} Explain a usable process or decision. Use ordered steps only when sequence is intrinsic to the idea.`;

    case 'architecture_tradeoff':
      return `${prefix} Clarify a meaningful choice and the condition that changes it; comparison and qualification are optional when the claim already resolves the choice.`;

    case 'technical_mistake':
      return `${prefix} Identify one mistaken assumption or behavior and a credible correction. Cause, example, and failure mode are optional.`;

    case 'debugging_story':
      return `${prefix} Examine how a problem can be diagnosed. Do not imply a personal incident; symptom, cause, check, and response are available reasoning dimensions, not required sections.`;

    case 'product_lesson':
      return `${prefix} Develop one meaningful decision or lesson with domain-relevant reasoning; consequence and broader principle are optional.`;

    case 'reflection':
      return `${prefix} Develop a precise observation and only the implication needed to complete it. Advice and examples are optional.`;

    case 'defensible_opinion':
      return `${prefix} State a clear position and enough credible reasoning to defend it. Qualification, counterargument, question, and CTA are optional.`;

    default:
      return `${prefix} Develop the assigned claim with only the reasoning it needs.`;
  }
}


export function buildSourceEvidenceBlock(trend?: TrendCandidate | null, fallbackTitle?: string | null): string {
  if (!trend) {
    return `SOURCE EVIDENCE:
Title: ${fallbackTitle?.trim() || '(evergreen idea)'}
Summary: (none — use careful general reasoning without implying a source)
Key points: (none)`;
  }

  const summary = trend.summary?.trim() || '(not available — do not imply you read the article)';
  const keyPoints = (trend.keyPoints ?? []).length
    ? trend.keyPoints!.map((p) => `- ${p}`).join('\n')
    : '(not available)';

  return `SOURCE EVIDENCE:
Title: ${trend.topic}
Summary: ${summary}
Key points:
${keyPoints}

Rules:
- Use source evidence when present.
- Do not invent article details.
- General domain reasoning is allowed when clearly phrased as such.
- When evidence is missing, do not imply the post summarizes the article.`;
}

type CandidateSafetyRule = { matches: RegExp; instruction: string };

const CANDIDATE_SAFETY_RULES: CandidateSafetyRule[] = [
  { matches: /\b(?:authentication|authorization|login|access control)\b/i, instruction: 'Authentication establishes identity; authorization determines permitted actions.' },
  { matches: /\b(?:tenant|multi-tenant|cross-tenant)\b/i, instruction: 'Isolation claims require scoped authorization and data access, not identity checks alone.' },
  { matches: /\b(?:client-side|frontend|entitlement|server-side)\b/i, instruction: 'User-interface restrictions are not a security boundary; enforcement claims must identify the authoritative control.' },
  { matches: /\b(?:compliance|audit trail|audit log)\b/i, instruction: 'Access control, auditability, and legal compliance are distinct claims and need distinct evidence.' },
  { matches: /\b(?:queue|concurrency|duplicate job|lock|idempotent)\b/i, instruction: 'Concurrency controls and locks do not by themselves guarantee duplicate prevention or exactly-once execution.' },
  { matches: /\b(?:environment parity|staging|production database|shared database)\b/i, instruction: 'Environment consistency does not require shared infrastructure or shared data.' },
  { matches: /\b(?:patient|clinical|diagnos|treatment|medical)\b/i, instruction: 'Do not convert general health information into a diagnosis, treatment promise, or unsupported patient outcome.' },
  { matches: /\b(?:investment|financial return|tax|accounting)\b/i, instruction: 'Do not present uncertain financial, tax, or return claims as guaranteed or individually applicable.' },
  { matches: /\b(?:legal|law|regulation|regulatory)\b/i, instruction: 'Distinguish general information from jurisdiction-specific legal conclusions and preserve stated uncertainty.' },
];

export function buildCandidateSafetyBlock(
  plan: BatchPostPlan,
  trend?: TrendCandidate | null,
  body = '',
): string {
  const context = [
    plan.sourceTopic,
    plan.centralClaim,
    plan.selectedCentralClaim,
    plan.coreClaim,
    ...(plan.mechanismFocus ?? []),
    trend?.topic,
    trend?.summary,
    ...(trend?.keyPoints ?? []),
    body,
  ].filter(Boolean).join(' ');
  const relevant = CANDIDATE_SAFETY_RULES.filter((rule) => rule.matches.test(context));
  if (!relevant.length) return '';
  return `CANDIDATE-RELEVANT SAFETY DISTINCTIONS:\n${relevant.map((rule) => `- ${rule.instruction}`).join('\n')}`;
}

export function buildPlanBlock(plan: BatchPostPlan, sourceLink?: string, trend?: TrendCandidate | null, recentPosts: string[] = [], author?: AuthorContext): string {
  const centralClaim = plan.centralClaim ?? plan.coreClaim ?? plan.sourceTopic ?? 'Develop one narrow claim from the source topic.';
  const depth = plan.depthPlan;
  const editorial = plan.editorialDecision;
  const { depthClass, targetLengthRange } = resolvePostDepthMetadata(plan);
  const audience = plan.resolvedAudience?.length
    ? plan.resolvedAudience.join(', ')
    : 'broadly relevant readers; do not insert a configured audience label';
  const depthItems = [
    depth?.strongestObservations.length ? `- Useful observations: ${depth.strongestObservations.join(' | ')}` : '',
    depth?.underlyingCauseOrMechanism ? `- Possible mechanism: ${depth.underlyingCauseOrMechanism}` : '',
    depth?.deeperInterpretation ? `- Possible interpretation: ${depth.deeperInterpretation}` : '',
    depth?.meaningfulConsequence ? `- Possible consequence: ${depth.meaningfulConsequence}` : '',
    depth?.usefulTensionOrQualification ? `- Possible qualification or tension: ${depth.usefulTensionOrQualification}` : '',
    depth?.personalPerspective.supported && depth.personalPerspective.insight ? `- Supported personal perspective: ${depth.personalPerspective.insight}` : '',
    depth?.endingInsight ? `- Possible ending insight: ${depth.endingInsight}` : '',
    depth?.avoidIdeas.length ? `- Avoid: ${depth.avoidIdeas.join(' | ')}` : '',
  ].filter(Boolean).join('\n');
  const hookFunction: Record<string, string> = {
    OBSERVATION: 'begin with the specific observable pattern; do not convert it into a mistake or misconception premise',
    DIRECT_VALUE_PROMISE: 'state the useful claim, decision, or mechanism immediately; do not announce the topic first',
    CONTRARIAN_CLAIM: 'state only the contrast already supported by the claim; do not invent a popular belief or controversy',
    SPECIFIC_RESULT: 'lead with the supported result or measurement and its meaning',
    MISTAKE: 'name the supported failure behavior and its cause; do not claim it is common unless evidence says so',
    COMPARISON: 'establish the compared options or conditions immediately',
    QUESTION: 'ask a genuinely unresolved question whose answer is developed by the post; never use question then obvious answer',
    FIRST_PERSON_LESSON: 'open on the supported personal observation without embellishing the experience',
    STORY_OPENING: 'enter at a supported concrete moment or change, not a generic scene-setting paragraph',
  };
  const structureFunction: Record<string, string> = {
    CLAIM_EXPLANATION_IMPLICATION: 'claim → explanation → implication',
    STORY_TURNING_POINT_LESSON: 'supported situation → meaningful turn → bounded lesson',
    OBSERVATION_MECHANISM_CONSEQUENCE: 'specific observation → mechanism → consequence or qualification',
    MISTAKE_CAUSE_CORRECTION: 'supported failure behavior → cause → correction or decision check',
    COMPARISON_DISTINCTION_DECISION: 'comparison dimensions → condition that changes the preference → decision rule',
    QUESTION_ANSWER_TAKEAWAY: 'genuine question → reasoned answer → substantive implication',
    FRAMEWORK_EXPLANATION_APPLICATION: 'state/process change → resulting behavior → bounded application',
    COMPACT_INSIGHT: 'one substantive claim developed only as far as needed',
  };
  return `
CLAIM CONTRACT — SELECTED CENTRAL CLAIM — PRESERVE THIS MEANING:
${centralClaim}
Develop this claim only. Do not broaden it, replace its mechanism, reverse its conclusion, change its audience implication, or introduce a second thesis.

AUDIENCE AND OBJECTIVE:
- Audience: ${audience}
- Content objective: ${editorial?.contentObjective?.toLowerCase().replace(/_/g, ' ') ?? 'develop one useful idea'}
- Conversion objective: ${editorial?.conversionObjective ?? 'NONE'}. NONE means no CTA; a substantive final insight is not a CTA.

ASSIGNED EDITORIAL FORM:
${buildAngleSpecificityBlock(plan)}
${editorial ? `- Opening direction: ${editorial.hookFamily.toLowerCase().replace(/_/g, ' ')}; express the claim directly, without a stock formula or clickbait.
- Opening function: ${hookFunction[editorial.hookFamily] ?? 'make a substantive rhetorical move in line one'}.
- Rhetorical direction: ${editorial.rhetoricalStructure.toLowerCase().replace(/_/g, ' ')}; use it flexibly, without headings or a fixed paragraph count.
- Reasoning progression: ${structureFunction[editorial.rhetoricalStructure] ?? 'make each paragraph advance a distinct reasoning function'}.
- Ending direction: ${editorial.endingIntent.toLowerCase().replace(/_/g, ' ')}.
- The final paragraph must realize that ending behavior; it may stop on a substantive point and must not add an automatic summary or recommendation.
- Reference/share value, when useful: ${editorial.referenceValueForm.toLowerCase().replace(/_/g, ' ')}.
- Presentation goal: ${editorial.shareabilityProfile?.presentationGuidance ?? 'Present the central claim clearly without manufacturing a list, framework, controversy, or CTA.'}
- Personal evidence: ${editorial.personalEvidenceAvailable ? 'use only explicitly supplied facts' : 'unavailable; do not use a first-person story, lesson, or result'}.
` : '- Follow the assigned angle and expression mode without treating legacy layout labels as a template.\n'}

${buildSourceEvidenceBlock(trend, plan.sourceTopic)}
${sourceLink ? `Reference link: ${sourceLink}` : ''}
${buildCandidateSafetyBlock(plan, trend)}

DEPTH-PROPORTIONAL COMPLETENESS:
- Depth class: ${depthClass}
- Soft range: approximately ${targetLengthRange.min}–${targetLengthRange.max} characters; this is not a quota.
- A compact post is explicitly valid when it completes the claim with high information density.
- Mechanism, consequence, qualification, trade-off and failure mode are optional reasoning dimensions, not mandatory sections of the final post. Examples are optional too.
- Use only the relevant items below. Omitted fields require no replacement:
${depthItems || '- No supporting dimension is mandatory; add only what the claim needs.'}
- Never exceed LinkedIn's hard 3,000-character maximum.
`;
}

/** Complete batch writer user prompt. Kept as a pure builder for prompt auditing and snapshots. */
export function buildPlannedPostPrompt(
  plan: BatchPostPlan,
  author: AuthorContext,
  sourceLink = '',
  trend?: TrendCandidate | null,
  recentPosts: string[] = [],
): string {
  return `${buildAuthorBlock(author, { includeQualityContext: false })}
${buildPlanBlock(plan, sourceLink, trend, recentPosts, author)}

${buildExpressionModePromptBlock(plan.expressionMode, recentPosts, author.strategy)}

${LINKEDIN_LINE_FORMAT_RULES}
${HASHTAG_RULES}
${LANGUAGE_RULES}

Output MUST be valid JSON with headline, subheadline, bulletPoints, body, and hashtags.`;
}

/** Audit representation of the system and user messages seen by the batch writer. */
export function buildAssembledBatchWriterPrompt(
  plan: BatchPostPlan,
  author: AuthorContext,
  sourceLink = '',
  trend?: TrendCandidate | null,
  recentPosts: string[] = [],
): string {
  return `${GHOSTWRITER_SYSTEM}\n\n${buildPlannedPostPrompt(plan, author, sourceLink, trend, recentPosts)}`;
}

function formatStructuredIssues(issues: Array<QualityIssue | TechnicalReviewIssue>): string {
  return issues
    .map((issue) => {
      const lines = [`- code: ${issue.code}`, `  severity: ${issue.severity}`];
      if ('excerpt' in issue && issue.excerpt) lines.push(`  excerpt: ${issue.excerpt}`);
      if ('explanation' in issue && issue.explanation) lines.push(`  explanation: ${issue.explanation}`);
      if ('repairInstruction' in issue && issue.repairInstruction) lines.push(`  repair: ${issue.repairInstruction}`);
      if ('instruction' in issue && issue.instruction) lines.push(`  repair: ${issue.instruction}`);
      if ('evidence' in issue && issue.evidence?.length) {
        lines.push(`  evidence: ${issue.evidence.join(' | ')}`);
      }
      return lines.join('\n');
    })
    .join('\n');
}

export function buildRepairPrompt(
  post: GeneratedPostContent,
  issues: Array<QualityIssue | TechnicalReviewIssue | string>,
  author: AuthorContext,
  plan?: BatchPostPlan,
): string {
  const structured = issues.map((i) =>
    typeof i === 'string'
      ? { code: i, severity: 'error' as const, instruction: `Fix issue: ${i}` }
      : i,
  );
  const isShortLengthRepair = structured.some((issue) => issue.code === 'generated_post_too_short');

  return `${buildAuthorBlock(author, { includeQualityContext: false })}
${plan ? buildPlanBlock(plan) : ''}

TARGETED REPAIR:
- Fix every listed issue and make only the additional edits needed for coherence.
- Preserve the claim contract, verified facts, successful rhetorical movement, and natural stopping point.
- Do not assume repair is an improvement merely because it is newer. Avoid collateral loss of density, evidence, qualification, or claim fidelity.
- Do not normalize the draft into an essay or add a scenario, list, action step, conclusion, question, or CTA unless the issue requires it.
- Never invent personal experience, biography, results, people, numbers, dates, sources, or project history.

ISSUES:
${formatStructuredIssues(structured)}

${isShortLengthRepair && plan ? `LENGTH REPAIR DEPTH CHECK:
Add only a genuinely missing planned dimension. Stop when the missing substance is complete; the soft range is not a quota.` : ''}

ORIGINAL POST:
${post.body}

${plan ? buildExpressionModePromptBlock(plan.expressionMode, []) : ''}
${LINKEDIN_LINE_FORMAT_RULES}
${HASHTAG_RULES}

Output valid JSON:
{
  "headline": "...",
  "subheadline": "...",
  "bulletPoints": [],
  "body": "...",
  "hashtags": "..."
}`;
}

export function buildExpandSpecificityPrompt(
  post: GeneratedPostContent,
  specificity: SpecificityResult | undefined,
  author: AuthorContext,
  plan: BatchPostPlan,
): string {
  return `${buildAuthorBlock(author, { includeQualityContext: false })}
${buildPlanBlock(plan, undefined)}

TARGETED SPECIFICITY REPAIR:
Make the post concretely useful without changing the claim contract or expanding its rhetorical structure.

Current signals: ${(specificity?.signals ?? []).join(', ') || 'none'}
Missing signals: ${(specificity?.missing ?? []).join(', ') || 'unknown'}

- Add or substitute the single most valuable concrete detail; one mechanism, fact, constraint, observation, or causal relationship may be enough.
- Preserve evidence, expression mode, paragraph rhythm, opening, and ending behavior.
- Do not add optional sections or retain vague material merely to preserve length.
- Do not invent evidence, metrics, people, incidents, or personal experience.

CURRENT POST:
${post.body}

${buildExpressionModePromptBlock(plan.expressionMode, [])}
${LINKEDIN_LINE_FORMAT_RULES}

Output valid JSON with headline, subheadline, bulletPoints, body, hashtags.`;
}

export function buildJsonRepairPrompt(params: {
  repairContext: string;
  stage: string;
  message: string;
  issues?: string[];
  invalidOutput: string;
}): string {
  return `${params.repairContext}

JSON REPAIR TASK:
The previous response failed at stage: ${params.stage}
Reason: ${params.message}
${params.issues?.length ? `Schema issues:\n${params.issues.map((i) => `- ${i}`).join('\n')}` : ''}

Invalid output:
${params.invalidOutput.slice(0, 3000)}

Return one JSON object only.
No markdown fences. No commentary.

Required shape:
{
  "headline": "string",
  "subheadline": "string",
  "bulletPoints": ["string"],
  "body": "string",
  "hashtags": "string",
  "sourceTopic": "string or null",
  "angle": "string",
  "layout": "string"
}`;
}

export function buildImageCopyPrompt(body: string, plan: BatchPostPlan): string {
  return `Extract image copy from this APPROVED post only. Do not add new facts.

POST:
${body}

Assigned visual angle: ${plan.angle}

Output JSON:
{
  "mode": "quote" | "single_insight" | "checklist" | "comparison" | "none",
  "headline": "3-9 words ideally, max 12 words, max 70 characters",
  "supportingText": "optional, max 7 words, max 55 characters",
  "bulletPoints": ["0-3 concrete bullets, 4-10 words each, max 14 words per bullet"]
}

Rules:
- Use only facts already in the post
- No contact info, URLs, or social handles
- Reject vague business language
- Prefer single_insight when one sentence is strongest
- Use checklist only for actionable sequences
- Use comparison only for genuine comparisons
- mode "none" if a visual adds little value

supportingText:
- optional
- maximum 7 words
- one complete phrase
- no punctuation-heavy sentence
- omit it when a clear 7-word phrase is not possible

Examples of valid supportingText:
- Enforce limits where actions actually occur
- Prevent retries from publishing duplicate content
- Tenant isolation requires authorization at every boundary`;
}

export function buildImageRepairPrompt(
  body: string,
  image: { headline: string; supportingText?: string; bulletPoints?: string[] },
  issues: QualityIssue[],
): string {
  return `Repair image copy extracted from an approved post. Do not add new claims.

APPROVED POST:
${body}

CURRENT IMAGE COPY:
headline: ${image.headline}
supportingText: ${image.supportingText ?? '(none)'}
bullets: ${(image.bulletPoints ?? []).join(' | ') || '(none)'}

ISSUES:
${formatStructuredIssues(issues)}

Output valid JSON with mode, headline, supportingText (optional, max 7 words), bulletPoints (0-3).
Omit supportingText if a natural 7-word phrase is not possible.`;
}

export function buildTechnicalReviewPrompt(
  post: { body: string },
  author: AuthorContext,
  plan: BatchPostPlan,
): string {
  const claim = plan.selectedCentralClaim ?? plan.centralClaim ?? plan.coreClaim ?? plan.sourceTopic ?? '(not supplied)';
  const editorial = plan.editorialDecision;
  const authorityBoundaries = author.authorityContext?.boundaries.join(' ') || 'Do not infer biography, experience, results, or authority beyond supplied author facts.';
  return `Review this LinkedIn draft as a domain-generic factual and argument-quality editor.

REVIEW HIERARCHY:
1. Factual and authority safety: flag invented evidence, biography, experience, outcomes, numbers, guarantees, or claims beyond supported authority.
2. Claim fidelity: the draft must preserve this meaning — ${claim}
3. Audience and objective: ${(plan.resolvedAudience?.length ? plan.resolvedAudience.join(', ') : 'broadly relevant readers without forced audience naming')}; ${editorial?.contentObjective ?? 'one useful idea'}.
4. Editorial form: judge whether ${editorial?.rhetoricalStructure?.toLowerCase().replace(/_/g, ' ') ?? plan.expressionMode ?? 'the assigned form'} serves the idea; do not demand a template.
5. Evidence: distinguish supplied facts, general knowledge, opinion, and hypothetical reasoning. Do not reward invented specificity.
6. Depth-proportional completeness: compact drafts are valid. Longer drafts must earn their length with information gain.
7. Natural LinkedIn formatting: CTA, question, list, example, conclusion, and long-form treatment are optional.

AUTHOR EVIDENCE BOUNDARY:
- Profile: ${author.description.slice(0, 400) || '(none supplied)'}
- ${authorityBoundaries}

${buildCandidateSafetyBlock(plan, undefined, post.body)}

SEMANTIC REVIEW:
- A passage adds information only when it contributes material evidence, reasoning, constraint, consequence, counterpoint, implication, detail, or qualification.
- Transition words, synonym swaps, thesis-restating examples, and generic checklists do not count as progression.
- Mechanism, consequence, qualification, trade-off and failure mode are optional reasoning dimensions, not mandatory sections of the final post.
- Penalize broad category setup and formulaic essay progression when they dilute this claim.
- Do not penalize simplification unless it changes meaning, overstates certainty, or becomes unsafe.
- Score claim fidelity independently from reviewer preference for length or structure.

POST:
${post.body}

Output JSON only:
{
  "passed": boolean,
  "confidence": number between 0 and 1,
  "informationDensity": integer 0-100,
  "progressionQuality": integer 0-100,
  "redundancyRisk": integer 0-100,
  "genericDiscourseRisk": integer 0-100,
  "claimFidelity": integer 0-100,
  "issues": [
    {
      "code": "short_machine_code such as CLAIM_DRIFT, UNSUPPORTED_FACT, LOW_INFORMATION_DENSITY, or REDUNDANT_EXPLANATION",
      "severity": "warning" | "error",
      "excerpt": "short quote from post",
      "explanation": "why this materially harms safety, fidelity, or quality",
      "repairInstruction": "how to fix without inventing facts"
    }
  ]
}`;
}

/** Audit representation of the system and user messages seen by the batch reviewer. */
export function buildAssembledTechnicalReviewPrompt(
  post: { body: string },
  author: AuthorContext,
  plan: BatchPostPlan,
): string {
  return `${GHOSTWRITER_SYSTEM}\n\n${buildTechnicalReviewPrompt(post, author, plan)}`;
}
