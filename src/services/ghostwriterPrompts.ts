import type { AuthorContext, BatchPostPlan, GeneratedPostContent, QualityIssue, SpecificityResult, TechnicalReviewIssue, TrendCandidate } from './generationTypes';
import { buildExpressionModePromptBlock } from './expressionModeService';
import { resolvePostDepthMetadata } from './postDepth';

export const TECHNICAL_DISTINCTIONS = `TECHNICAL ACCURACY DISTINCTIONS:

- Authentication proves identity. Authorization determines allowed actions.
- Tenant isolation requires tenant-scoped authorization and data access.
- Client-side restrictions improve UX; they are not a security boundary.
- Server-side entitlement checks enforce access. Audit trails require explicit logs.
- Access controls may support compliance goals but do not establish compliance alone.
- Environment parity does not require shared infrastructure or shared databases.
- Environment consistency and scalability are not opposing goals.
- Queue concurrency settings can reduce overlap but do not guarantee exactly-once execution.
- Critical publishing actions should be idempotent.
- Locks are safeguards, not substitutes for idempotency and atomic state transitions.
- Usage limits should be validated and incremented atomically during protected actions.
- Background tasks are suitable for reconciliation, resets, and aggregation.
- Token authentication does not automatically solve tenant isolation or session management.`;

export const LINKEDIN_LINE_FORMAT_RULES = `FORMAT AND RHYTHM: Write in a clear, conversational LinkedIn format that is easy to scan on mobile.
 - Let the selected Expression Mode determine the opening, progression, cadence, and ending behavior.
 - Use natural paragraphs separated by whitespace; mix one-line, two-sentence, and occasional compact grouped explanations when useful.
 - Use short standalone lines selectively for emphasis without making every sentence dramatic.
 - Use numbered lists only for ordered steps or clearly separated reasons. 
 - Use hyphen bullets only for practical checks, actions, or examples.
 - Keep list items concise and structurally consistent.
 - Vary sentence length so the post does not feel robotic. 
 - Avoid repeating the headline, image text, or the same conclusion in different words.
 - The caption should add depth beyond what appears in the image.
 - Do not copy the wording or subject matter of any supplied example.
 - Do not invent personal stories, clients, incidents, metrics, or results.

 The final post should feel written by an experienced practitioner, not like a textbook, documentation page, or generic AI summary.`;


 export const SPECIFICITY_RULES = `SPECIFICITY REQUIREMENTS:
Ground the central claim with enough concrete detail to make it useful and credible.
Choose the one to three specificity dimensions that most strengthen this claim: a mechanism, process detail, constraint, example, causal explanation, boundary, diagnostic observation, comparison, or decision rule. One strong dimension may be sufficient.
Do not add multiple categories merely to demonstrate completeness, and do not turn specificity into a checklist.
Do not add a failure scenario, consequence, action step, example, trade-off, or implementation boundary unless the idea genuinely needs it.
Prefer one precise explanation over several generic supporting sections.
When an example is useful, integrate it naturally into the reasoning rather than creating a separate essay-style scenario paragraph.
Do not add specialist terminology only to appear specific.
Do not repeat definitions that are already obvious from the headline or image. Do not invent metrics, customers, incidents, implementation history, or personal experience.`;

