import { prisma } from '../prismaClient';
import type { ContentIntelligenceProfile, AuthorityMode } from './contentIntelligenceService';
import { classifyVoiceSampleOrigin, type VoiceSamplePost } from './manualPost/manualVoiceSampleEligibility';

export type KnowledgeItemType =
  | 'EXPERIENCE'
  | 'PROCESS'
  | 'OBSERVATION'
  | 'LESSON'
  | 'OPINION'
  | 'EXPERTISE'
  | 'RESULT'
  | 'EXPLORATION';

export type KnowledgeSourceType =
  | 'USER_SUPPLIED_EXPERIENCE'
  | 'PROFILE_DESCRIPTION'
  | 'LINKEDIN_PROFILE_HEADLINE'
  | 'LINKEDIN_PROFILE_SUMMARY'
  | 'LINKEDIN_PROFILE_SKILL'
  | 'LINKEDIN_PROFILE_EXPERIENCE'
  | 'USER_AUTHORED_MANUAL_POST'
  | 'USER_EDITED_MANUAL_POST'
  | 'PUBLISHED_MANUAL_POST'
  | 'EXPLICIT_INSTRUCTION'
  | 'STRATEGY_TOPIC'
  | 'SELECTED_NICHE';

export type EvidenceStrength = 'STRONG' | 'MEDIUM' | 'WEAK';

export type UserKnowledgeItem = {
  type: KnowledgeItemType;
  summary: string;
  topics: string[];
  sourceType: KnowledgeSourceType;
  sourceId?: string;
  confidence: number;
  strength: EvidenceStrength;
  permitsFirstPerson: boolean;
};

export type TopicAuthority = {
  topic: string;
  mode: AuthorityMode;
  confidence: number;
  evidence: Array<{ sourceType: KnowledgeSourceType; sourceId?: string }>;
};

export type UserKnowledgeAuthorityContext = {
  items: UserKnowledgeItem[];
  explicitlyDone: UserKnowledgeItem[];
  knowledgeableTopics: string[];
  repeatedlyDiscussedTopics: string[];
  exploringTopics: string[];
  unsupportedBoundaries: string[];
  availableExperienceIds: string[];
};

export type GenerationAuthorityContext = {
  scope: 'MANUAL' | 'BATCH';
  territories: TopicAuthority[];
  knowledgeableTopics: string[];
  repeatedlyDiscussedTopics: string[];
  exploringTopics: string[];
  boundaries: string[];
  experienceBank: {
    availableCount: number;
    detailsIncluded: false;
    selectedExperienceRequiredForFirstPerson: true;
    batchApprovalRequired: boolean;
  };
};

export type KnowledgeEvidenceInput = {
  profileDescription?: string | null;
  profilePositioning?: {
    role?: string | null;
    positioningStatement?: string | null;
    credibilityPoints?: string[];
    topicsToBeKnownFor?: string[];
  } | null;
  linkedInProfile?: {
    id: string;
    headline?: string | null;
    summary?: string | null;
    skills?: unknown;
    experience?: unknown;
  } | null;
  experiences?: Array<{
    id: string;
    rawText: string;
    title?: string | null;
    summary?: string | null;
    topics?: unknown;
    lessons?: unknown;
    outcomes?: unknown;
    source: string;
  }>;
  posts?: Array<Pick<VoiceSamplePost,
    'id' | 'userId' | 'source' | 'status' | 'content' | 'hashtags' | 'manualTopic' |
    'aiGenerated' | 'rewriteCount' | 'publishedAt' | 'createdAt' | 'updatedAt'>>;
  niches?: string[];
  explicitInstructions?: string[];
};

const STOP_WORDS = new Set(
  'about after again also and are because been before being between both but can could does doing each for from had has have here how into its more most not now only other our out over same should some such than that the their them then there these they this through under very was were what when where which while who why will with would your'.split(' '),
);
const FIRST_PERSON = /\b(?:I|I'm|I've|I'd|my|me|we|we've|our)\b/i;
const EXPLORING = /\b(?:explor(?:e|ing)|learn(?:ing)?|research(?:ing)?|curious about|new to|experiment(?:ing)? with|trying to understand)\b/i;
const EXPLICIT_EXPERT = /\b(?:expert|speciali[sz](?:e|ing)|professional|consultant|advisor|doctor|physician|accountant|attorney|engineer|recruiter|founder|coach|therapist|years? of experience)\b/i;
const ACTION_FACT = /\b(?:build|built|create|created|implement|implemented|automate|automated|lead|led|manage|managed|run|ran|test|tested|observe|observed|work|worked|advise|advised|treat|treated|recruit|recruited|launch|launched|design|designed|learn|learned|change|changed|replace|replaced|help|helped|found|founded|operate|operated)\b/i;

