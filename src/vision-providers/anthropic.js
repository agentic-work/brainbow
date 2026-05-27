// SPDX-License-Identifier: MIT
//
// Anthropic direct vision provider — opt-in. Hits api.anthropic.com.
//
// Env:
//   BRAINBOW_ANTHROPIC_API_KEY  (or ANTHROPIC_API_KEY)
//   BRAINBOW_VISION_MODEL       default claude-sonnet-4-5-20250929

const DEFAULT_KEY = process.env.BRAINBOW_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '';
const DEFAULT_MODEL = process.env.BRAINBOW_VISION_MODEL || 'claude-sonnet-4-5-20250929';
const DEFAULT_BASE = process.env.BRAINBOW_ANTHROPIC_BASE_URL || 'https://api.anthropic.com';

export function createAnthropicProvider({
  apiKey = DEFAULT_KEY,
  baseUrl = DEFAULT_BASE,
  model = DEFAULT_MODEL,
  maxTokens = Number.parseInt(process.env.BRAINBOW_VISION_MAX_TOKENS || '220'),
} = {}) {
  return {
    name: 'anthropic',
    model,
    baseUrl,
    async narrate({ system, user, imageB64 }) {
      if (!apiKey) throw new Error('anthropic provider needs ANTHROPIC_API_KEY env');
      const body = {
        model,
        max_tokens: maxTokens,
        system,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageB64 } },
              { type: 'text', text: user },
            ],
          },
        ],
      };
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`anthropic ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = await res.json();
      const out = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
      if (!out) throw new Error('anthropic returned empty response');
      return out;
    },
  };
}
