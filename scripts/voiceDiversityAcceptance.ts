import fs from 'node:fs';
import path from 'node:path';
import { ContentService } from '../src/services/contentService';
import type { AuthorContext, ExpressionMode } from '../src/services/generationTypes';
import { buildManualDraftPrompt } from '../src/services/manualPost/manualPostPrompts';
import { parseManualGeneratedPostV2 } from '../src/services/manualPost/manualPostJsonParser';
import { finalizeManualGeneratedPostV2 } from '../src/services/manualPost/manualPostFormatting';

type Case = { group: string; topic: string; claim: string; mode: ExpressionMode; author: AuthorContext };

const sameClaim = 'More lead volume can reduce pipeline efficiency when qualification criteria stay unchanged.';
const modes: ExpressionMode[] = ['direct', 'analytical', 'diagnostic', 'conversational', 'opinionated', 'walkthrough', 'reflective'];
const sharedAuthor: AuthorContext = {
  description: 'A revenue operations practitioner who writes plainly about pipeline design and operating decisions.',
  tone: 'Plainspoken, practical, and confident', niches: ['Revenue operations', 'B2B sales'], targetAudience: ['sales and marketing leaders'],
};

const cases: Case[] = modes.map((mode) => ({ group: 'same-claim-seven-mode', topic: 'Lead volume and pipeline efficiency', claim: sameClaim, mode, author: sharedAuthor }));
const domains: Array<{ name: string; topic: string; claim: string; author: AuthorContext }> = [
  { name: 'healthcare', topic: 'Denial management', claim: 'Delayed denial review reduces recoverability when filing windows continue to close.', author: { description: 'A healthcare revenue-cycle practitioner who writes plainly about operational decisions.', tone: 'Plainspoken, practical, and confident', niches: ['Healthcare revenue cycle'], targetAudience: ['revenue cycle leaders'] } },
  { name: 'marketing', topic: 'Lead generation', claim: sameClaim, author: sharedAuthor },
  { name: 'leadership', topic: 'Team performance', claim: 'Adding work can reduce team performance when decision ownership remains unclear.', author: { description: 'An operations leader who writes plainly about team systems and management decisions.', tone: 'Plainspoken, practical, and confident', niches: ['Leadership'], targetAudience: ['team leaders'] } },
  { name: 'sales', topic: 'Discovery calls', claim: 'More discovery questions can weaken a sales conversation when they replace follow-up on the buyer’s actual constraints.', author: sharedAuthor },
  { name: 'technology', topic: 'API scalability', claim: 'Adding servers does not improve API scalability when unbounded response payloads remain the dominant cost.', author: { description: 'A backend engineer who writes plainly about system design and operating trade-offs.', tone: 'Plainspoken, practical, and confident', niches: ['Backend engineering'], targetAudience: ['engineers and technical leaders'] } },
];
const crossModes: ExpressionMode[] = ['direct', 'analytical', 'diagnostic', 'conversational', 'reflective'];
for (const domain of domains) for (const mode of crossModes) cases.push({ group: `cross-domain-${domain.name}`, topic: domain.topic, claim: domain.claim, mode, author: domain.author });
const batchTopics = [
  ['Lead scoring drift', 'A lead score loses decision value when its weights stay fixed after the buyer mix changes.'],
  ['Marketing-sales handoff', 'Faster handoffs do not improve pipeline quality when ownership of the next decision remains ambiguous.'],
  ['Pipeline reviews', 'A pipeline review becomes less useful when every deal receives equal discussion time.'],
  ['Discovery notes', 'More detailed discovery notes can reduce usefulness when they do not distinguish facts from assumptions.'],
  ['Forecast confidence', 'Forecast confidence falls when stage definitions describe activity rather than buyer commitment.'],
  ['Inbound routing', 'Faster inbound routing can create more rework when territory rules and account ownership disagree.'],
  ['Qualification changes', 'Qualification criteria should change only when the team can name which decision the new signal improves.'],
] as const;
batchTopics.forEach(([topic, claim], index) => cases.push({ group: 'same-author-seven-post-batch', topic, claim, mode: modes[index], author: sharedAuthor }));