export const POST_QUALITY_CONTEXT = `POST QUALITY CONTEXT:
- Topic clarity: one specific topic, one central claim, and no mixed angles.
- Clear niche match: use niche-specific context only when it materially strengthens the argument. Do not insert an industry paragraph merely to demonstrate relevance; implicit relevance is acceptable when the claim already naturally serves the audience.
- Topic-audience match: connect the idea to the target audience's pain, goal, objection, or desired outcome.
- Profile alignment: write from the author's saved positioning and expertise without inventing biography.
- Original insight: include a useful mechanism, reframing, trade-off, or decision rule instead of generic advice.
- Dwell quality: provide appropriate depth and concrete value without filler. A compact post can be complete without staged progression.
- Conversational potential: make the idea worth discussing without requiring a question, CTA, or explicit conclusion.
- Credibility/proof: use supplied proof when available; otherwise use sound technical reasoning. Use a concrete example or labeled hypothetical only when it materially helps.
- Length: let idea complexity, completeness, and information density determine the natural stopping point. Follow any generation-mode depth or length contract supplied below. Never add repetition, filler, generic advice, or optional sections to reach a character target. LinkedIn's 3,000-character maximum remains hard.
- Formatting: never use Markdown bold markers or double asterisks. Do not include ** anywhere in the output.`;

 export const VARIED_FORMAT_RULES = `POST WRITING REQUIREMENTS:
- Write as a ghostwriter for the supplied author profile.
- Write an original LinkedIn post, not a summary of the source article.
- Use the assigned angle for what the post explores and the Expression Mode for how it is structured.
- Treat hook, ending, and legacy layout as optional presentation hints. Ignore them when they conflict with the Expression Mode or the natural completion of the idea.
- Respect the saved short/medium/long preference while letting content completeness determine exact length.
- Prioritize substance over reaching a target length.
- Do not use Markdown bold markers or double asterisks.

Variation rules:
- Not every post needs a problem statement, example, failure scenario, consequence, list, question, recommendation, or explicit conclusion.
- Paragraph count and opening length should vary naturally. Some posts may start immediately with the claim.
- Use as many paragraphs as the idea needs. A complete post may be one compact block, two short paragraphs, several standalone lines, a walkthrough, or a longer explanation.
- Use a concrete example, failure mode, implementation detail, or hypothetical only when it materially improves the argument.
- When an example is useful, state it directly and integrate it into the reasoning instead of introducing a separate generic scenario.

Additional rules: - Use bullets only for genuine checklists, actions, or comparisons.
 - Use no more than four bullets unless the assigned layout requires ordered steps.
 - Do not use engagement bait.
 - Do not use phrases such as "In today's world", "game changer", or "unlock your potential".
 - Do not begin with broad phrases such as "When building a SaaS platform".
 - Use qualified technical language where appropriate: can, may, often, depending on, in some systems.
 - The body should complement the accompanying image rather than paraphrase it.   

${LINKEDIN_LINE_FORMAT_RULES}`;

export const HASHTAG_RULES = `HASHTAG RULES:
- Zero to three hashtags only. Target two specific hashtags.
- Hashtags must match this exact post topic and angle.
- No generic filler (#Growth, #Innovation, #Strategy).
- Put hashtags only in the JSON "hashtags" field, not in the body.
- TitleCase formatting. Empty string is valid.`;

export const LANGUAGE_RULES = `LANGUAGE RULE:
- English only unless the author configuration explicitly requests another language.`;

export const DEFAULT_EDITORIAL_RULES = `EDITORIAL AUTHORITY — FINAL:
- The selected Expression Mode and explicit user structure remain authoritative. A Walkthrough, listicle, checklist, or requested sequence may enumerate intentionally.
- Do not prove depth by listing every reasonable cause, benefit, drawback, example, or recommendation.
- Choose the strongest two or three observations, group symptoms that share one cause, then explain what they reveal.
- Evidence says what happens. Cause explains why. Interpretation explains what it reveals. Consequence explains why it matters. Do not treat synonyms for one effect as separate insights.
- A new paragraph should normally perform a different argumentative function: claim, evidence, observation, cause, mechanism, interpretation, contrast, qualification, consequence, application, supported personal shift, or resolution.
- A strong LinkedIn post develops a thought; it does not exhaust a topic. Once the reader understands a point, move deeper instead of explaining it again.
- Prefer a declarative claim, specific observation, pattern, or counterintuitive statement over a generic curiosity question unless the user's style genuinely favors questions.
- End by sharpening, reframing, resolving, exposing a tension, or stopping. Do not summarize the opening thesis or append a generic recommendation.`;

export const GHOSTWRITER_SYSTEM = `You are a ghostwriter for this author, not a news summarizer.

Priority order:
1. Author credibility and supplied profile
2. Selected niches and audience
3. Assigned batch angle
4. Relevant insight from the source (inspiration only)
5. Writing style

Never invent:
- personal experiences
- customer results, revenue, user numbers, benchmarks
- project history or opinions attributed to the author
- locations or communities the author did not mention

Do not use first-person experience unless that exact experience exists in the supplied author context.
Mentioning a project name from the profile does NOT authorize a debugging story or implementation anecdote.

When personal evidence is unavailable:
- ground the claim in the single most natural credible form: an observation, technical mechanism, conditional recommendation, constraint, or trade-off
- do not include all of these forms merely to make the post appear comprehensive
- let the selected Expression Mode determine whether the post explains, recommends, compares, or simply states a well-supported point

Internally distinguish verified author facts, source facts, general technical knowledge, opinion, and conditional recommendations — but do NOT label them in the final post.

${TECHNICAL_DISTINCTIONS}`;