function compact(value: string, limit = 280): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, limit);
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => compact(item, 160)).filter(Boolean);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return stringArray(parsed);
    } catch { /* use comma-separated legacy value */ }
    return value.split(',').map((item) => compact(item, 160)).filter(Boolean);
  }
  return [];
}

function tokens(value: string): string[] {
  return [...new Set((value.toLowerCase().match(/[a-z0-9][a-z0-9+#.-]*/g) ?? [])
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token)))];
}

function inferredTopics(summary: string, supplied: unknown = []): string[] {
  return [...new Set([...stringArray(supplied), ...tokens(summary).slice(0, 10)])].slice(0, 12);
}

function classifyText(value: string, fallback: KnowledgeItemType): KnowledgeItemType {
  if (EXPLORING.test(value)) return 'EXPLORATION';
  if (/\b(?:result|outcome|increased|decreased|reduced|saved|grew|improved|achieved)\b/i.test(value)) return 'RESULT';
  if (/\b(?:learned|lesson|realized|taught me)\b/i.test(value)) return 'LESSON';
  if (/\b(?:process|workflow|implemented|built|created|automated|designed|method)\b/i.test(value)) return 'PROCESS';
  if (/\b(?:observed|noticed|saw|pattern)\b/i.test(value)) return 'OBSERVATION';
  if (/\b(?:believe|think|opinion|prefer|should|must)\b/i.test(value)) return 'OPINION';
  return fallback;
}

function item(input: UserKnowledgeItem): UserKnowledgeItem | null {
  const summary = compact(input.summary);
  if (!summary) return null;
  return { ...input, summary, topics: [...new Set(input.topics.map((topic) => compact(topic, 120)).filter(Boolean))].slice(0, 12) };
}

function statementItems(
  text: string | null | undefined,
  sourceType: KnowledgeSourceType,
  confidence: number,
  strength: EvidenceStrength,
  sourceId?: string,
): UserKnowledgeItem[] {
  if (!text?.trim()) return [];
  return text.split(/(?<=[.!?])\s+|\n+/).map((statement) => compact(statement)).filter(Boolean).slice(0, 8)
    .map((summary) => item({
      type: classifyText(summary, EXPLICIT_EXPERT.test(summary) || ((sourceType === 'PROFILE_DESCRIPTION' || sourceType === 'LINKEDIN_PROFILE_SUMMARY') && ACTION_FACT.test(summary)) ? 'EXPERTISE' : 'OBSERVATION'),
      summary,
      topics: inferredTopics(summary),
      sourceType,
      sourceId,
      confidence,
      strength,
      permitsFirstPerson: sourceType === 'PROFILE_DESCRIPTION' && FIRST_PERSON.test(summary) && ACTION_FACT.test(summary) && !EXPLORING.test(summary),
    })).filter((entry): entry is UserKnowledgeItem => !!entry);
}

function manualPostItem(post: NonNullable<KnowledgeEvidenceInput['posts']>[number]): UserKnowledgeItem | null {
  const origin = classifyVoiceSampleOrigin(post);
  if (!origin) return null;
  const firstStatement = post.content.split(/(?<=[.!?])\s+|\n+/).map(compact).find(Boolean) ?? '';
  const summary = compact([post.manualTopic, firstStatement].filter(Boolean).join(': '));
  const userAuthored = origin === 'fully_manual' || (!post.aiGenerated && origin === 'published_manual');
  return item({
    type: classifyText(summary, 'OPINION'),
    summary,
    topics: inferredTopics(summary, post.manualTopic ? [post.manualTopic] : []),
    sourceType: post.status === 'PUBLISHED'
      ? 'PUBLISHED_MANUAL_POST'
      : userAuthored ? 'USER_AUTHORED_MANUAL_POST' : 'USER_EDITED_MANUAL_POST',
    sourceId: post.id,
    confidence: userAuthored ? .82 : .66,
    strength: userAuthored ? 'STRONG' : 'MEDIUM',
    permitsFirstPerson: userAuthored && FIRST_PERSON.test(firstStatement) && ACTION_FACT.test(firstStatement) && !EXPLORING.test(firstStatement),
  });
}

function topicSimilarity(a: string, b: string): number {
  const aa = new Set(tokens(a));
  const bb = new Set(tokens(b));
  if (!aa.size || !bb.size) return 0;
  let overlap = 0;
  for (const token of aa) if (bb.has(token)) overlap += 1;
  return overlap / Math.max(1, Math.min(aa.size, bb.size));
}

function relevantItems(context: UserKnowledgeAuthorityContext, topic: string): UserKnowledgeItem[] {
  return context.items.filter((entry) => {
    if (entry.topics.some((candidate) => topicSimilarity(topic, candidate) >= .34)) return true;
    return topicSimilarity(topic, entry.summary) >= .22;
  });
}

export function resolveTopicAuthority(context: UserKnowledgeAuthorityContext, topic: string): TopicAuthority {
  const relevant = relevantItems(context, topic);
  const evidence = relevant.map((entry) => ({ sourceType: entry.sourceType, sourceId: entry.sourceId }));
  if (!relevant.length) return { topic, mode: 'UNKNOWN', confidence: .15, evidence: [] };

  const explicitExploration = relevant.some((entry) => entry.type === 'EXPLORATION' && entry.sourceType !== 'SELECTED_NICHE' && entry.confidence >= .7);
  const hasExperience = relevant.some((entry) => entry.sourceType === 'USER_SUPPLIED_EXPERIENCE');
  const explicitExpertise = relevant.some((entry) => entry.sourceType === 'PROFILE_DESCRIPTION' && entry.type === 'EXPERTISE' && EXPLICIT_EXPERT.test(entry.summary));
  const explicitPractice = relevant.some((entry) =>
    (entry.sourceType === 'PROFILE_DESCRIPTION' || entry.sourceType === 'EXPLICIT_INSTRUCTION')
    && entry.permitsFirstPerson && entry.type !== 'EXPLORATION');
  const mediumFamiliarity = relevant.some((entry) => entry.type === 'EXPERTISE' || entry.sourceType.includes('MANUAL_POST'));
  const onlyWeakExploration = relevant.every((entry) => entry.type === 'EXPLORATION' || entry.strength === 'WEAK');
  const peak = Math.max(...relevant.map((entry) => entry.confidence));

  // An explicit statement that the user is learning/exploring prevents stronger
  // evidence from being generalized into current expert or practitioner status.
  if (explicitExploration) {
    return { topic, mode: mediumFamiliarity || hasExperience ? 'INFERRED_FAMILIARITY' : 'EXPLORATORY', confidence: Math.min(.58, peak), evidence };
  }
  if (explicitExpertise) return { topic, mode: 'EXPLICIT_EXPERTISE', confidence: Math.max(.82, peak), evidence };
  if (hasExperience) return { topic, mode: 'SUPPORTED_PRACTITIONER', confidence: Math.max(.78, peak), evidence };
  if (explicitPractice) return { topic, mode: 'SUPPORTED_PRACTITIONER', confidence: Math.max(.76, peak), evidence };
  if (mediumFamiliarity) return { topic, mode: 'INFERRED_FAMILIARITY', confidence: Math.min(.72, peak), evidence };
  if (onlyWeakExploration) return { topic, mode: 'EXPLORATORY', confidence: Math.min(.4, peak), evidence };
  return { topic, mode: 'UNKNOWN', confidence: Math.min(.4, peak), evidence };
}

export function buildUserKnowledgeAuthorityContext(input: KnowledgeEvidenceInput): UserKnowledgeAuthorityContext {
  const items: UserKnowledgeItem[] = [];
  items.push(...statementItems(input.profileDescription, 'PROFILE_DESCRIPTION', .9, 'STRONG'));

  const positioning = input.profilePositioning;
  if (positioning?.role) items.push(...statementItems(`Role: ${positioning.role}`, 'PROFILE_DESCRIPTION', .88, 'STRONG'));
  if (positioning?.positioningStatement && compact(positioning.positioningStatement) !== compact(input.profileDescription ?? '')) {
    items.push(...statementItems(positioning.positioningStatement, 'PROFILE_DESCRIPTION', .88, 'STRONG'));
  }
  for (const point of positioning?.credibilityPoints ?? []) {
    items.push(...statementItems(point, 'PROFILE_DESCRIPTION', .86, 'STRONG'));
  }

  const linkedIn = input.linkedInProfile;
  if (linkedIn?.headline) {
    const entry = item({ type: EXPLORING.test(linkedIn.headline) ? 'EXPLORATION' : 'EXPERTISE', summary: linkedIn.headline,
      topics: inferredTopics(linkedIn.headline), sourceType: 'LINKEDIN_PROFILE_HEADLINE', sourceId: linkedIn.id,
      confidence: .74, strength: 'MEDIUM', permitsFirstPerson: false });
    if (entry) items.push(entry);
  }
  if (linkedIn?.summary) {
    items.push(...statementItems(linkedIn.summary, 'LINKEDIN_PROFILE_SUMMARY', .72, 'MEDIUM', linkedIn.id));
  }
  for (const skill of stringArray(linkedIn?.skills)) {
    const entry = item({ type: 'EXPERTISE', summary: skill, topics: inferredTopics(skill, [skill]), sourceType: 'LINKEDIN_PROFILE_SKILL',
      sourceId: linkedIn?.id, confidence: .68, strength: 'MEDIUM', permitsFirstPerson: false });
    if (entry) items.push(entry);
  }
  for (const work of stringArray(linkedIn?.experience).slice(0, 12)) {
    const entry = item({ type: classifyText(work, 'EXPERTISE'), summary: work, topics: inferredTopics(work), sourceType: 'LINKEDIN_PROFILE_EXPERIENCE',
      sourceId: linkedIn?.id, confidence: .72, strength: 'MEDIUM', permitsFirstPerson: false });
    if (entry) items.push(entry);
  }

  for (const experience of input.experiences ?? []) {
    if (experience.source !== 'USER_SUPPLIED') continue;
    const summary = experience.summary || experience.title || experience.rawText;
    const entry = item({
      type: classifyText(`${experience.rawText} ${stringArray(experience.lessons).join(' ')} ${stringArray(experience.outcomes).join(' ')}`, 'EXPERIENCE'),
      summary,
      topics: inferredTopics(`${summary} ${experience.rawText}`, experience.topics),
      sourceType: 'USER_SUPPLIED_EXPERIENCE', sourceId: experience.id,
      confidence: .98, strength: 'STRONG', permitsFirstPerson: true,
    });
    if (entry) items.push(entry);
  }

  for (const post of input.posts ?? []) {
    const entry = manualPostItem(post);
    if (entry) items.push(entry);
  }

  for (const instruction of input.explicitInstructions ?? []) {
    const summary = compact(instruction);
    // Formatting or angle commands are not biographical evidence. Retain only
    // instructions that explicitly state a first-person fact or exploration.
    if (!summary || (!FIRST_PERSON.test(summary) && !EXPLORING.test(summary))) continue;
    const entry = item({
      type: classifyText(summary, EXPLORING.test(summary) ? 'EXPLORATION' : 'OPINION'),
      summary, topics: inferredTopics(summary), sourceType: 'EXPLICIT_INSTRUCTION',
      confidence: .92, strength: 'STRONG',
      permitsFirstPerson: FIRST_PERSON.test(summary) && ACTION_FACT.test(summary) && !EXPLORING.test(summary),
    });
    if (entry) items.push(entry);
  }

  for (const topic of positioning?.topicsToBeKnownFor ?? []) {
    const summary = compact(topic);
    if (!summary) continue;
    const entry = item({ type: 'EXPLORATION', summary, topics: [summary], sourceType: 'STRATEGY_TOPIC', confidence: .3, strength: 'WEAK', permitsFirstPerson: false });
    if (entry) items.push(entry);
  }

  for (const niche of input.niches ?? []) {
    const summary = compact(niche);
    if (!summary) continue;
    const entry = item({ type: 'EXPLORATION', summary, topics: [summary], sourceType: 'SELECTED_NICHE', confidence: .28, strength: 'WEAK', permitsFirstPerson: false });
    if (entry) items.push(entry);
  }

  const manualTopicCounts = new Map<string, { label: string; count: number }>();
  for (const entry of items.filter((candidate) => candidate.sourceType.includes('MANUAL_POST'))) {
    for (const topic of entry.topics.slice(0, 5)) {
      const key = compact(topic).toLowerCase();
      if (key.length < 4) continue;
      const current = manualTopicCounts.get(key);
      manualTopicCounts.set(key, { label: topic, count: (current?.count ?? 0) + 1 });
    }
  }
  const repeatedlyDiscussedTopics = [...manualTopicCounts.values()].filter((entry) => entry.count >= 2)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).slice(0, 12).map((entry) => entry.label);
  const exploringTopics = [...new Set(items.filter((entry) => entry.type === 'EXPLORATION').flatMap((entry) => entry.topics.slice(0, 2)))].slice(0, 16);
  const knowledgeableTopics = [...new Set(items.filter((entry) => entry.type !== 'EXPLORATION' && entry.sourceType !== 'SELECTED_NICHE')
    .flatMap((entry) => entry.topics.slice(0, 2)))].slice(0, 16);

  return {
    items,
    explicitlyDone: items.filter((entry) => entry.permitsFirstPerson),
    knowledgeableTopics,
    repeatedlyDiscussedTopics,
    exploringTopics,
    unsupportedBoundaries: [
      'A selected niche proves interest or content intent, not expertise or personal experience.',
      'AI-generated batch posts never authorize personal experience, project history, results, or expert status.',
      'Profile skills support familiarity only; they do not prove specific projects, clients, outcomes, or achievements.',
      'First-person experiential claims require explicit current evidence or a deliberately selected USER_SUPPLIED experience.',
    ],
    availableExperienceIds: items.filter((entry) => entry.sourceType === 'USER_SUPPLIED_EXPERIENCE').map((entry) => entry.sourceId!).filter(Boolean),
  };
}

