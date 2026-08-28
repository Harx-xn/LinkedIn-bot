import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import type {
  AuthorContext,
  BatchPostPlan,
  GeneratedPostContent,
  ImageContent,
  PostDepthPlan,
  PostLayout,
  QualityIssue,
  TechnicalReviewIssue,
  TechnicalReviewResult,
  TrendCandidate,
} from './generationTypes';
import {
  GHOSTWRITER_SYSTEM,
  DEFAULT_EDITORIAL_RULES,
  HASHTAG_RULES,
  LANGUAGE_RULES,
  SPECIFICITY_RULES,
  VARIED_FORMAT_RULES,
  buildAuthorBlock,
  buildExpandSpecificityPrompt,
  buildImageCopyPrompt,
  buildImageRepairPrompt,
  buildJsonRepairPrompt,
  buildPlanBlock,
  buildPlannedPostPrompt,
  buildRepairPrompt,
  buildTechnicalReviewPrompt,
} from './ghostwriterPrompts';
import {
  extractBalancedJsonObject,
  GeneratedOutputParseError,
  parseGeneratedJsonDetailed,
} from './ghostwriterJsonParser';
import { withDerivedPostDepth } from './postDepth';
import {
  batchPlanSchema,
  GENERATED_POST_OPENAI_JSON_SCHEMA,
  imageContentSchema,
  postDepthPlanSchema,
  technicalReviewSchema,
} from './ghostwriterSchemas';
import type { SpecificityResult } from './generationTypes';
import { buildDeterministicBatchPlan } from './ghostwriterBatchPlanner';
import { evaluateTopicCombination } from './ghostwriterQualityService';
import { MANUAL_PLANNING_OPENAI_JSON_SCHEMA, MANUAL_POST_OPENAI_JSON_SCHEMA } from './manualPost/manualPostSchemas';
import {
  assessSelectedClaim,
  canLockSelectedClaim,
  deriveNarrowCentralClaim,
  evaluateClaimSemanticFidelity,
  resolveClaimSource,
} from './claimNarrowingService';
import { buildExpressionModePromptBlock, buildExpressionModeSystemInstruction, expressionModeFromPrompt } from './expressionModeService';
import {
  FALLBACK_PROVENANCE,
  logFallbackProvenance,
  type FallbackProvenance,
} from './fallbackProvenanceService';
import {
  extractGeminiUsage,
  extractOpenAiUsage,
  trackAiProviderCall,
  withAiCostContext,
  type AiCostContext,
} from './costIntelligence/aiCostTrackingService';

dotenv.config();

const OPENAI_CONTENT_MODEL = process.env.OPENAI_CONTENT_MODEL || 'gpt-4o-mini';
const GEMINI_CONTENT_MODEL = process.env.GEMINI_CONTENT_MODEL || 'gemini-flash-latest';
const OPENAI_PLAN_TEMPERATURE = Number(process.env.OPENAI_PLAN_TEMPERATURE ?? 0.3);
const OPENAI_WRITE_TEMPERATURE = Number(process.env.OPENAI_WRITE_TEMPERATURE ?? 0.65);
const OPENAI_REPAIR_TEMPERATURE = Number(process.env.OPENAI_REPAIR_TEMPERATURE ?? 0.25);
const POST_MAX_OUTPUT_TOKENS = Number(process.env.POST_MAX_OUTPUT_TOKENS ?? 2200);
const PLAN_MAX_OUTPUT_TOKENS = Number(process.env.PLAN_MAX_OUTPUT_TOKENS ?? 3200);
const REVIEW_MAX_OUTPUT_TOKENS = Number(process.env.REVIEW_MAX_OUTPUT_TOKENS ?? 700);
const IMAGE_COPY_MAX_OUTPUT_TOKENS = Number(process.env.IMAGE_COPY_MAX_OUTPUT_TOKENS ?? 500);
const MAX_JSON_REPAIRS = 2;

const REVIEW_REPAIR_INSTRUCTIONS: Partial<Record<TechnicalReviewIssue['code'], string>> = {
  LOW_INFORMATION_DENSITY: 'Replace filler or thesis paraphrases with one concrete mechanism, constraint, consequence, or decision-relevant implication.',
  WEAK_ARGUMENT_PROGRESSION: 'Rebuild the support as claim → mechanism → new consequence or implication; each move must add information.',
  REDUNDANT_EXPLANATION: 'Remove paraphrased support and keep only the strongest distinct explanation or evidence.',
  GENERIC_SCENARIO_STRUCTURE: 'Remove the broad intro and staged hypothetical; state the specific claim and develop only material reasoning.',
  GENERIC_CHECKLIST_EXPANSION: 'Replace generic checklist items with the one implementation detail or decision rule that materially advances the claim.',
  THESIS_RESTATEMENT: 'Delete the restated thesis and use that space for a new qualification, consequence, or useful implication.',
  GENERIC_ENGAGEMENT_ENDING: 'End on the final substantive implication instead of a broad engagement question.',
  CLAIM_DRIFT: 'Restore the selected central claim and remove support for a substituted mechanism, conclusion, or audience implication.',
};

function derivedReviewIssue(
  code: TechnicalReviewIssue['code'],
  explanation: string,
  excerpt: string,
): TechnicalReviewIssue {
  return {
    code,
    severity: 'error',
    excerpt,
    explanation,
    repairInstruction: REVIEW_REPAIR_INSTRUCTIONS[code] ?? 'Repair only the identified issue without inventing facts.',
  };
}

function moreUsefulReviewText(current: string, incoming: string): string {
  const currentValue = current.trim();
  const incomingValue = incoming.trim();
  if (!currentValue) return incoming;
  if (!incomingValue) return current;
  return incomingValue.length > currentValue.length ? incoming : current;
}