export function buildAuthorBlock(author: AuthorContext, options: { includeQualityContext?: boolean } = {}): string {
  const niches = (author.niches ?? []).join(', ') || 'general technology';
  const intelligence = author.contentIntelligence;
  const audience = (author.targetAudience ?? []).join(', ') || 'builders and operators';
  const strategy = author.strategy;
  const strategyBlock = strategy ? `
STRATEGY CONTEXT (use for topic angle and audience fit):
- Positioning: ${strategy.profilePositioning.positioningStatement || strategy.legacy.description || 'Use the author profile above.'}
- Point of view: ${strategy.profilePositioning.uniquePointOfView || 'Choose a defensible, specific point of view from the supplied topic.'}
- Target audience: ${strategy.targetAudience.primaryAudience || audience}
- Audience pains: ${strategy.targetAudience.painPoints.join('; ') || 'infer only from supplied source facts and author context'}
- Desired outcomes: ${strategy.targetAudience.desiredOutcomes.join('; ') || 'make the post useful to the target audience'}
- Primary goal: ${strategy.contentGoals.primaryGoal}
- Content pillars: ${[
    ...strategy.contentPillars.primaryPillars.map((pillar) => pillar.name),
    ...strategy.contentPillars.secondaryPillars.map((pillar) => pillar.name),
  ].join(', ') || niches}
${intelligence ? `- Positioning promise: ${intelligence.identity.contentPromise}
- Credibility boundaries: ${intelligence.identity.credibilityBoundaries.join('; ')}
- Authority rule: a configured niche indicates intended subject matter, not personal experience or comprehensive expertise. Use neutral or exploratory framing unless explicit author evidence supports stronger authority.` : ''}
- Excluded topics: ${strategy.contentPillars.excludedTopics.join(', ') || 'none specified'}
- Rejected patterns: ${strategy.topicRules.rejectedPatterns.join(', ') || 'none specified'}
- Writing style: ${strategy.writingStyle.tone.join(', ') || author.tone}; formality ${strategy.writingStyle.formality}; length ${strategy.writingStyle.postLength}; formats ${strategy.writingStyle.preferredFormats.join(', ') || 'use existing LinkedIn formatting rules'}

STRATEGY RULES:
- Do not write generic niche commentary.
- Connect the topic to a target-audience pain, goal, objection, or desired outcome.
- Make the angle fit the author's positioning and point of view.
- Respect excluded topics and rejected patterns.
- Use writing style only for tone, structure, and formatting. Do not let style replace strategy.
- Avoid repeating recent topic angles supplied elsewhere in context.
` : '';
  return `
AUTHOR PROFILE (highest priority):
${author.description.trim() || 'Professional operator in the selected niches.'}

NICHES: ${niches}
AUDIENCE: ${audience}
TONE: ${author.tone}
${strategyBlock}
${options.includeQualityContext === false ? '' : POST_QUALITY_CONTEXT}
`;
}