export function buildGenerationAuthorityContext(
  context: UserKnowledgeAuthorityContext,
  scope: 'MANUAL' | 'BATCH',
  territories: string[] = [],
): GenerationAuthorityContext {
  const topics = [...new Set([...territories, ...context.knowledgeableTopics, ...context.exploringTopics])].filter(Boolean).slice(0, 30);
  return {
    scope,
    territories: topics.map((topic) => resolveTopicAuthority(context, topic)),
    knowledgeableTopics: context.knowledgeableTopics,
    repeatedlyDiscussedTopics: context.repeatedlyDiscussedTopics,
    exploringTopics: context.exploringTopics,
    boundaries: context.unsupportedBoundaries,
    experienceBank: {
      availableCount: context.availableExperienceIds.length,
      detailsIncluded: false,
      selectedExperienceRequiredForFirstPerson: true,
      batchApprovalRequired: scope === 'BATCH',
    },
  };
}

export function applyKnowledgeAuthorityToContentIntelligence(
  profile: ContentIntelligenceProfile,
  context: UserKnowledgeAuthorityContext,
): ContentIntelligenceProfile {
  return {
    ...profile,
    identity: {
      ...profile.identity,
      credibilityBoundaries: [...new Set([...profile.identity.credibilityBoundaries, ...context.unsupportedBoundaries])].slice(0, 12),
    },
    authorityMap: profile.authorityMap.map((entry) => {
      const resolved = resolveTopicAuthority(context, entry.territory);
      return {
        territory: entry.territory,
        mode: resolved.mode === 'UNKNOWN' ? 'EXPLORATORY' : resolved.mode,
        confidence: resolved.mode === 'UNKNOWN' ? Math.min(.3, entry.confidence) : resolved.confidence,
        evidence: resolved.evidence.length
          ? resolved.evidence.map((evidence) => `${evidence.sourceType}${evidence.sourceId ? `:${evidence.sourceId}` : ''}`).slice(0, 12)
          : ['SELECTED_NICHE:interest_only'],
      };
    }),
  };
}

