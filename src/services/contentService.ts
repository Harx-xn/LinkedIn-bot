import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

// Shared prompt blocks so generate/mixed/rewrite stay consistent.
const POST_FORMAT_RULES = `POST FORMAT:
- Write in a Taplio-style LinkedIn format.
- Use short, punchy single-line statements.
- Each sentence or thought should usually be on its own line.
- Use blank lines between idea blocks.
- Avoid long paragraphs.
- Avoid markdown bullets unless the content truly needs a short list.
- Do not write dense explanation blocks.
- Do not start with "In today's world" or generic intros.
- Start with a sharp observation, tension, or contrarian insight.
- Build with 5-10 short lines.
- End with a direct question or memorable takeaway.
- Do not use the "👉" emoji or forced "-" bullet lists.
- Keep the post under 1200 characters unless the idea truly needs more.`;

const HASHTAG_RULES = `HASHTAG RULES:
- Generate 3-5 hashtags based specifically on the post content.
- Hashtags must reflect the actual topic, industry, audience, and angle of the post.
- Do not use the same default hashtags for every post.
- Avoid generic hashtags unless truly relevant.
- Do not include #LinkedIn unless the post is actually about LinkedIn.
- Put hashtags in the JSON "hashtags" field only, not inside the body.
- Use TitleCase hashtag formatting.`;

const LANGUAGE_RULES = `LANGUAGE RULE:
- Write the final post in English only.
- Do not write in Arabic, Urdu, Hindi, Spanish, or any other language unless the user explicitly selected that language in configuration.
- If the source content is in another language, translate the insight and write the post in English.`;

export class ContentService {
  private geminiKeys: string[] = [];
  private currentKeyIndex = 0;
  private openai: OpenAI | null = null;

  constructor(keys?: { openaiApiKey?: string | null; geminiApiKeys?: string[] | null }) {
    // Region-provided Gemini keys take priority; otherwise fall back to env.
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

    // Region-provided OpenAI key takes priority; otherwise fall back to env.
    const openaiKey = keys?.openaiApiKey || process.env.OPENAI_API_KEY;
    if (openaiKey) {
      this.openai = new OpenAI({ apiKey: openaiKey });
    }
  }

  private getGeminiModel() {
    const key = this.geminiKeys[this.currentKeyIndex] || 'dummy_key';
    const genAI = new GoogleGenerativeAI(key);
    return genAI.getGenerativeModel({ model: 'gemini-flash-latest' });
  }

  private async generateWithFallback(prompt: string, provider: 'GEMINI' | 'OPENAI'): Promise<string> {
    try {
      if (provider === 'GEMINI') {
        return await this.generateGeminiPost(prompt);
      } else {
        return await this.generateOpensAiPost(prompt);
      }
    } catch (error) {
      console.warn(`Primary provider ${provider} failed, attempting fallback...`);
      if (provider === 'GEMINI' && this.openai) {
        return await this.generateOpensAiPost(prompt);
      } else if (provider === 'OPENAI' && this.geminiKeys.length > 0) {
        return await this.generateGeminiPost(prompt);
      }
      throw error;
    }
  }

  async generatePost(
    topic: string,
    articleLink: string,
    provider: 'GEMINI' | 'OPENAI' = 'OPENAI',
    tone: string = 'Professional',
    description: string = ''
  ): Promise<any> {
    const personaBlock = description?.trim()
      ? `
ABOUT THE AUTHOR:
${description.trim()}

Use this to:
- match the user's voice and perspective
- tailor examples to the user's audience and industry
- avoid claims the user wouldn't credibly make
`
      : '';

    const prompt = `
You are a professional content creator.
${personaBlock}
Write a thought-leadership post about: "${topic}"
Reference: ${articleLink}

TONE & STYLE:
- Requested Tone: ${tone}
- Professional, insightful, business-focused
- Connect ideas to real business challenges
- Avoid hype - be honest and pragmatic
- Include specific, actionable insights

${POST_FORMAT_RULES}

${HASHTAG_RULES}

${LANGUAGE_RULES}

Output MUST be valid JSON:
{
  "headline": "Short internal headline, not necessarily shown (5-7 words)",
  "subheadline": "Short internal supporting insight (max 10 words)",
  "bulletPoints": ["First key insight", "Second key insight", "Third key insight"],
  "body": "Line-by-line Taplio-style LinkedIn post text following the POST FORMAT rules above.",
  "hashtags": "#SpecificHashtag #AnotherRelevantTag #ThirdRelevantTag"
}

The "bulletPoints" are only used internally to render an image; still keep them short.
Do not include markdown code blocks. Just raw JSON.
`;

    let raw = await this.generateWithFallback(prompt, provider);
    raw = raw.replace(/```json/g, '').replace(/```/g, '').trim();

    try {
      return JSON.parse(raw);
    } catch (e) {
      console.warn('Failed to parse JSON content, returning raw text as body');
      return {
        headline: topic,
        subheadline: '',
        bulletPoints: [],
        body: raw,
        hashtags: '',
      };
    }
  }

