import {
  parseGeneratedContent,
  normalizeHashtags,
  appendOptionalContactAndWebsite,
  finalizeGeneratedPostContent,
} from './src/services/postContentFormatting';

// A. Raw JSON string
const a = parseGeneratedContent(
  `{"headline":"H","body":"Real body","hashtags":"#JavaScript #Validation #WebDevelopment"}`,
);
console.log('A body:', a.body);
console.log('A hashtags:', normalizeHashtags(a.hashtags, a.body, a.headline));

// B. Nested JSON in body
const b = parseGeneratedContent({
  body: '{"headline":"H","body":"Clean post","hashtags":"#AI #Automation #SaaS"}',
});
console.log('B body:', b.body);
console.log('B hashtags:', b.hashtags);

// C. Preserve valid hashtags
const c = normalizeHashtags(
  '#JavaScript #DataValidation #WebDevelopment',
  'A post about JavaScript string validation techniques',
  'JavaScript validation',
);
console.log('C hashtags:', c);

// D. Stale replaced
const d = normalizeHashtags(
  '#DigitalTransformation #ITConsulting #TechStrategy #LinkedIn',
  'JavaScript validation in web apps',
  'JavaScript validation',
);
console.log('D hashtags:', d);

// E. Contact/website
const e = appendOptionalContactAndWebsite('Post body.', {
  includeWebsiteLink: true,
  includeContactInfo: true,
  websiteUrl: 'https://innovariatech.com',
  contactInfo: 'loneh067@gmail.com',
});
console.log('E:\n' + e);

// F. Full pipeline with raw JSON object as generatedContent
const f = finalizeGeneratedPostContent(
  {
    headline: 'Mastering String Validation',
    body: '{"headline":"X","body":"Should not appear","hashtags":"#JavaScript #DataValidation #WebDevelopment"}',
    hashtags: '',
  },
  'fallback',
  { includeContactInfo: false, includeWebsiteLink: false },
);
console.log('F content preview:\n' + f.content.slice(0, 200));
