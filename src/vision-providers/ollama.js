// SPDX-License-Identifier: MIT
//
// Ollama vision provider — DEFAULT. Hits local Ollama on the 4090.
//
// Env:
//   BRAINBOW_OLLAMA_HOST   default http://localhost:11434
//   BRAINBOW_VISION_MODEL  default qwen2.5vl:7b
//
// Uses Ollama's `/api/generate` with `images` (base64 array). Compatible
// with any vision model on Ollama: qwen2.5vl, llama3.2-vision, llava,
// moondream, internvl3, etc.

const DEFAULT_HOST = process.env.BRAINBOW_OLLAMA_HOST || 'http://localhost:11434';
const DEFAULT_MODEL = process.env.BRAINBOW_VISION_MODEL || 'qwen2.5vl:7b';

export function createOllamaProvider({
  host = DEFAULT_HOST,
  model = DEFAULT_MODEL,
  numPredict = Number.parseInt(process.env.BRAINBOW_VISION_MAX_TOKENS || '220'),
} = {}) {
  return {
    name: 'ollama',
    model,
    host,
    async narrate({ system, user, imageB64 }) {
      const body = {
        model,
        prompt: `${system}\n\n${user}`,
        images: [imageB64],
        stream: false,
        // Release the model from VRAM immediately after each call. brainbow is
        // intermittent, so it must never hold the GPU resident when idle
        // (user direction 2026-06-22: "if not being used it cant be in memory").
        keep_alive: 0,
        options: { num_predict: numPredict, temperature: 0.2 },
      };
      const res = await fetch(`${host}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`ollama ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = await res.json();
      const out = String(data.response || '').trim();
      if (!out) throw new Error('ollama returned empty response');
      return out;
    },
  };
}
