import type { NormalizedLinkedInAnalytics } from './linkedinAnalyticsTypes';
const safe=(n:number,d:number)=>d? n/d:0;
const median=(values:number[])=>{if(!values.length)return 0;const a=[...values].sort((x,y)=>x-y),m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2};
export function calculateLinkedInMetrics(data:NormalizedLinkedInAnalytics){
 const engagements=data.engagementByDay.reduce((s,d)=>s+d.engagements,0)||data.topPosts.reduce((s,p)=>s+p.engagements,0);
 const days=[...data.engagementByDay].sort((a,b)=>a.date.localeCompare(b.date)); const ranked=[...days].sort((a,b)=>b.impressions-a.impressions);
 const postImpressions=data.topPosts.map(p=>p.impressions); const topDayImpressions=ranked.slice(0,Math.max(1,Math.ceil(ranked.length*.2))).reduce((s,d)=>s+d.impressions,0);
 const top=(type:keyof typeof data.demographics)=>[...data.demographics[type]].sort((a,b)=>b.value-a.value).slice(0,5);
 return {totalImpressions:data.discovery.impressions,membersReached:data.discovery.membersReached,totalEngagements:engagements,engagementRate:safe(engagements,data.discovery.impressions)*100,impressionsPerReachedMember:safe(data.discovery.impressions,data.discovery.membersReached),followerCount:data.followers.total,newFollowers:data.followers.new??0,daily:days,peakDay:ranked[0]??null,lowestDay:ranked.length?ranked[ranked.length-1]:null,topDaysConcentration:safe(topDayImpressions,days.reduce((s,d)=>s+d.impressions,0))*100,averageImpressionsPerPost:safe(postImpressions.reduce((a,b)=>a+b,0),postImpressions.length),medianImpressionsPerPost:median(postImpressions),averageEngagementsPerPost:safe(data.topPosts.reduce((s,p)=>s+p.engagements,0),data.topPosts.length),topAudience:{industries:top('industry'),jobTitles:top('jobTitle'),seniority:top('seniority'),companySizes:top('companySize'),locations:top('location')}};
}
