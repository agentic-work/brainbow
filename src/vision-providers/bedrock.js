// SPDX-License-Identifier: MIT
//
// Bedrock vision provider — opt-in. Hits AWS Bedrock with ambient creds
// from ~/.aws/credentials.
//
// Env:
//   BRAINBOW_VISION_MODEL  default us.anthropic.claude-haiku-4-5 (cheap + fast,
//                          appropriate for short narration output ≤220 tokens).
//                          Override with us.anthropic.claude-sonnet-4-6 only when
//                          higher fidelity matters.
//   AWS_REGION             default us-east-1

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const DEFAULT_MODEL = process.env.BRAINBOW_VISION_MODEL || 'us.anthropic.claude-haiku-4-5';
const DEFAULT_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';

export function createBedrockProvider({
  region = DEFAULT_REGION,
  model = DEFAULT_MODEL,
  maxTokens = Number.parseInt(process.env.BRAINBOW_VISION_MAX_TOKENS || '220'),
} = {}) {
  let client = null;
  const ensureClient = () => (client ??= new BedrockRuntimeClient({ region }));
  return {
    name: 'bedrock',
    model,
    region,
    async narrate({ system, user, imageB64 }) {
      const body = {
        anthropic_version: 'bedrock-2023-05-31',
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
      const cmd = new InvokeModelCommand({
        modelId: model,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(body),
      });
      const res = await ensureClient().send(cmd);
      const parsed = JSON.parse(new TextDecoder().decode(res.body));
      const out = (parsed.content || [])
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('')
        .trim();
      if (!out) throw new Error('bedrock returned empty response');
      return out;
    },
  };
}