export function buildAngleSpecificityBlock(
  plan: BatchPostPlan,
): string {
  switch (plan.angle) {
    case 'practical_tutorial':
      return `ANGLE REQUIREMENTS (practical_tutorial):
- Required thinking: a usable process or implementation approach and the details needed to carry it out in this domain.
- Ordered steps are appropriate, but include only the steps the implementation needs.
- Name relevant workflow stages, decisions, roles, tools, or system layers only when useful.
- Mention an incorrect approach only if it clarifies a meaningful boundary.`;

    case 'architecture_tradeoff':
      return `ANGLE REQUIREMENTS (architecture_tradeoff):
- Required thinking: two genuinely different approaches and the condition that makes each appropriate.
- Operational or maintenance risks are optional unless they affect the decision.
- Do not declare a universal winner when the choice depends on context.
- The Expression Mode determines presentation and order.`;

    case 'technical_mistake':
      return `ANGLE REQUIREMENTS (technical_mistake):
- Required thinking: identify one mistaken assumption, behavior, process, or mechanism and provide a domain-grounded correction.
- Explain why it can appear reasonable only when that adds useful context.
- A failure example is optional when the mechanism is already concrete.
- The Expression Mode determines presentation and order.`;

    case 'debugging_story':
      return `ANGLE REQUIREMENTS (debugging_story):
- Do not fabricate a personal experience.
- Present it as a common or hypothetical debugging sequence.
- Include the visible symptom.
- Include the underlying cause.
- Include one diagnostic check.
 - Include the fix; add prevention guidance only when useful.
- Keep the sequence clear and easy to follow.`;

    case 'product_lesson':
      return `ANGLE REQUIREMENTS (product_lesson):
- Required thinking: a meaningful product, process, or implementation decision and the domain reasoning that makes it useful.
- A consequence, user impact, or broader principle is optional.
- Avoid generic business lessons.
- The Expression Mode determines presentation and order.`;

    case 'reflection':
      return `ANGLE REQUIREMENTS (reflection):
- Required thinking: a precise observation and its meaningful implication.
- Examples and implementation decisions are optional when the observation is already concrete.
- Lower specialist-detail density than a tutorial is acceptable.
- The Expression Mode determines presentation and order.`;

    case 'defensible_opinion':
      return `ANGLE REQUIREMENTS (defensible_opinion):
- Required thinking: a clear position supported by credible, domain-grounded reasoning.
- A qualification, counterargument, limitation, or example is optional.
- Do not require a question, CTA, or artificial balance.
- The Expression Mode determines presentation and order.`;

    default:
      return `ANGLE REQUIREMENTS (${plan.angle}):
- Open with a specific idea.
- Explain the mechanism or reasoning.
 - Add consequences or actions only when they are relevant to the selected angle.`;
  }
}