const phrases = ['For instance', 'For example', 'Consider', 'Imagine', 'This can lead to', 'This can result in', 'This often leads to', 'By implementing', 'To mitigate', 'Moreover', 'Ultimately', 'Remember', 'In summary', 'In essence', 'The key is', "It's crucial", "It's essential", 'This approach', 'This not only', 'Prioritizing'];

function classify(text: string) {
  const paragraphs = text.split(/\n\n+/).filter(Boolean);
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const opening = text.trim().split(/\n|(?<=[.!?])\s+/)[0] ?? '';
  return {
    openingType: /\?$/.test(opening) ? 'question' : /\b(?:failing|drops?|rises?|stalls?|slows?|rejected|problem)\b/i.test(opening) ? 'symptom' : /\b(?:I think|we tend|you know|here's)\b/i.test(opening) ? 'conversational setup' : 'claim/observation/position',
    exampleUsed: /\b(?:for example|for instance|such as|e\.g\.)\b/i.test(text),
    scenarioIntroduction: /\b(?:consider|imagine|scenario)\b/i.test(text),
    consequenceSection: /\b(?:this (?:can|often) lead|this can result|as a result|consequence)\b/i.test(text),
    recommendation: /\b(?:should|must|start by|check |use |stop |replace |to mitigate|recommend)\b/i.test(text),
    listSteps: /(?:^|\n)(?:\d+\.|[-*])\s/m.test(text),
    explicitConclusion: /\b(?:ultimately|in summary|in essence|the key is|remember|in conclusion)\b/i.test(text),
    endingType: /\?$/.test(text.trim()) ? 'question' : /(?:^|\n)\d+\./m.test(text) ? 'step' : 'assertion/implication/natural',
    paragraphRhythm: /(?:^|\n)\d+\./m.test(text) ? 'step-based' : paragraphs.some((p) => p.split(/(?<=[.!?])\s+/).length >= 2) ? 'mixed/dense' : 'sparse',
    paragraphCount: paragraphs.length, sentenceCount: sentences.length,
    genericPhrases: phrases.filter((phrase) => text.toLowerCase().includes(phrase.toLowerCase())),
  };
}

async function generate(service: ContentService, item: Case, index: number) {
  const selectedPlan = { title: item.topic, coreClaim: item.claim, audience: item.author.targetAudience?.join(', ') || 'practitioners', structure: `${item.mode} mode contract`, evidenceMode: 'reasoned_observation', hook: '', selectedHookType: 'CONCRETE_OBSERVATION' };
  const prompt = buildManualDraftPrompt({ topic: item.topic, author: item.author, expressionMode: item.mode, recentPosts: [], selectedPlan });
  const rawProvider = await service.fetchComposerGenerationRaw(prompt, 'OPENAI');
  const parsed = parseManualGeneratedPostV2(rawProvider);
  const rawPost = [parsed.hook, parsed.body, parsed.closingLine].filter(Boolean).join('\n\n');
  const final = finalizeManualGeneratedPostV2(parsed, item.topic, { topic: item.topic, voice: { description: item.author.description, tone: item.author.tone, niches: item.author.niches ?? [], includeContactInfo: false, includeWebsiteLink: false, contactInfo: null, websiteUrl: null } });
  return { id: index + 1, ...item, rawProvider, rawPost, finalPost: final.content, rawClassification: classify(rawPost), finalClassification: classify(final.content) };
}

async function main() {
  const service = new ContentService();
  const results: unknown[] = [];
  const selectedCases = process.argv.includes('--same-claim') ? cases.slice(0, 7) : cases;
  for (let i = 0; i < selectedCases.length; i += 4) {
    results.push(...await Promise.all(selectedCases.slice(i, i + 4).map((item, offset) => generate(service, item, i + offset))));
  }
  const report = { generatedAt: new Date().toISOString(), productionModel: process.env.OPENAI_CONTENT_MODEL || 'gpt-4o-mini', sameClaim, results };
  const target = path.resolve('voice-diversity-acceptance.json');
  fs.writeFileSync(target, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ target, samples: results.length }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