  private async generateGeminiPost(prompt: string, retryCount = 0): Promise<string> {
    if (this.geminiKeys.length === 0) {
      return `[MOCK] Gemini Post. (Set GEMINI_API_KEY)`;
    }

    try {
      const model = this.getGeminiModel();
      const result = await model.generateContent(prompt);
      const response = await result.response;
      return response.text();
    } catch (error: any) {
      // Check for 429 Too Many Requests
      if (error?.status === 429) {
        // If we have more keys, try the next one immediately
        if (this.geminiKeys.length > 1 && retryCount < this.geminiKeys.length) {
          this.currentKeyIndex = (this.currentKeyIndex + 1) % this.geminiKeys.length;
          console.warn(`Gemini 429 Rate Limit hit. Rotating to key ${this.currentKeyIndex + 1}...`);
          return this.generateGeminiPost(prompt, retryCount + 1);
        }

        // If all keys failed or only one key, wait and retry
        if (retryCount < 3) {
          const waitTime = 30000;
          console.warn(`All Gemini keys hit rate limits. Waiting ${waitTime / 1000}s before final retries...`);
          await new Promise((r) => setTimeout(r, waitTime));
          return this.generateGeminiPost(prompt, retryCount + 1);
        }
      }
      console.error('Gemini Generation Error:', error);
      throw error;
    }
  }

  private async generateOpensAiPost(prompt: string): Promise<string> {
    if (!this.openai) {
      throw new Error('OPENAI_API_KEY not found');
    }
    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
      });
      return response.choices[0].message.content || '';
    } catch (error) {
      console.error('OpenAI Generation Error:', error);
      throw new Error('OpenAI generation failed');
    }
  }

  async generateMixedPost(
    trends: { topic: string; link: string }[],
    provider: 'GEMINI' | 'OPENAI' = 'GEMINI',
    tone: string = 'Professional',
    description: string = ''
  ): Promise<any> {
    const topicsList = trends.map((t) => `"${t.topic}"`).join(' and ');
    const references = trends.map((t) => `- ${t.topic}: ${t.link}`).join('\n');

    const personaBlock = description?.trim()
      ? `
ABOUT THE AUTHOR:
${description.trim()}

Use this to:
- match the user's voice and perspective
- tailor examples to the user's audience and industry
- avoid claims the user wouldn't credibly make
`
      : '';

    const prompt = `
You are a professional content creator.
${personaBlock}
Write a strategic post that connects the following topics: ${topicsList}
References:
${references}

The goal is to find the intersection, contrast, or synergy between these trends.

TONE & STYLE:
- Requested Tone: ${tone}
- Professional, insightful, business-focused
- Connect these trends to real business challenges
- Avoid hype - be honest and pragmatic

${POST_FORMAT_RULES}

${HASHTAG_RULES}

${LANGUAGE_RULES}

OUTPUT MUST BE VALID JSON:
{
  "headline": "Short internal headline combining topics (max 7 words)",
  "subheadline": "Short internal supporting insight (max 10 words)",
  "bulletPoints": ["Insight about topic 1", "Insight about topic 2", "Synthesis/Connection point"],
  "body": "Line-by-line Taplio-style LinkedIn post connecting these topics, following the POST FORMAT rules above.",
  "hashtags": "#SpecificHashtag #AnotherRelevantTag #ThirdRelevantTag"
}

The "bulletPoints" are only used internally to render an image; still keep them short.
Do not include markdown code blocks. Just raw JSON.
`;

    let raw = await this.generateWithFallback(prompt, provider);
    raw = raw.replace(/```json/g, '').replace(/```/g, '').trim();

    try {
      return JSON.parse(raw);
    } catch (e) {
      console.warn('Failed to parse JSON content for mixed post, returning raw text');
      return {
        headline: `${topicsList} Trends`,
        subheadline: 'Strategic Analysis',
        bulletPoints: [],
        body: raw,
        hashtags: '',
      };
    }
  }

  async rewritePost(
    currentContent: string,
    suggestions: string,
    provider: 'GEMINI' | 'OPENAI' = 'OPENAI',
    tone: string = 'Professional',
    description: string = ''
  ): Promise<any> {
    const personaBlock = description?.trim()
      ? `
ABOUT THE AUTHOR:
${description.trim()}
`
      : '';

    const prompt = `
You are rewriting a LinkedIn post for review.
${personaBlock}
CURRENT POST:
${currentContent}

USER SUGGESTIONS:
${suggestions || 'Improve clarity, hook, and flow while keeping the same topic.'}

TONE: ${tone}

Rules:
- Apply the user's suggestions directly.
- Do not invent unverifiable facts.
- Keep content-specific hashtags; regenerate them if they are generic or constant.
- Preserve any existing "Learn more:" website line or "Contact:" line unless the user's suggestions say to remove them.

${POST_FORMAT_RULES}

${HASHTAG_RULES}

${LANGUAGE_RULES}

Output MUST be valid JSON:
{
  "headline": "Short internal headline",
  "subheadline": "Short internal supporting insight",
  "bulletPoints": ["First key insight", "Second key insight", "Third key insight"],
  "body": "Rewritten line-by-line Taplio-style LinkedIn post following the POST FORMAT rules above.",
  "hashtags": "#SpecificHashtag #AnotherRelevantTag #ThirdRelevantTag"
}

Do not include markdown code blocks. Just raw JSON.
`;

    let raw = await this.generateWithFallback(prompt, provider);
    raw = raw.replace(/```json/g, '').replace(/```/g, '').trim();

    try {
      return JSON.parse(raw);
    } catch {
      return {
        headline: 'Rewritten post',
        subheadline: '',
        bulletPoints: [],
        body: raw,
        hashtags: '',
      };
    }
  }

}
