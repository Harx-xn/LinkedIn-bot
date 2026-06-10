/** Domain-aware subreddit hints. Keys are normalized domain slugs. */
export const DOMAIN_SUBREDDITS: Record<string, string[]> = {
  saas: ['SaaS', 'startups', 'Entrepreneur', 'webdev'],
  software: ['programming', 'webdev', 'softwaredevelopment', 'learnprogramming'],
  technology: ['technology', 'Futurology', 'tech'],
  cybersecurity: ['cybersecurity', 'netsec', 'privacy'],
  healthcare: ['medicine', 'healthcare', 'publichealth'],
  health: ['health', 'medicine', 'publichealth'],
  finance: ['finance', 'fintech', 'investing'],
  fintech: ['fintech', 'finance', 'startups'],
  education: ['education', 'teachers', 'highereducation'],
  legal: ['law', 'legaltech'],
  realestate: ['realestate', 'RealEstateInvesting'],
  agriculture: ['farming', 'agriculture'],
  ai: ['artificial', 'MachineLearning', 'LocalLLaMA'],
};

export function resolveDomainKey(domain: string, niche: string): string | null {
  const text = `${domain} ${niche}`.toLowerCase();
  if (/\b(saas|software as a service)\b/.test(text)) return 'saas';
  if (/\b(cyber|security|infosec)\b/.test(text)) return 'cybersecurity';
  if (/\b(healthcare|medicine|clinical|disease)\b/.test(text)) return 'healthcare';
  if (/\b(fintech|finance|banking)\b/.test(text)) return 'finance';
  if (/\b(education|learning|teaching)\b/.test(text)) return 'education';
  if (/\b(legal|compliance|law)\b/.test(text)) return 'legal';
  if (/\b(real estate|property|housing)\b/.test(text)) return 'realestate';
  if (/\b(ai|machine learning|automation)\b/.test(text)) return 'ai';
  if (/\b(software|developer|programming|engineering|tech)\b/.test(text)) return 'software';
  if (/\b(agriculture|farming)\b/.test(text)) return 'agriculture';
  return null;
}

export function getSubredditsForNiche(domain: string, niche: string): string[] {
  const key = resolveDomainKey(domain, niche);
  if (key && DOMAIN_SUBREDDITS[key]) return DOMAIN_SUBREDDITS[key];
  return [];
}