/** Keep one issue per code while preserving the strongest available severity and detail. */
function mergeTechnicalReviewIssues(issues: TechnicalReviewIssue[]): TechnicalReviewIssue[] {
  const merged = new Map<TechnicalReviewIssue['code'], TechnicalReviewIssue>();
  for (const issue of issues) {
    const existing = merged.get(issue.code);
    if (!existing) {
      merged.set(issue.code, { ...issue });
      continue;
    }
    merged.set(issue.code, {
      code: issue.code,
      severity: existing.severity === 'error' || issue.severity === 'error' ? 'error' : 'warning',
      excerpt: moreUsefulReviewText(existing.excerpt, issue.excerpt),
      explanation: moreUsefulReviewText(existing.explanation, issue.explanation),
      repairInstruction: moreUsefulReviewText(existing.repairInstruction, issue.repairInstruction),
    });
  }
  return [...merged.values()];
}

/** Parse direct, fenced, or prose-wrapped reviewer JSON without another model call. */
export function parseTechnicalReviewOutput(raw: string, postExcerpt = ''): TechnicalReviewResult {
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const candidates = [cleaned, extractBalancedJsonObject(cleaned)].filter((value, index, all): value is string => (
    !!value && all.indexOf(value) === index
  ));

  for (const candidate of candidates) {
    try {
      const parsed = technicalReviewSchema.safeParse(JSON.parse(candidate));
      if (!parsed.success) continue;
      const data = parsed.data;
      let issues = mergeTechnicalReviewIssues(data.issues as TechnicalReviewIssue[]);
      const add = (code: TechnicalReviewIssue['code'], explanation: string) => {
        issues = mergeTechnicalReviewIssues([
          ...issues,
          derivedReviewIssue(code, explanation, postExcerpt.slice(0, 180)),
        ]);
      };
      if (data.informationDensity < 55) add('LOW_INFORMATION_DENSITY', 'Too much of the draft repeats or frames the idea without adding a material element.');
      if (data.progressionQuality < 55) add('WEAK_ARGUMENT_PROGRESSION', 'Major sections do not advance from claim into distinct reasoning and implication.');
      if (data.redundancyRisk > 55) add('REDUNDANT_EXPLANATION', 'Support sections paraphrase the same proposition instead of adding new information.');
      if (data.genericDiscourseRisk > 60) add('GENERIC_SCENARIO_STRUCTURE', 'The draft relies on a generic professional-article sequence rather than claim-specific reasoning.');
      if (data.claimFidelity < 65) add('CLAIM_DRIFT', 'The draft changes or broadens the selected central claim.');
      return {
        available: true,
        passed: data.passed && !issues.some((issue) => issue.severity === 'error'),
        confidence: data.confidence,
        informationDensity: data.informationDensity,
        progressionQuality: data.progressionQuality,
        redundancyRisk: data.redundancyRisk,
        genericDiscourseRisk: data.genericDiscourseRisk,
        claimFidelity: data.claimFidelity,
        issues,
      };
    } catch {
      // Try the balanced-object candidate before declaring the review unavailable.
    }
  }

  return { available: false, passed: false, confidence: 0, issues: [] };
}

export class ContentService {
  private geminiKeys: string[] = [];
  private currentKeyIndex = 0;
  private openai: OpenAI | null = null;
  private trackingIdentity: AiCostContext;

  constructor(keys?: { openaiApiKey?: string | null; geminiApiKeys?: string[] | null; userId?: string | null; regionId?: string | null; trackingContext?: AiCostContext }) {
    this.trackingIdentity = { userId: keys?.userId, regionId: keys?.regionId, ...(keys?.trackingContext ?? {}) };
    if (keys?.geminiApiKeys && keys.geminiApiKeys.length) {
      this.geminiKeys = keys.geminiApiKeys.filter(Boolean) as string[];
    } else {
      if (process.env.GEMINI_API_KEY) this.geminiKeys.push(process.env.GEMINI_API_KEY);
      if (process.env.GEMINI_API_KEY_2) this.geminiKeys.push(process.env.GEMINI_API_KEY_2);
      let i = 3;
      while (process.env[`GEMINI_API_KEY_${i}`]) {
        this.geminiKeys.push(process.env[`GEMINI_API_KEY_${i}`] as string);
        i++;
      }
    }

    const openaiKey = keys?.openaiApiKey || process.env.OPENAI_API_KEY;
    if (openaiKey) this.openai = new OpenAI({ apiKey: openaiKey });
  }

  private async createTrackedOpenAiCompletion(request: any): Promise<any> {
    if (!this.openai) throw new Error('OPENAI_API_KEY not found');
    return trackAiProviderCall({
      provider: 'OPENAI',
      model: String(request.model),
      identity: this.trackingIdentity,
      invoke: () => this.openai!.chat.completions.create(request),
      extractUsage: extractOpenAiUsage,
    });
  }

  private getGeminiModel(systemInstruction = GHOSTWRITER_SYSTEM) {
    const key = this.geminiKeys[this.currentKeyIndex] || 'dummy_key';
    const genAI = new GoogleGenerativeAI(key);
    return genAI.getGenerativeModel({ model: GEMINI_CONTENT_MODEL, systemInstruction });
  }

  private async generateWithFallback(
    prompt: string,
    provider: 'GEMINI' | 'OPENAI',
    temperature: number,
    maxOutputTokens?: number,
    fallbackProvenance?: Extract<FallbackProvenance, 'PLANNER_FALLBACK' | 'WRITER_FALLBACK'>,
    fallbackAlreadyReported = false,
  ): Promise<string> {
    try {
      if (provider === 'GEMINI') return await this.generateGeminiPost(prompt, temperature, 0, maxOutputTokens);
      return await this.generateOpensAiPost(prompt, temperature, maxOutputTokens);
    } catch (error) {
      console.warn(`[ghostwriter] Primary provider ${provider} failed, attempting fallback`);
      if (fallbackProvenance && !fallbackAlreadyReported) {
        logFallbackProvenance({
          provenance: fallbackProvenance,
          stage: 'provider_failover',
          reason: `primary_${provider.toLowerCase()}_failed`,
        });
      }
      if (provider === 'GEMINI' && this.openai) {
        return await this.generateOpensAiPost(prompt, temperature, maxOutputTokens);
      }
      if (provider === 'OPENAI' && this.geminiKeys.length > 0) {
        return await this.generateGeminiPost(prompt, temperature, 0, maxOutputTokens);
      }
      throw error;
    }
  }

