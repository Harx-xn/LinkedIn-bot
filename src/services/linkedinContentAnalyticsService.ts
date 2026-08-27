import { Prisma } from '@prisma/client';
import { prisma } from '../prismaClient';
import { buildEffectiveBotStrategy } from './botStrategyService';
import { getContentServiceForUser } from './userContentContext';
import { calculateLinkedInMetrics } from './linkedinAnalyticsMetrics';
import type { NormalizedLinkedInAnalytics } from './linkedinAnalyticsTypes';
import { extractBalancedJsonObject } from './ghostwriterJsonParser';
import { createGenerationId, withAiCostContext } from './costIntelligence/aiCostTrackingService';

const urnFromUrl=(url:string)=>decodeURIComponent(url).match(/(?:activity|ugcPost|share)[:\/-](\d{8,})/i)?.[1];
const lengthGroup=(content:string)=>content.length<700?'short':content.length<1600?'medium':'long';
const format=(content:string)=>/^\s*\d+[.)]/m.test(content)?'list':/\?|what do you think/i.test(content)?'question':/step|how to|guide/i.test(content)?'tutorial':'educational';
const angle=(content:string)=>/mistake|wrong/i.test(content)?'technical_mistake':/how to|step|guide/i.test(content)?'practical_tutorial':/trade.?off|versus| vs /i.test(content)?'architecture_tradeoff':/i believe|unpopular|should/i.test(content)?'defensible_opinion':/debug|bug|fixed/i.test(content)?'debugging_story':/learned|lesson/i.test(content)?'product_lesson':'reflection';
type EnrichedMetric = NormalizedLinkedInAnalytics['topPosts'][number] & { engagementRate:number; matchedPostId?:string; enrichment?:Record<string,unknown> };

export async function enrichTopPosts(userId:string,data:NormalizedLinkedInAnalytics):Promise<EnrichedMetric[]>{
 const posts=await prisma.post.findMany({where:{userId},include:{contentFingerprint:true}});
 return data.topPosts.map(metric=>{const id=urnFromUrl(metric.url);const match=id?posts.find(p=>p.linkedinPostUrn?.includes(id)):undefined;
  if(!match)return {...metric,engagementRate:metric.impressions?metric.engagements/metric.impressions*100:0};
  return {...metric,engagementRate:metric.impressions?metric.engagements/metric.impressions*100:0,matchedPostId:match.id,enrichment:{content:match.content,topic:match.contentFingerprint?.primaryTopic??match.manualTopic,structure:match.contentFingerprint?.structure,hookType:match.contentFingerprint?.hookType,ctaType:match.contentFingerprint?.ctaType,angle:angle(match.content),format:format(match.content),lengthGroup:lengthGroup(match.content),media:match.attachmentType.toLowerCase(),source:match.source,aiGenerated:match.aiGenerated,publishedAt:match.publishedAt,scheduledAt:match.scheduledAt}}; });
}

export function aggregateMatchedPerformance(posts:Awaited<ReturnType<typeof enrichTopPosts>>){
 const dimensions=['topic','angle','format','lengthGroup','media'] as const; const result:Record<string,unknown[]>={};
 for(const dimension of dimensions){const groups=new Map<string,typeof posts>();for(const p of posts){const value=(p.enrichment as any)?.[dimension];if(!value)continue;groups.set(value,[...(groups.get(value)??[]),p]);}
  result[dimension]=[...groups].map(([name,items])=>({name,sampleSize:items.length,signal:items.length>=3?'established':'early',postCount:items.length,totalImpressions:items.reduce((s,p)=>s+p.impressions,0),averageImpressions:items.reduce((s,p)=>s+p.impressions,0)/items.length,averageEngagements:items.reduce((s,p)=>s+p.engagements,0)/items.length,engagementRate:items.reduce((s,p)=>s+p.engagements,0)/Math.max(1,items.reduce((s,p)=>s+p.impressions,0))*100})).sort((a,b)=>b.averageImpressions-a.averageImpressions);}
 return result;
}

