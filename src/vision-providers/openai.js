// SPDX-License-Identifier: MIT
//
// OpenAI-compatible vision provider — opt-in. Any service that speaks
// OpenAI chat/completions with image content blocks works here: OpenAI
// proper, Azure AI Foundry, vLLM, ollama's OpenAI-compat endpoint, etc.
//
// Env:
//   BRAINBOW_OPENAI_BASE_URL  default https://api.openai.com/v1
//   BRAINBOW_OPENAI_API_KEY   (or OPENAI_API_KEY)
//   BRAINBOW_VISION_MODEL     default gpt-4o-mini

const DEFAULT_BASE = process.env.BRAINBOW_OPENAI_BASE_URL || 'https://api.openai.com/v1';
const DEFAULT_KEY = process.env.BRAINBOW_OPENAI_API_KEY || process.env.OPENAI_API_KEY || '';
const DEFAULT_MODEL = process.env.BRAINBOW_VISION_MODEL || 'gpt-4o-mini';

export function createOpenAIProvider({
  baseUrl = DEFAULT_BASE,
  apiKey = DEFAULT_KEY,
  model = DEFAULT_MODEL,
  maxTokens = Number.parseInt(process.env.BRAINBOW_VISION_MAX_TOKENS || '220'),
} = {}) {
  return {
    name: 'openai',
    model,
    baseUrl,
    async narrate({ system, user, imageB64 }) {
      const body = {
        model,
        max_tokens: maxTokens,
        temperature: 0.2,
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content: [
              { type: 'text', text: user },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageB64}` } },
            ],
          },
        ],
      };
      const headers = { 'content-type': 'application/json' };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`openai ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = await res.json();
      const out = String(data?.choices?.[0]?.message?.content || '').trim();
      if (!out) throw new Error('openai returned empty response');
      return out;
    },
  };
}
