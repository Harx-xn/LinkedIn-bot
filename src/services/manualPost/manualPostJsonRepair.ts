import type { ContentService } from '../contentService';
import type { ContentProvider } from '../manualPostAiService';
import { parseManualJsonDetailed } from './manualPostJsonParser';
import type { ManualGeneratedPost, ManualJsonParseResult, ManualProviderCallBudget } from './manualPostTypes';
import { withAiCostContext } from '../costIntelligence/aiCostTrackingService';

const MAX_MANUAL_JSON_REPAIRS = 1;

export function buildManualJsonRepairPrompt(params: {
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
  "contentPlan": {
    "angle": "string",
    "coreClaim": "string",
    "audience": "string",
    "structure": "string",
    "hookType": "string",
    "evidenceType": "string",
    "ctaType": "string"
  },
  "hook": "string",
  "body": "string (min 40 chars)",
  "closingLine": "string",
  "hashtags": ["#Tag1", "#Tag2"],
  "sourceTopic": "string"
}`;
}

function logRejectedManualOutput(
  provider: ContentProvider,
  result: Extract<ManualJsonParseResult, { ok: false }>,
) {
  console.warn('[manual-post-v2] provider output rejected', {
    provider,
    stage: result.stage,
    message: result.message,
    issueCount: result.issues?.length ?? 0,
    issues: result.issues?.slice(0, 5) ?? ['unknown_normalization_failure'],
  });
}

export async function parseManualProviderOutputWithRepair(
  contentService: ContentService,
  raw: string,
  provider: ContentProvider,
  repairContext: string,
  budget?: ManualProviderCallBudget,
): Promise<ManualGeneratedPost> {
  let result = parseManualJsonDetailed(raw);
  if (result.ok) return result.data;

  logRejectedManualOutput(provider, result);
  let lastFailure = result;
  let lastRaw = raw;

  for (let attempt = 0; attempt < MAX_MANUAL_JSON_REPAIRS; attempt++) {
    const repairPrompt = buildManualJsonRepairPrompt({
      repairContext,
      stage: lastFailure.stage,
      message: lastFailure.message,
      issues: lastFailure.issues,
      invalidOutput: lastRaw,
    });
    budget?.recordProviderCall('repair', repairPrompt);
    const repairedRaw = await withAiCostContext({ agent: 'REPAIR', operation: 'MANUAL_REPAIR' }, () => contentService.fetchComposerRepairRaw(repairPrompt, provider));
    result = parseManualJsonDetailed(repairedRaw);
    if (result.ok) return result.data;

    logRejectedManualOutput(provider, result);
    lastFailure = result;
    lastRaw = repairedRaw;
  }

  throw new Error(lastFailure.message);
}