function profilePositioning(value: unknown): KnowledgeEvidenceInput['profilePositioning'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    role: typeof record.role === 'string' ? record.role : null,
    positioningStatement: typeof record.positioningStatement === 'string' ? record.positioningStatement : null,
    credibilityPoints: stringArray(record.credibilityPoints),
    topicsToBeKnownFor: stringArray(record.topicsToBeKnownFor),
  };
}

export async function loadUserKnowledgeAuthorityContext(
  userId: string,
  options: { niches?: string[]; explicitInstructions?: string[] } = {},
): Promise<UserKnowledgeAuthorityContext> {
  const [config, linkedInProfile, experiences, posts] = await Promise.all([
    prisma.botConfig.findUnique({ where: { userId }, select: { description: true, niches: true, profilePositioning: true } }),
    prisma.linkedInProfileSnapshot.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' }, select: { id: true, headline: true, summary: true, skills: true, experience: true } }),
    prisma.personalExperience.findMany({ where: { userId, source: 'USER_SUPPLIED' }, orderBy: { updatedAt: 'desc' }, take: 30,
      select: { id: true, rawText: true, title: true, summary: true, topics: true, lessons: true, outcomes: true, source: true } }),
    prisma.post.findMany({ where: { userId, source: 'MANUAL' }, orderBy: { updatedAt: 'desc' }, take: 50,
      select: { id: true, userId: true, source: true, status: true, content: true, hashtags: true, manualTopic: true, aiGenerated: true, rewriteCount: true, publishedAt: true, createdAt: true, updatedAt: true } }),
  ]);
  const niches = options.niches?.length ? options.niches : stringArray(config?.niches);
  return buildUserKnowledgeAuthorityContext({
    profileDescription: config?.description,
    profilePositioning: profilePositioning(config?.profilePositioning),
    linkedInProfile,
    experiences,
    posts,
    niches,
    explicitInstructions: options.explicitInstructions,
  });
}
