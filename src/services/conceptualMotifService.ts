export type ConceptualMotifClassification = {
  conceptualMotif: string | null;
  reasoningArchetype: string | null;
};

export type ConceptualMotifInput = {
  claim?: string | null;
  mechanism?: string | null;
  perspective?: string | null;
  audienceConsequence?: string | null;
  ideaFamily?: string | null;
};

type MotifRule = {
  motif: string;
  archetype: string;
  primary: RegExp;
  secondary: RegExp;
};

// This taxonomy describes domain-neutral causal shapes. Domain nouns are
// intentionally absent so the same classifier works across configured niches.
const MOTIF_RULES: MotifRule[] = [
  {
    motif: 'LOCAL_IMPROVEMENT_SHIFTS_COST', archetype: 'COST_OR_CONSTRAINT_TRANSFER',
    primary: /\b(?:local|one part|single area|optimization|optimisation|bottleneck|fix)\b/i,
    secondary: /\b(?:moves?|shifts?|elsewhere|downstream|another part|new bottleneck|transfers? (?:the )?(?:cost|risk|load))\b/i,
  },
  {
    motif: 'TOOL_OR_PROCESS_BECOMES_CONSTRAINT', archetype: 'DEPENDENCY_OR_CONTROL',
    primary: /\b(?:tool|platform|process|system|workflow|framework|method)\b/i,
    secondary: /\b(?:dictates?|controls?|constrains?|dependency|lock-?in|shapes? the workflow|becomes? the bottleneck|starts? deciding)\b/i,
  },
  {
    motif: 'UPSTREAM_DECISION_CONTROLS_DOWNSTREAM', archetype: 'DEPENDENCY_OR_CONTROL',
    primary: /\b(?:upstream|earlier|first decision|initial decision|before|input|intake)\b/i,
    secondary: /\b(?:downstream|later|controls?|determines?|propagates?|cascade|handoff|outcome)\b/i,
  },
  {
    motif: 'VISIBILITY_WITHOUT_SYSTEM_CHANGE', archetype: 'SURFACE_VS_UNDERLYING_SYSTEM',
    primary: /\b(?:visibility|visible|dashboard|metric|report|measurement|signal|tracking)\b/i,
    secondary: /\b(?:without changing|unchanged|does not (?:change|fix)|same system|underlying|behavior remains|behaviour remains)\b/i,
  },
  {
    motif: 'SIMPLICITY_CREATES_LATER_COORDINATION_COST', archetype: 'TEMPORAL_TRADEOFF',
    primary: /\b(?:simple|simplest|easy|quick|initially|at first|short-?term)\b/i,
    secondary: /\b(?:later|over time|as .* grows?|coordination|handoff|complexity|becomes? (?:a )?(?:constraint|cost)|until)\b/i,
  },
  {
    motif: 'CONTEXT_CHANGES_RULE_VALIDITY', archetype: 'CONTEXT_DEPENDENT_VALIDITY',
    primary: /\b(?:rule|practice|principle|policy|playbook|approach|method|standard)\b/i,
    secondary: /\b(?:context|condition|constraint|unless|until|copied|no longer|stops? working|fails? when|valid)\b/i,
  },
  {
    motif: 'SHORT_TERM_GAIN_CREATES_LONG_TERM_TRADEOFF', archetype: 'TEMPORAL_TRADEOFF',
    primary: /\b(?:short-?term|immediate|quick win|initial gain|today)\b/i,
    secondary: /\b(?:long-?term|later|future|eventually|trade-?off|debt|cost|risk)\b/i,
  },
  {
    motif: 'SURFACE_SYMPTOM_REVEALS_DEEPER_CAUSE', archetype: 'CAUSAL_DIAGNOSIS',
    primary: /\b(?:symptom|surface|visible problem|signal|looks? like|appears? to be)\b/i,
    secondary: /\b(?:deeper|underlying|root cause|actually caused|reveals?|driven by|comes? from)\b/i,
  },
  {
    motif: 'OWNERSHIP_REDUCES_COORDINATION_AMBIGUITY', archetype: 'OWNERSHIP_AND_COORDINATION',
    primary: /\b(?:owner|ownership|accountability|decision rights?|responsibility)\b/i,
    secondary: /\b(?:ambiguity|handoff|coordination|approval|escalation|duplicate|conflict)\b/i,
  },
];

export function classifyConceptualMotif(input: ConceptualMotifInput | string): ConceptualMotifClassification {
  const text = typeof input === 'string'
    ? input
    : [input.claim, input.mechanism, input.perspective, input.audienceConsequence, input.ideaFamily]
      .filter(Boolean).join(' ');
  if (!text.trim()) return { conceptualMotif: null, reasoningArchetype: null };
  const match = MOTIF_RULES.find((rule) => rule.primary.test(text) && rule.secondary.test(text));
  return match
    ? { conceptualMotif: match.motif, reasoningArchetype: match.archetype }
    : { conceptualMotif: null, reasoningArchetype: null };
}