export function buildSourceEvidenceBlock(trend?: TrendCandidate | null): string {
  if (!trend) {
    return `SOURCE EVIDENCE:
Title: (evergreen author expertise)
Summary: (none — write general technical guidance clearly labeled as general guidance)
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
- General technical guidance is allowed when clearly phrased as general guidance.
- When evidence is missing, do not imply the post summarizes the article.`;
}

export function buildPlanBlock(plan: BatchPostPlan, sourceLink?: string, trend?: TrendCandidate | null, recentPosts: string[] = [], author?: AuthorContext): string {
  const centralClaim = plan.centralClaim ?? plan.coreClaim ?? plan.sourceTopic ?? 'Develop one narrow claim from the source topic.';
  const depth = plan.depthPlan;
  const { depthClass, targetLengthRange } = resolvePostDepthMetadata(plan);
  return `
${buildSourceEvidenceBlock(trend)}
${buildAngleSpecificityBlock(plan)}
ASSIGNED BATCH PLAN:
- Claim provenance: ${plan.claimSource ?? 'LEGACY_TOPIC'}
- SELECTED CENTRAL CLAIM — PRESERVE THIS MEANING: ${centralClaim}
- This is the primary semantic contract for the post. Do not broaden it, substitute a different mechanism, reverse its conclusion, or change its audience implication.
- Angle: ${plan.angle}
- Optional hook hint: ${plan.hookStyle}
- Optional ending preference: ${plan.endingStyle} (use only when the Expression Mode and completed idea benefit from an explicit ending)
- Legacy layout hint: ${plan.layout} (subordinate to the Expression Mode; do not treat it as a required section sequence)
- Source topic (inspiration only): ${plan.sourceTopic ?? 'evergreen author expertise'}
- Rationale: ${plan.rationale}
${sourceLink ? `- Reference link (do not summarize unless directly relevant): ${sourceLink}` : ''}

DEPTH AND LENGTH CONTRACT:
- Depth class: ${depthClass}
- Soft guidance range: approximately ${targetLengthRange.min}–${targetLengthRange.max} characters
- The range guides drafting; it is not a quota. Information density and claim completeness determine when to stop.
- Do not add examples, checklists, qualifications, failure modes, CTAs, conclusions, or additional paragraphs merely to reach a target length.
- A concise LinkedIn-native post is explicitly allowed for COMPACT ideas. STANDARD ideas should develop only their necessary reasoning. DEEP ideas may use longer treatment when the assigned substance justifies it.
- Never exceed LinkedIn's hard 3,000-character maximum.

DEPTH PLAN — use as intellectual backbone, not a mandatory section template:
- Strongest observations (maximum three): ${depth?.strongestObservations.join(' | ') || '(none planned)'}
- Cause/mechanism: ${depth?.underlyingCauseOrMechanism ?? '(not planned)'}
- Deeper interpretation: ${depth?.deeperInterpretation ?? '(not planned)'}
- Consequence: ${depth?.meaningfulConsequence ?? '(not planned)'}
- Tension/qualification: ${depth?.usefulTensionOrQualification ?? '(not planned)'}
- Supported personal shift: ${depth?.personalPerspective.supported ? depth.personalPerspective.insight : '(unsupported; do not invent)'}
- Ending insight: ${depth?.endingInsight ?? '(natural stop allowed)'}
- Avoid ideas: ${depth?.avoidIdeas.join(' | ') || '(none listed)'}

The source is inspiration only. Transform it into an author-relevant ${plan.angle.replace(/_/g, ' ')} post.
Develop the SELECTED CENTRAL CLAIM above. Do not broaden it, replace it with a general topic summary, or introduce a second thesis.
This post exists to develop that claim, not to cover the broader category.
Every major paragraph must support, explain, challenge, illustrate, qualify, or apply it.
Do not turn it into a checklist of adjacent benefits, risks, best practices, or subtopics unless the selected angle, layout, or Expression Mode explicitly calls for a list or walkthrough. Depth on one relevant point is better than breadth.
Avoid category-introduction openings such as "When it comes to...", "X plays a crucial role", or "The importance of X cannot be overstated." Open from the claim, an observation, distinction, outcome, behavior, problem, or direct position as the Expression Mode requires.
Do NOT write a headline summary of the trend.
Interpret, do not enumerate: choose the strongest observations, group related symptoms, and explain what they reveal. Do not independently redesign the argument when the Depth Plan already supplies its backbone.
`;
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

  return `${buildAuthorBlock(author)}
${plan ? buildPlanBlock(plan) : ''}

Repair the post as a clean final draft while preserving its successful rhetorical shape.

Preserve the SELECTED CENTRAL CLAIM and its meaning, assigned angle, and verified facts.
Do not preserve sentence structure when it causes awkward or contradictory prose.
Address every listed issue.
Do not invent personal experiences, results, users, metrics, or project history.
The repaired output must read as one coherent post, not as patched fragments.


Fix the listed issues without normalizing the post into a standard essay structure.

Specifically:
- Remove repeated definitions and conclusions.
- Replace broad statements with concrete mechanisms or consequences.
- Preserve the selected Expression Mode, opening behavior, paragraph rhythm, and natural ending.
- Change only the sections needed to resolve the listed issues, plus minimal edits for coherence.
- Preserve natural whitespace and short paragraphs.
- Do not create a list unless the content genuinely benefits from one.
- Do not add a scenario, action steps, takeaway, CTA, question, or closing section unless a listed issue specifically requires it and the Expression Mode supports it.
- Ensure the body adds information beyond the image headline and bullet points.



ISSUES:
${formatStructuredIssues(structured)}

${isShortLengthRepair && plan ? `LENGTH REPAIR DEPTH CHECK:
Use the approved Depth Plan above. Identify which useful planned dimension is missing or underdeveloped, then add only that material. Do not invent a new adjacent argument or expand an idea that is already clear. Stop when the missing substance is complete; do not inflate the draft to reach the soft range.` : ''}

ORIGINAL POST:
${post.body}

${VARIED_FORMAT_RULES}
${HASHTAG_RULES}

Output valid JSON:
{
  "headline": "...",
  "subheadline": "...",
  "bulletPoints": [],
  "body": "...",
  "hashtags": "..."
}

${SPECIFICITY_RULES}
${LINKEDIN_LINE_FORMAT_RULES}

REPAIR SCOPE:
Fix only the identified issue. Preserve the rhetorical movement and stopping behavior of the selected Expression Mode. Do not add an example, action step, consequence, positive-outcome paragraph, or conclusion unless it is the specific missing element.
${plan ? buildExpressionModePromptBlock(plan.expressionMode, []) : ''}

${DEFAULT_EDITORIAL_RULES}`;
}

export function buildExpandSpecificityPrompt(
  post: GeneratedPostContent,
  specificity: SpecificityResult | undefined,
  author: AuthorContext,
  plan: BatchPostPlan,
): string {
  return `${buildAuthorBlock(author)}
${buildPlanBlock(plan, undefined)}
${SPECIFICITY_RULES}
${LINKEDIN_LINE_FORMAT_RULES}

Make this post concretely useful without changing the SELECTED CENTRAL CLAIM or expanding its rhetorical structure.

Current signals: ${(specificity?.signals ?? []).join(', ') || 'none'}
Missing signals: ${(specificity?.missing ?? []).join(', ') || 'unknown'}

Identify and add the single most valuable concrete detail: one precise mechanism, implementation fact, constraint, diagnostic observation, or causal relationship may be enough.
Preserve the selected Expression Mode, paragraph rhythm, opening, and ending behavior.
Do not add a scenario, consequence, action step, takeaway, or conclusion unless it is necessary to clarify the central claim.
Do not add a new paragraph when the detail can be integrated into an existing sentence.
Replace vague supporting material with the precise detail; do not keep generic sections around it merely to preserve length.

Do not invent metrics, customers, incidents, or personal experience.

CURRENT POST:
${post.body}

FINAL REPAIR AUTHORITY:
Fix only the identified specificity issue. Preserve the rhetorical movement and stopping behavior of the selected Expression Mode. Do not add an example, action step, consequence, positive-outcome paragraph, or conclusion unless that is the exact missing detail.
${buildExpressionModePromptBlock(plan.expressionMode, [])}

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
  return `Review the post as a senior technical editor and domain-generic argument reviewer.

Identify conceptual errors, misleading simplifications, unsupported guarantees,
and missing distinctions that materially affect technical accuracy.

Also judge information gain. A section advances the post only when it adds a new causal mechanism,
constraint, consequence, counterpoint, evidence item, decision-relevant implication, implementation
detail, or qualification that materially changes the claim. Transition words, synonym swaps, examples
that merely prove the thesis again, and checklists that restate it do not count as progression.

Distinguish claim → mechanism → new consequence → useful implication from an elaborated repetition of
claim → paraphrase → generic example → paraphrase with "because" → generic checklist.

Detect generic discourse by rhetorical structure, not exact phrases: broad category intro → vague tension
→ announced scenario → practical steps → balanced summary → engagement question. Do not penalize a concise,
dense post merely because it has few paragraphs. Longer posts must earn their length with information gain.

Do not reject a post merely because it is simplified.
Reject or warn when simplification changes the meaning or teaches an unsafe design.

Pay special attention to:
- authentication versus authorization
- tenant resolution and tenant isolation
- client-side UX restrictions versus server-side security boundaries
- entitlement enforcement versus audit logging or legal compliance
- queue concurrency versus duplicate prevention
- locks versus idempotency
- atomic usage counters versus periodic reconciliation
- environment parity versus shared infrastructure
- scalability versus consistency
- database isolation strategies
- conditional claims presented as universal outcomes
- unsupported personal implementation stories

${TECHNICAL_DISTINCTIONS}

AUTHOR CONTEXT:
${author.description.slice(0, 400)}

ASSIGNED ANGLE: ${plan.angle}
SOURCE TOPIC: ${plan.sourceTopic ?? 'evergreen'}
SELECTED CENTRAL CLAIM: ${plan.selectedCentralClaim ?? plan.centralClaim ?? plan.coreClaim ?? '(not supplied)'}

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
      "code": "auth_vs_authorization" | "tenant_isolation_confusion" | "token_auth_overclaim" | "frontend_security_claim" | "compliance_overclaim" | "audit_trail_overclaim" | "false_architecture_tradeoff" | "environment_isolation_error" | "idempotency_omitted" | "locking_overclaim" | "atomic_usage_omitted" | "background_job_overclaim" | "guaranteed_outcome" | "unsupported_personal_claim" | "REDUNDANT_EXPLANATION" | "LOW_INFORMATION_DENSITY" | "GENERIC_SCENARIO_STRUCTURE" | "GENERIC_CHECKLIST_EXPANSION" | "THESIS_RESTATEMENT" | "WEAK_ARGUMENT_PROGRESSION" | "GENERIC_ENGAGEMENT_ENDING" | "CLAIM_DRIFT" | "other",
      "severity": "warning" | "error",
      "excerpt": "short quote from post",
      "explanation": "why this is inaccurate or unsafe",
      "repairInstruction": "how to fix without inventing facts"
    }
  ]
}`;
}