  private logRejectedProviderOutput(
    provider: 'GEMINI' | 'OPENAI',
    result: Extract<ReturnType<typeof parseGeneratedJsonDetailed>, { ok: false }>,
    raw: string,
  ) {
    console.warn('[ghostwriter] provider output rejected', {
      provider,
      stage: result.stage,
      message: result.message,
      issues: result.issues,
      rawPreview: raw.slice(0, 240),
    });
  }

  private toGeneratedPostContent(
    parsed: Extract<ReturnType<typeof parseGeneratedJsonDetailed>, { ok: true }>['data'],
  ): GeneratedPostContent {
    return {
      ...parsed,
      bulletPoints: parsed.bulletPoints ?? [],
      layout: parsed.layout as PostLayout | undefined,
    };
  }

  async parseProviderOutput(
    raw: string,
    provider: 'GEMINI' | 'OPENAI',
    repairContext: string,
  ): Promise<{ content: GeneratedPostContent; jsonRepairAttempts: number }> {
    let result = parseGeneratedJsonDetailed(raw);
    if (result.ok) {
      return { content: this.toGeneratedPostContent(result.data), jsonRepairAttempts: 0 };
    }

    this.logRejectedProviderOutput(provider, result, raw);
    let jsonRepairAttempts = 0;
    let lastFailure = result;

    for (; jsonRepairAttempts < MAX_JSON_REPAIRS; jsonRepairAttempts++) {
      const repairPrompt = buildJsonRepairPrompt({
        repairContext,
        stage: lastFailure.stage,
        message: lastFailure.message,
        issues: lastFailure.issues,
        invalidOutput: raw,
      });
      const repairedRaw = await withAiCostContext({ agent: 'REPAIR', operation: 'JSON_REPAIR' }, () => this.generateWithFallback(repairPrompt, provider, OPENAI_REPAIR_TEMPERATURE));
      result = parseGeneratedJsonDetailed(repairedRaw);
      if (result.ok) {
        return { content: this.toGeneratedPostContent(result.data), jsonRepairAttempts: jsonRepairAttempts + 1 };
      }
      this.logRejectedProviderOutput(provider, result, repairedRaw);
      lastFailure = result;
      raw = repairedRaw;
    }

    throw new GeneratedOutputParseError(
      lastFailure.stage,
      lastFailure.message,
      lastFailure.issues ?? [],
    );
  }

  private async parseWithRepair(
    raw: string,
    provider: 'GEMINI' | 'OPENAI',
    repairContext: string,
  ): Promise<GeneratedPostContent> {
    const { content } = await this.parseProviderOutput(raw, provider, repairContext);
    return content;
  }

  async planBatch(
    trends: TrendCandidate[],
    author: AuthorContext,
    count: number,
    provider: 'GEMINI' | 'OPENAI' = 'OPENAI',
  ): Promise<BatchPostPlan[]> {
    const deterministic = buildDeterministicBatchPlan(trends.slice(0, count), count);

    const prompt = `${buildAuthorBlock(author)}

Create a batch plan for ${count} LinkedIn posts.

Available trends (inspiration only):
${trends.slice(0, count + 3).map((t, i) => `${i}: ${t.topic}`).join('\n')}

Rules:
- Distribute angles: technical_mistake, practical_tutorial, architecture_tradeoff, defensible_opinion, debugging_story, product_lesson, reflection
- Prefer a natural ending that stops when the argument is complete. Use a question, takeaway, action, or summary only when intentionally useful.
- No hook style repeated more than twice
- Do not repeat source topics unless necessary
- Build a compact Depth Plan that distinguishes observations, cause or mechanism, interpretation, consequence, qualification, supported personal shift, and ending insight.
- Prefer at most three strong observations followed by interpretation. Do not enumerate every plausible reason, benefit, or risk.
- For every post, narrow the topic into one arguable centralClaim. It must name a relationship, condition, mechanism, trade-off, or decision—not merely say the topic is important or beneficial.

Output JSON array only:
[
  {
    "trendIndex": 0,
    "sourceTopic": "...",
    "angle": "technical_mistake",
    "hookStyle": "observation",
    "endingStyle": "natural",
    "layout": "problem_mechanism_fix",
    "centralClaim": "A specific, debatable claim that the draft must preserve",
    "depthPlan": {
      "centralClaim": "same fixed claim",
      "whyThisClaimIsInteresting": "string or null",
      "strongestObservations": ["maximum three"],
      "underlyingCauseOrMechanism": "string or null",
      "deeperInterpretation": "string or null",
      "meaningfulConsequence": "string or null",
      "usefulTensionOrQualification": "string or null",
      "personalPerspective": { "supported": false, "insight": null },
      "endingInsight": "string or null",
      "avoidIdeas": ["redundant or obvious points"]
    },
    "rationale": "..."
  }
]`;

    try {
      const raw = await withAiCostContext({ agent: 'PLANNER', operation: 'BATCH_PLAN' }, () => this.generateWithFallback(prompt, provider, OPENAI_PLAN_TEMPERATURE, PLAN_MAX_OUTPUT_TOKENS, FALLBACK_PROVENANCE.PLANNER_FALLBACK));
      const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
      const json = JSON.parse(cleaned);
      const validated = batchPlanSchema.safeParse(json);
      if (validated.success && validated.data.length >= count) {
        console.log('[ghostwriter] AI batch plan accepted', { count: validated.data.length });
        return validated.data.slice(0, count) as BatchPostPlan[];
      }
      console.warn('[ghostwriter] AI batch plan invalid; using deterministic plan');
      logFallbackProvenance({ provenance: FALLBACK_PROVENANCE.PLANNER_FALLBACK, stage: 'batch_plan', reason: 'invalid_planner_output' });
    } catch (err) {
      console.warn('[ghostwriter] AI batch plan failed; using deterministic plan', err);
      logFallbackProvenance({ provenance: FALLBACK_PROVENANCE.PLANNER_FALLBACK, stage: 'batch_plan', reason: 'planner_call_failed' });
    }

    return deterministic;
  }

