import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

export class ContentService {
  private geminiKeys: string[] = [];
  private currentKeyIndex = 0;
  private openai: OpenAI | null = null;

  constructor() {
    // Collect all available Gemini keys
    if (process.env.GEMINI_API_KEY) this.geminiKeys.push(process.env.GEMINI_API_KEY);
    if (process.env.GEMINI_API_KEY_2) this.geminiKeys.push(process.env.GEMINI_API_KEY_2);

    // Add more if they exist
    let i = 3;
    while (process.env[`GEMINI_API_KEY_${i}`]) {
      this.geminiKeys.push(process.env[`GEMINI_API_KEY_${i}`] as string);
      i++;
    }

    if (process.env.OPENAI_API_KEY) {
      this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
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
- Emphasize practical business value and strategic thinking
- Focus on digital transformation, IT strategy, automation, and modernization
- Connect technology trends to real business challenges
- Avoid hype - be honest and pragmatic
- Use short, punchy sentences
- Include specific, actionable insights

STRUCTURE:
- Start with a bold observation or insight
- Connect to business reality (budgets, competition, efficiency)
- Provide 2-3 specific points or examples
- End with a strategic takeaway or question

Output MUST be valid JSON:
{
  "headline": "Short, punchy 5-7 word headline aligned with ${tone} tone",
  "subheadline": "Short supporting insight (max 10 words)",
  "bulletPoints": ["First key insight", "Second key insight", "Third key insight"],
  "body": "Professional LinkedIn post text (under 1500 chars). Write like the examples: direct, insightful, business-focused. Use bullet points with - symbol. Include a strategic question or call-to-action at the end with 👉 emoji.",
  "hashtags": "#DigitalTransformation #ITConsulting #TechStrategy #LinkedIn"
}

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
- Connect technology trends to real business challenges
- Avoid hype - be honest and pragmatic
- Use short, punchy sentences

OUTPUT MUST BE VALID JSON:
{
  "headline": "Short, punchy headline combining topics (max 7 words)",
  "subheadline": "Short supporting insight (max 10 words)",
  "bulletPoints": ["Insight about topic 1", "Insight about topic 2", "Synthesis/Connection point"],
  "body": "Professional LinkedIn post text connecting these topics. Use bullet points with - symbol. Include a strategic question or call-to-action at the end with 👉 emoji.",
  "hashtags": "#TechTrends #LinkedIn"
}

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
}
