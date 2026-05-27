// SPDX-License-Identifier: MIT
//
// Vision provider registry. Adding a new provider is one file in this
// directory + one entry in PROVIDERS.
//
// Selection: BRAINBOW_VISION_PROVIDER env (default 'bedrock'). Each
// provider returns an object with `{name, model, narrate({system,user,imageB64}) -> string}`.

import { createOllamaProvider } from './ollama.js';
import { createBedrockProvider } from './bedrock.js';
import { createOpenAIProvider } from './openai.js';
import { createAnthropicProvider } from './anthropic.js';

const PROVIDERS = {
  ollama: createOllamaProvider,
  bedrock: createBedrockProvider,
  openai: createOpenAIProvider,
  anthropic: createAnthropicProvider,
  // Easy to add: vertex, azure-aif, gemini-direct, mistral, groq, etc.
  // Just write a one-file provider matching the same shape and register here.
};

export function listVisionProviders() {
  return Object.keys(PROVIDERS);
}

export function createVisionProvider(name = process.env.BRAINBOW_VISION_PROVIDER || 'bedrock', opts = {}) {
  const fn = PROVIDERS[name];
  if (!fn) {
    const known = Object.keys(PROVIDERS).join(', ');
    throw new Error(`unknown vision provider '${name}'. known: ${known}`);
  }
  return fn(opts);
}