  async narrowBatchClaims(
    plans: BatchPostPlan[],
    trends: TrendCandidate[],
    author: AuthorContext,
    provider: 'GEMINI' | 'OPENAI' = 'OPENAI',
  ): Promise<BatchPostPlan[]> {
    const preparedPlans = plans.map((plan, index) => {
      const trend = trends[index];
      const claimSource = plan.claimSource ?? resolveClaimSource(trend);
      const selectedCentralClaim = plan.selectedCentralClaim
        ?? (claimSource === 'STRATEGY_SELECTED' ? trend?.topic?.trim() : undefined)
        ?? plan.centralClaim
        ?? plan.coreClaim
        ?? trend?.topic?.trim();
      return { ...plan, claimSource, selectedCentralClaim };
    });

    const applyClaim = (
      plan: BatchPostPlan,
      centralClaim: string,
      depthPlan?: PostDepthPlan,
    ): BatchPostPlan => ({
      ...plan,
      centralClaim,
      depthPlan: depthPlan
        ? { ...depthPlan, centralClaim }
        : plan.depthPlan
          ? { ...plan.depthPlan, centralClaim }
          : {
              centralClaim,
              whyThisClaimIsInteresting: null,
              strongestObservations: [],
              underlyingCauseOrMechanism: null,
              deeperInterpretation: null,
              meaningfulConsequence: null,
              usefulTensionOrQualification: null,
              personalPerspective: { supported: false, insight: null },
              endingInsight: null,
              avoidIdeas: [],
            },
    });

    const fallbackTopic = (plan: BatchPostPlan, trend?: TrendCandidate): string => {
      if (trend?.territory?.trim()) return trend.territory.trim();
      if (plan.normalizedTopic?.trim()) return plan.normalizedTopic.trim();
      if (trend?.matchedPillar?.trim()) return trend.matchedPillar.trim();
      if (plan.claimSource === 'STRATEGY_SELECTED') return 'the selected approach';
      return plan.sourceTopic ?? trend?.topic ?? 'the topic';
    };

    const fallbackClaim = (plan: BatchPostPlan, trend?: TrendCandidate): string => {
      const selected = plan.selectedCentralClaim?.trim() ?? '';
      if (plan.claimSource === 'STRATEGY_SELECTED' && canLockSelectedClaim(selected, trend)) return selected;
      if (assessSelectedClaim(plan.centralClaim ?? '').usable) return plan.centralClaim!.trim();
      return deriveNarrowCentralClaim({
        topic: fallbackTopic(plan, trend),
        candidateClaim: selected || plan.centralClaim || plan.coreClaim,
        angle: plan.angle,
        expressionMode: plan.expressionMode,
        author,
        resolvedAudience: plan.resolvedAudience ?? [],
        candidateMechanism: plan.mechanismFocus?.join(' ') || trend?.fingerprint?.mechanisms.join(' '),
        sourceEvidence: [trend?.summary, ...(trend?.keyPoints ?? [])].filter(Boolean).join(' '),
      });
    };

    const fallback = () => preparedPlans.map((plan, index) => withDerivedPostDepth(
      applyClaim(plan, fallbackClaim(plan, trends[index])),
      trends[index],
    ));
    const prompt = `${buildAuthorBlock(author)}

Build a compact supporting-reasoning plan for each selected batch item.

CLAIM PROVENANCE RULES:
- STRATEGY_SELECTED means the central claim was intentionally selected upstream. Preserve it exactly unless it is malformed, factually unsafe, internally contradictory, too vague to write, grammatically broken, or unsupported by mandatory source evidence.
- If a STRATEGY_SELECTED claim needs correction, keep the same intended subject, mechanism, direction, and audience implication. Do not broaden it into a category summary or replace it with a different conclusion.
- SEARCH_DISCOVERED and LEGACY_TOPIC inputs may still be narrowed from source material into one publishable claim.
- Use the same planning response to add supporting reasoning. Do not create a separate claim-review task.

${preparedPlans.map((plan, index) => {
  const trend = trends[index];
  return `${index}. CLAIM SOURCE: ${plan.claimSource}
SELECTED CENTRAL CLAIM: ${plan.selectedCentralClaim ?? '(none; derive one from source material)'}
SOURCE TOPIC: ${plan.sourceTopic ?? trend?.topic ?? 'evergreen author expertise'}
ANGLE: ${plan.angle}
EXPRESSION MODE: ${plan.expressionMode ?? 'direct'}
EXPECTED MECHANISM: ${(plan.mechanismFocus ?? trend?.fingerprint?.mechanisms ?? []).join(' | ') || 'not specified'}
SOURCE SUMMARY: ${trend?.summary?.trim() || 'none; use conditional or observational wording'}
SOURCE POINTS: ${(trend?.keyPoints ?? []).join(' | ') || 'none'}`;
}).join('\n\n')}

Rules:
- Use the author's niche, positioning, audience pains, desired outcomes, pillars, and available source evidence.
- Preserve a usable STRATEGY_SELECTED claim as the primary semantic contract. Enrich its reasoning instead of making it "narrower" again.
- A newly derived or corrected claim must assert one cause-and-effect relationship, distinction, behavior, process failure, decision rule, trade-off, constraint, misconception, consequence, condition, or non-obvious observation that fits its domain.
- Do not merely say the topic is important, essential, beneficial, efficient, reduces risk, or drives success.
- Do not force software or technical vocabulary onto non-technical domains.
- Do not invent personal experience, outcomes, statistics, medical/financial/legal facts, or named results. Use conditional framing where evidence is limited.
- Do not change the selected mechanism, conclusion, or audience implication merely to make claims in the batch look different.
- For each claim, return a compact Depth Plan with only the reasoning this idea needs. A compact plan may contain just the central claim, one observation or mechanism, and one implication.
- Optional depth fields may be null or omitted. Use at most three observations.
- Attempt one useful interpretation beyond surface advice, but do not manufacture complexity when a simple mechanism is enough.
- Set personalPerspective.supported to true only when the supplied author profile or source evidence directly supports that intellectual shift; otherwise return false and null.
- Put obvious restatements, exhaustive adjacent points, and generic recommendations in avoidIdeas.
- Return exactly one claim per indexed topic.

Output one JSON object only:
{"claims":[{"index":0,"centralClaim":"preserved or faithfully corrected claim","correctionReason":"null or concise reason","depthPlan":{"centralClaim":"same claim","strongestObservations":["optional; maximum three"],"underlyingCauseOrMechanism":"optional string","meaningfulConsequence":"optional string"}}]}`;

    try {
      const raw = await withAiCostContext({ agent: 'PLANNER', operation: 'BATCH_PLAN' }, () => this.generateWithFallback(prompt, provider, OPENAI_PLAN_TEMPERATURE, PLAN_MAX_OUTPUT_TOKENS, FALLBACK_PROVENANCE.PLANNER_FALLBACK));
      const parsed = JSON.parse(raw.replace(/```json/gi, '').replace(/```/g, '').trim());
      const items = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.claims)
          ? parsed.claims
          : Array.isArray(parsed?.centralClaims)
            ? parsed.centralClaims
            : null;
      if (!items) {
        logFallbackProvenance({ provenance: FALLBACK_PROVENANCE.PLANNER_FALLBACK, stage: 'claim_planning', reason: 'invalid_claim_plan' });
        return fallback();
      }
      return preparedPlans.map((plan, index) => {
        const item = items.find((candidate: unknown) => Number((candidate as { index?: unknown })?.index) === index);
        const candidate = typeof item?.centralClaim === 'string' ? item.centralClaim.trim() : '';
        const selected = plan.selectedCentralClaim?.trim() ?? '';
        const locked = plan.claimSource === 'STRATEGY_SELECTED' && canLockSelectedClaim(selected, trends[index]);
        let centralClaim: string;
        let usePlannedDepth = true;
        if (locked) {
          centralClaim = selected;
          if (candidate && candidate !== selected) {
            const fidelity = evaluateClaimSemanticFidelity(selected, candidate, plan.mechanismFocus);
            usePlannedDepth = fidelity.faithful;
            console.warn('[ghostwriter] restored strategy-selected claim after planner rewrite', {
              index,
              faithfulRewrite: fidelity.faithful,
              reasons: fidelity.reasons,
            });
          }
        } else if (candidate && assessSelectedClaim(candidate).usable) {
          const fidelity = plan.claimSource === 'STRATEGY_SELECTED' && selected
            ? evaluateClaimSemanticFidelity(selected, candidate, plan.mechanismFocus)
            : { faithful: true, reasons: [] as string[], selectedTokenCoverage: 1 };
          centralClaim = fidelity.faithful ? candidate : fallbackClaim(plan, trends[index]);
          usePlannedDepth = fidelity.faithful;
        } else {
          centralClaim = fallbackClaim(plan, trends[index]);
          usePlannedDepth = false;
        }
        const parsedDepthPlan = postDepthPlanSchema.safeParse(item?.depthPlan);
        return withDerivedPostDepth(
          applyClaim(plan, centralClaim, parsedDepthPlan.success && usePlannedDepth ? parsedDepthPlan.data : undefined),
          trends[index],
        );
      });
    } catch (error) {
      console.warn('[ghostwriter] central claim planning failed; using non-blocking fallback', { message: error instanceof Error ? error.message : String(error) });
      logFallbackProvenance({ provenance: FALLBACK_PROVENANCE.PLANNER_FALLBACK, stage: 'claim_planning', reason: 'claim_planner_failed' });
      return fallback();
    }
  }

  async generatePlannedPost(
    plan: BatchPostPlan,
    author: AuthorContext,
    sourceLink = '',
    provider: 'GEMINI' | 'OPENAI' = 'OPENAI',
    trend?: TrendCandidate | null,
    recentPosts: string[] = [],
  ): Promise<GeneratedPostContent> {
    const prompt = buildPlannedPostPrompt(plan, author, sourceLink, trend, recentPosts);

    const raw = await withAiCostContext({ agent: 'WRITER', operation: 'BATCH_WRITE' }, () => this.generateStructuredPost(prompt, provider, OPENAI_WRITE_TEMPERATURE));
    const parsed = await this.parseWithRepair(raw, provider, prompt);
    return {
      ...parsed,
      sourceTopic: plan.sourceTopic,
      angle: plan.angle,
      layout: plan.layout,
    };
  }

  async expandSpecificity(
    post: GeneratedPostContent,
    specificity: SpecificityResult | undefined,
    author: AuthorContext,
    plan: BatchPostPlan,
    provider: 'GEMINI' | 'OPENAI' = 'OPENAI',
  ): Promise<GeneratedPostContent> {
    const prompt = buildExpandSpecificityPrompt(post, specificity, author, plan);
    const raw = await withAiCostContext({ agent: 'REPAIR', operation: 'BATCH_REPAIR' }, () => this.generateStructuredPost(prompt, provider, OPENAI_REPAIR_TEMPERATURE));
    return this.parseWithRepair(raw, provider, prompt);
  }

  private async generateStructuredPost(
    prompt: string,
    provider: 'GEMINI' | 'OPENAI',
    temperature: number,
  ): Promise<string> {
    let fallbackAlreadyReported = false;
    if (provider === 'OPENAI' && this.openai) {
      try {
        return await this.generateOpenAiStructuredPost(prompt, temperature);
      } catch (err) {
        console.warn('[ghostwriter] OpenAI structured output failed; falling back', {
          message: err instanceof Error ? err.message : String(err),
        });
        logFallbackProvenance({ provenance: FALLBACK_PROVENANCE.WRITER_FALLBACK, stage: 'structured_writer', reason: 'structured_output_failed' });
        fallbackAlreadyReported = true;
      }
    }
    return this.generateWithFallback(
      prompt,
      provider,
      temperature,
      POST_MAX_OUTPUT_TOKENS,
      FALLBACK_PROVENANCE.WRITER_FALLBACK,
      fallbackAlreadyReported,
    );
  }

  hasProvider(provider: 'GEMINI' | 'OPENAI'): boolean {
    if (provider === 'OPENAI') return !!this.openai;
    return this.geminiKeys.length > 0;
  }

  async generateManualPost(
    input: {
      topic: string;
      additionalInstructions?: string;
      tone: string;
      description: string;
      niches?: string[];
    },
    provider: 'GEMINI' | 'OPENAI' = 'OPENAI',
  ): Promise<GeneratedPostContent> {
    const author: AuthorContext = {
      description: input.description,
      tone: input.tone,
      niches: input.niches ?? [],
    };

    const extraInstructions = input.additionalInstructions?.trim()
      ? `\nAdditional user instructions:\n${input.additionalInstructions.trim()}`
      : '';

    const prompt = `${buildAuthorBlock(author)}

Write an original LinkedIn post for the manual composer based on this topic or instruction:
${input.topic.trim()}
${extraInstructions}

Requirements:
- Follow the configured author voice and expertise.
- Use a strong but non-clickbait hook in the first lines.
- Provide useful specificity and practical insight.
- Do not invent statistics, customers, incidents, or personal experiences.
- Avoid excessive one-line fragments and unnecessary emojis.
- Avoid repetitive generic AI phrasing.
- Let the complexity of the idea determine the natural length. Do not pad the post.
- Do not use Markdown bold markers or double asterisks.
- A compact post is valid when it completes the idea with high information density; LinkedIn's 3,000-character maximum remains hard.
- Use hashtags only when they add value.

${SPECIFICITY_RULES}
${VARIED_FORMAT_RULES}
${HASHTAG_RULES}
${LANGUAGE_RULES}

Output MUST be valid JSON with headline, subheadline, bulletPoints, body, and hashtags.`;

    const raw = await withAiCostContext({ agent: 'WRITER', operation: 'MANUAL_GENERATE' }, () => this.generateStructuredPost(prompt, provider, OPENAI_WRITE_TEMPERATURE));
    const parsed = await this.parseWithRepair(raw, provider, prompt);
    return {
      ...parsed,
      sourceTopic: input.topic.trim(),
    };
  }

  async generatePost(
    topic: string,
    articleLink: string,
    provider: 'GEMINI' | 'OPENAI' = 'OPENAI',
    tone: string = 'Conversational',
    description: string = '',
    niches: string[] = [],
  ): Promise<GeneratedPostContent> {
    const author: AuthorContext = { description, tone, niches };
    const plan: BatchPostPlan = {
      trendIndex: 0,
      sourceTopic: topic,
      angle: 'product_lesson',
      hookStyle: 'observation',
      endingStyle: 'takeaway',
      layout: 'short_observation',
      rationale: 'Single-post generation fallback',
    };
    return this.generatePlannedPost(plan, author, articleLink, provider);
  }

  async generateMixedPost(
    trends: { topic: string; link: string }[],
    provider: 'GEMINI' | 'OPENAI' = 'OPENAI',
    tone: string = 'Conversational',
    description: string = '',
    niches: string[] = [],
  ): Promise<GeneratedPostContent> {
    const author: AuthorContext = { description, tone, niches };
    if (trends.length < 2) {
      const t = trends[0];
      return this.generatePost(t.topic, t.link, provider, tone, description, niches);
    }

    const combine = evaluateTopicCombination(trends[0].topic, trends[1].topic, author);
    if (!combine.canCombine) {
      console.warn('[ghostwriter] Mixed topics rejected', { reason: combine.reason });
      return this.generatePost(trends[0].topic, trends[0].link, provider, tone, description, niches);
    }

    const plan: BatchPostPlan = {
      trendIndex: null,
      sourceTopic: `${trends[0].topic} + ${trends[1].topic}`,
      angle: 'architecture_tradeoff',
      hookStyle: 'comparison',
      endingStyle: 'takeaway',
      layout: 'comparison',
      rationale: combine.connection ?? 'Related topics with defensible connection',
    };

    const links = trends.map((t) => `- ${t.topic}: ${t.link}`).join('\n');
    const prompt = `${buildAuthorBlock(author)}
${buildPlanBlock(plan)}

Only combine these topics because: ${combine.connection}
References:
${links}

${VARIED_FORMAT_RULES}
${HASHTAG_RULES}
${LANGUAGE_RULES}

Output valid JSON with headline, subheadline, bulletPoints, body, hashtags.`;

    const raw = await withAiCostContext({ agent: 'WRITER', operation: 'BATCH_WRITE' }, () => this.generateWithFallback(prompt, provider, OPENAI_WRITE_TEMPERATURE));
    return this.parseWithRepair(raw, provider, prompt);
  }

  async repairPost(
    post: GeneratedPostContent,
    reasons: Array<string | QualityIssue | TechnicalReviewIssue>,
    author: AuthorContext,
    provider: 'GEMINI' | 'OPENAI' = 'OPENAI',
    plan?: BatchPostPlan,
  ): Promise<GeneratedPostContent> {
    const prompt = buildRepairPrompt(post, reasons, author, plan);
    const raw = await withAiCostContext({ agent: 'REPAIR', operation: 'BATCH_REPAIR' }, () => this.generateStructuredPost(prompt, provider, OPENAI_REPAIR_TEMPERATURE));
    return this.parseWithRepair(raw, provider, prompt);
  }

  async reviewTechnicalClaims(
    post: GeneratedPostContent,
    author: AuthorContext,
    plan: BatchPostPlan,
    provider: 'GEMINI' | 'OPENAI' = 'OPENAI',
  ): Promise<TechnicalReviewResult> {
    const prompt = buildTechnicalReviewPrompt(post, author, plan);
    const raw = await withAiCostContext({ agent: 'REVIEWER', operation: 'BATCH_REVIEW' }, () => this.generateWithFallback(prompt, provider, OPENAI_REPAIR_TEMPERATURE, REVIEW_MAX_OUTPUT_TOKENS));
    const review = parseTechnicalReviewOutput(raw, post.body);
    if (!review.available) {
      console.warn('[ghostwriter] technical/quality review unavailable; using deterministic validation');
    }
    return review;
  }

  async generateImageCopy(
    approvedBody: string,
    plan: BatchPostPlan,
    provider: 'GEMINI' | 'OPENAI' = 'OPENAI',
  ): Promise<ImageContent | null> {
    const prompt = buildImageCopyPrompt(approvedBody, plan);
    const raw = await withAiCostContext({ agent: 'IMAGE_GENERATOR', operation: 'IMAGE_COPY_GENERATE' }, () => this.generateWithFallback(prompt, provider, OPENAI_REPAIR_TEMPERATURE, IMAGE_COPY_MAX_OUTPUT_TOKENS));
    const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    try {
      const parsed = imageContentSchema.safeParse(JSON.parse(cleaned));
      if (parsed.success) return parsed.data;
    } catch {
      // fall through
    }
    return null;
  }

  async repairImageCopy(
    approvedBody: string,
    image: ImageContent,
    issues: QualityIssue[],
    provider: 'GEMINI' | 'OPENAI' = 'OPENAI',
  ): Promise<ImageContent | null> {
    const prompt = buildImageRepairPrompt(approvedBody, image, issues);
    const raw = await withAiCostContext({ agent: 'REPAIR', operation: 'IMAGE_COPY_REPAIR' }, () => this.generateWithFallback(prompt, provider, OPENAI_REPAIR_TEMPERATURE, IMAGE_COPY_MAX_OUTPUT_TOKENS));
    const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    try {
      const parsed = imageContentSchema.safeParse(JSON.parse(cleaned));
      if (parsed.success) return parsed.data;
    } catch {
      // fall through
    }
    return null;
  }

  /**
   * Manual-composer only. Returns raw provider text without batch parsing.
   */
  async fetchComposerGenerationRaw(
    prompt: string,
    provider: 'GEMINI' | 'OPENAI' = 'OPENAI',
  ): Promise<string> {
    if (provider === 'OPENAI' && this.openai) {
      try {
        return await this.generateOpenAiManualStructuredPost(prompt, OPENAI_WRITE_TEMPERATURE);
      } catch (err) {
        console.warn('[manual-post-v2] OpenAI manual structured output failed; falling back', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return this.generateWithFallback(prompt, provider, OPENAI_WRITE_TEMPERATURE);
  }

  /** Manual planning only. Uses the angles schema rather than the final-post schema. */
  async fetchComposerPlanningRaw(
    prompt: string,
    provider: 'GEMINI' | 'OPENAI' = 'OPENAI',
  ): Promise<string> {
    try {
      if (provider === 'OPENAI') return await this.generateOpenAiManualPlanning(prompt);
      return await this.generateGeminiPost(prompt, OPENAI_PLAN_TEMPERATURE, 0, PLAN_MAX_OUTPUT_TOKENS);
    } catch (error) {
      console.warn(`[manual-post-v2] Primary planning provider ${provider} failed, attempting fallback`, {
        message: error instanceof Error ? error.message : String(error),
      });
      if (provider === 'OPENAI' && this.geminiKeys.length > 0) {
        return this.generateGeminiPost(prompt, OPENAI_PLAN_TEMPERATURE, 0, PLAN_MAX_OUTPUT_TOKENS);
      }
      if (provider === 'GEMINI' && this.openai) {
        return this.generateOpenAiManualPlanning(prompt);
      }
      throw error;
    }
  }

  /**
   * Generic JSON transport for non-post product features. Unlike the manual
   * composer transport, this does not force the manual-post JSON schema.
   */
  async fetchJsonRaw(
    prompt: string,
    provider: 'GEMINI' | 'OPENAI' = 'OPENAI',
    maxOutputTokens = POST_MAX_OUTPUT_TOKENS,
  ): Promise<string> {
    try {
      if (provider === 'OPENAI') return await this.generateOpenAiGenericJson(prompt, maxOutputTokens);
      return await this.generateGeminiPost(prompt, OPENAI_REPAIR_TEMPERATURE, 0, maxOutputTokens);
    } catch (error) {
      console.warn(`[structured-json] Primary provider ${provider} failed, attempting fallback`, {
        message: error instanceof Error ? error.message : String(error),
      });
      if (provider === 'OPENAI' && this.geminiKeys.length > 0) {
        return this.generateGeminiPost(prompt, OPENAI_REPAIR_TEMPERATURE, 0, maxOutputTokens);
      }
      if (provider === 'GEMINI' && this.openai) {
        return this.generateOpenAiGenericJson(prompt, maxOutputTokens);
      }
      throw error;
    }
  }

  private async generateOpenAiGenericJson(prompt: string, maxOutputTokens: number): Promise<string> {
    if (!this.openai) throw new Error('OPENAI_API_KEY not found');
    const response = await this.createTrackedOpenAiCompletion({
      model: OPENAI_CONTENT_MODEL,
      temperature: OPENAI_REPAIR_TEMPERATURE,
      max_completion_tokens: maxOutputTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Return only valid JSON matching the user-requested shape. Do not add fields from unrelated tasks.' },
        { role: 'user', content: prompt },
      ],
    });
    return response.choices[0].message.content || '';
  }

  /**
   * Manual-composer only. Returns raw provider text without batch parsing.
   */
  async fetchComposerRewriteRaw(
    prompt: string,
    provider: 'GEMINI' | 'OPENAI' = 'OPENAI',
    maxOutputTokens?: number,
  ): Promise<string> {
    return this.generateWithFallback(prompt, provider, OPENAI_WRITE_TEMPERATURE, maxOutputTokens);
  }

  /**
   * Manual-composer only. Used for manual JSON repair attempts.
   */
  async fetchComposerRepairRaw(
    prompt: string,
    provider: 'GEMINI' | 'OPENAI' = 'OPENAI',
  ): Promise<string> {
    return this.generateWithFallback(prompt, provider, OPENAI_REPAIR_TEMPERATURE);
  }

  /**
   * Manual-composer only. Batch generation must not call this method.
   * Runs a pre-built manual prompt through structured generation + JSON repair.
   */
  async executeComposerGenerationPrompt(
    prompt: string,
    provider: 'GEMINI' | 'OPENAI' = 'OPENAI',
  ): Promise<GeneratedPostContent> {
    const raw = await withAiCostContext({ agent: 'WRITER', operation: 'MANUAL_GENERATE' }, () => this.generateStructuredPost(prompt, provider, OPENAI_WRITE_TEMPERATURE));
    return this.parseWithRepair(raw, provider, prompt);
  }

  /**
   * Manual-composer only. Batch generation must not call this method.
   * Runs a pre-built manual rewrite prompt through provider fallback + JSON repair.
   */
  async executeComposerRewritePrompt(
    prompt: string,
    provider: 'GEMINI' | 'OPENAI' = 'OPENAI',
  ): Promise<GeneratedPostContent> {
    const raw = await withAiCostContext({ agent: 'WRITER', operation: 'MANUAL_REWRITE' }, () => this.generateWithFallback(prompt, provider, OPENAI_WRITE_TEMPERATURE));
    return this.parseWithRepair(raw, provider, prompt);
  }

  async rewritePost(
    currentContent: string,
    suggestions: string,
    provider: 'GEMINI' | 'OPENAI' = 'OPENAI',
    tone: string = 'Conversational',
    description: string = '',
    strategy?: AuthorContext['strategy'],
  ): Promise<GeneratedPostContent> {
    const author: AuthorContext = { description, tone, strategy };
    console.log("rewriting post")
    const prompt = `${buildAuthorBlock(author)}

CURRENT POST:
${currentContent}

MANDATORY USER REWRITE INSTRUCTIONS:
"""
${suggestions || 'Improve clarity, specificity, and technical accuracy while keeping the same topic.'}
"""

Rules:
- The mandatory user rewrite instructions above are the highest priority for this rewrite.
- Follow every concrete instruction from the user.
- Do not ignore, soften, reinterpret, or only partially apply the user instructions.
- If the user asks for a specific structure, length, tone, format, hook, CTA, or wording style, obey it.
- Keep the same core topic unless the user explicitly asks to change it.
- Do not invent unverifiable facts or unsupported first-person claims.
- Contact/website lines are controlled by app settings; do not add or preserve them unless suggestions explicitly ask.
- Before returning JSON, verify that the rewritten post clearly satisfies the mandatory user instructions.
${VARIED_FORMAT_RULES}
${HASHTAG_RULES}
${LANGUAGE_RULES}

Output valid JSON with headline, subheadline, bulletPoints, body, hashtags.`;

    const raw = await withAiCostContext({ agent: 'WRITER', operation: 'MANUAL_REWRITE' }, () => this.generateWithFallback(prompt, provider, OPENAI_WRITE_TEMPERATURE));
    return this.parseWithRepair(raw, provider, prompt);
  }

  private async generateOpenAiManualStructuredPost(prompt: string, temperature: number): Promise<string> {
    if (!this.openai) throw new Error('OPENAI_API_KEY not found');
    const response = await this.createTrackedOpenAiCompletion({
      model: OPENAI_CONTENT_MODEL,
      temperature,
      max_completion_tokens: POST_MAX_OUTPUT_TOKENS,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'manual_post',
          strict: true,
          schema: MANUAL_POST_OPENAI_JSON_SCHEMA,
        },
      },
      messages: [
        {
          role: 'system',
          content: `You are a LinkedIn manual post composer. Return JSON only matching the requested schema.\n${buildExpressionModeSystemInstruction(expressionModeFromPrompt(prompt))}`,
        },
        { role: 'user', content: prompt },
      ],
    });
    return response.choices[0].message.content || '';
  }

  private async generateOpenAiManualPlanning(prompt: string): Promise<string> {
    if (!this.openai) throw new Error('OPENAI_API_KEY not found');
    const response = await this.createTrackedOpenAiCompletion({
      model: OPENAI_CONTENT_MODEL,
      temperature: OPENAI_PLAN_TEMPERATURE,
      max_completion_tokens: PLAN_MAX_OUTPUT_TOKENS,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'manual_post_planning',
          strict: true,
          schema: MANUAL_PLANNING_OPENAI_JSON_SCHEMA,
        },
      },
      messages: [
        { role: 'system', content: 'You are a LinkedIn content planner. Return JSON only matching the requested planning schema.' },
        { role: 'user', content: prompt },
      ],
    });
    return response.choices[0].message.content || '';
  }

  private async generateOpenAiStructuredPost(prompt: string, temperature: number): Promise<string> {
    if (!this.openai) throw new Error('OPENAI_API_KEY not found');
    const response = await this.createTrackedOpenAiCompletion({
      model: OPENAI_CONTENT_MODEL,
      temperature,
      max_completion_tokens: POST_MAX_OUTPUT_TOKENS,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'generated_post',
          strict: true,
          schema: GENERATED_POST_OPENAI_JSON_SCHEMA,
        },
      },
      messages: [
        { role: 'system', content: GHOSTWRITER_SYSTEM },
        { role: 'user', content: prompt },
      ],
    });
    return response.choices[0].message.content || '';
  }

  private async generateGeminiPost(prompt: string, temperature: number, retryCount = 0, maxOutputTokens?: number): Promise<string> {
    if (this.geminiKeys.length === 0) {
      return `[MOCK] Gemini Post. (Set GEMINI_API_KEY)`;
    }

    try {
      const model = this.getGeminiModel();
      const response = await trackAiProviderCall({
        provider: 'GEMINI',
        model: GEMINI_CONTENT_MODEL,
        identity: this.trackingIdentity,
        invoke: async () => {
          const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
              temperature,
              responseMimeType: 'application/json',
              ...(maxOutputTokens ? { maxOutputTokens } : {}),
            },
          });
          return result.response;
        },
        extractUsage: extractGeminiUsage,
      });
      return response.text();
    } catch (error: any) {
      if (error?.status === 429) {
        if (this.geminiKeys.length > 1 && retryCount < this.geminiKeys.length) {
          this.currentKeyIndex = (this.currentKeyIndex + 1) % this.geminiKeys.length;
          return this.generateGeminiPost(prompt, temperature, retryCount + 1, maxOutputTokens);
        }
        if (retryCount < 3) {
          await new Promise((r) => setTimeout(r, 30000));
          return this.generateGeminiPost(prompt, temperature, retryCount + 1, maxOutputTokens);
        }
      }
      throw error;
    }
  }

  private async generateOpensAiPost(prompt: string, temperature: number, maxOutputTokens?: number): Promise<string> {
    if (!this.openai) throw new Error('OPENAI_API_KEY not found');
    const response = await this.createTrackedOpenAiCompletion({
      model: OPENAI_CONTENT_MODEL,
      temperature,
      ...(maxOutputTokens ? { max_completion_tokens: maxOutputTokens } : {}),
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: GHOSTWRITER_SYSTEM },
        { role: 'user', content: prompt },
      ],
    });
    return response.choices[0].message.content || '';
  }
}
