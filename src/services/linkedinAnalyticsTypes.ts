export type AnalyticsDaily = { date: string; impressions: number; engagements: number; newFollowers?: number };
export type AnalyticsPost = { url: string; publishedAt?: string; impressions: number; engagements: number };
export type AnalyticsDemographic = { label: string; value: number };
export type NormalizedLinkedInAnalytics = {
  period: { start: string; end: string };
  discovery: { impressions: number; membersReached: number };
  engagementByDay: AnalyticsDaily[];
  followers: { total?: number; new?: number };
  topPosts: AnalyticsPost[];
  demographics: Record<'location'|'companySize'|'seniority'|'jobTitle'|'industry'|'company', AnalyticsDemographic[]>;
};