type AnalyticsInsight = { type:string; importance:'HIGH'|'MEDIUM'|'LOW'; title:string; finding:string; recommendation:string; evidence:Array<{metric:string;value:string|number}>; confidence?:number; nextMove?:'DO_MORE'|'TEST'|'FIX'|'STOP_REDUCE' };
const insightTypes=new Set(['CONTENT_PILLAR','TOPIC','FORMAT','HOOK','AUDIENCE','SENIORITY','INDUSTRY','PROFILE_ALIGNMENT','STRATEGY_ALIGNMENT','ENGAGEMENT','FOLLOWER_GROWTH','MOMENTUM','MEDIA','OPPORTUNITY','WARNING']);
const importances=new Set(['HIGH','MEDIUM','LOW']); const nextMoves=new Set(['DO_MORE','TEST','FIX','STOP_REDUCE']);
export function parseAnalyticsInsightResponse(raw:string):AnalyticsInsight[]{
 const json=extractBalancedJsonObject(raw); if(!json)throw new Error('AI returned no valid JSON object.');
 let value:unknown; try{value=JSON.parse(json)}catch{throw new Error('AI returned malformed JSON.');}
 const candidates=Array.isArray((value as any)?.insights)?(value as any).insights:[];
 const insights:AnalyticsInsight[]=candidates.flatMap((item:any)=>{
  if(!item||typeof item!=='object'||typeof item.title!=='string'||typeof item.finding!=='string'||typeof item.recommendation!=='string'||!Array.isArray(item.evidence))return[];
  const evidence=item.evidence.flatMap((e:any)=>e&&typeof e.metric==='string'&&(typeof e.value==='string'||typeof e.value==='number')?[{metric:e.metric,value:e.value}]:[]);
  if(!evidence.length)return[]; const importance=importances.has(item.importance)?item.importance:'MEDIUM'; const type=insightTypes.has(item.type)?item.type:'OPPORTUNITY';
  const confidence=typeof item.confidence==='number'&&Number.isFinite(item.confidence)?Math.max(0,Math.min(1,item.confidence)):undefined;
  return [{type,importance,title:item.title.trim(),finding:item.finding.trim(),recommendation:item.recommendation.trim(),evidence,confidence,...(nextMoves.has(item.nextMove)?{nextMove:item.nextMove}:{})} as AnalyticsInsight];
 });
 if(!insights.length)throw new Error('AI returned JSON, but no usable evidence-backed insights.'); return insights.slice(0,8);
}
export async function generateAnalyticsInsights(userId:string,input:Record<string,unknown>){
 const service=await getContentServiceForUser(userId); if(!service.hasProvider('OPENAI')&&!service.hasProvider('GEMINI')) throw new Error('AI provider unavailable.');
 const prompt=`You are Veyrais' LinkedIn analytics analyst. Return JSON only: {"insights":[{"type":"CONTENT_PILLAR|TOPIC|FORMAT|HOOK|AUDIENCE|SENIORITY|INDUSTRY|PROFILE_ALIGNMENT|STRATEGY_ALIGNMENT|ENGAGEMENT|FOLLOWER_GROWTH|MOMENTUM|MEDIA|OPPORTUNITY|WARNING","importance":"HIGH|MEDIUM|LOW","title":"","finding":"","recommendation":"","evidence":[{"metric":"","value":0}],"confidence":0.0,"nextMove":"DO_MORE|TEST|FIX|STOP_REDUCE"}]}. Produce 4-8 non-generic insights. Use only supplied evidence; never invent numbers or causality. Call samples under 3 early signals. Omit unsupported audience/profile claims.\nINPUT:\n${JSON.stringify(input)}`;
 const provider=service.hasProvider('OPENAI')?'OPENAI':'GEMINI';
 const raw=await withAiCostContext({userId,feature:'ANALYTICS',operation:'ANALYTICS_INSIGHTS',agent:'STRATEGY_ANALYZER',generationId:createGenerationId()},()=>service.fetchJsonRaw(prompt,provider,3200));
 return parseAnalyticsInsightResponse(raw);
}

export async function buildAnalysisContext(userId:string,data:NormalizedLinkedInAnalytics,posts:Awaited<ReturnType<typeof enrichTopPosts>>){
 const [botConfig,profile,history]=await Promise.all([prisma.botConfig.findUnique({where:{userId}}),prisma.linkedInProfileSnapshot.findFirst({where:{userId},orderBy:{createdAt:'desc'}}),prisma.linkedInAnalyticsImport.findMany({where:{userId,status:'READY'},orderBy:{periodEnd:'desc'},take:3,select:{periodStart:true,periodEnd:true,deterministicData:true}})]);
 return {metrics:calculateLinkedInMetrics(data),contentPerformance:aggregateMatchedPerformance(posts),matchedPosts:posts.filter(p=>p.matchedPostId).map(p=>({impressions:p.impressions,engagements:p.engagements,enrichment:p.enrichment})),strategy:buildEffectiveBotStrategy(botConfig),profile,previousPeriods:history};
}

export const jsonValue=(value:unknown)=>value as Prisma.InputJsonValue;
