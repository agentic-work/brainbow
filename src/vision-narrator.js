// SPDX-License-Identifier: MIT
//
// VisionNarrator — continuous live narration of the CDP frame stream via
// AWS Bedrock Claude Sonnet 4.6.
//
// Why: Claude (or any LLM client) can't stream-consume a video. They have
// to poll. By having brainbow's *backend* watch the frames continuously
// and accumulate a narration log, a single `/api/live` poll returns the
// since-last-call narration delta — the AI gets the "I watched this happen"
// experience without actually streaming bytes through tool I/O.
//
// Provider: Bedrock Sonnet 4.6 reads from ambient ~/.aws/credentials.
// Model id default: us.anthropic.claude-sonnet-4-6-20250929-v1:0 (inference
// profile). Override via BRAINBOW_VISION_MODEL env.
//
// Sampling: every BRAINBOW_VISION_INTERVAL_MS (default 2500ms), pick the
// most-recent frame from Session.lastFrameB64, run it through Sonnet with
// a tight system prompt + ~200 token budget, append the result to
// session.visionNarration[] with timestamp + frame-url + body. The
// /api/live endpoint returns narration entries after `cursor` ts.
//
// On error (no creds, throttle, model unavailable) we log once and back
// off — narration is opportunistic, never blocks the rest of brainbow.

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const DEFAULT_MODEL_ID = 'us.anthropic.claude-sonnet-4-6';
const DEFAULT_REGION = 'us-east-1';
const DEFAULT_INTERVAL_MS = 2500;
const DEFAULT_MAX_TOKENS = 220;
const DEFAULT_RING_SIZE = 200;

const SYSTEM_PROMPT = `You are a continuous live-vision narrator embedded in a browser-automation tool. Each call you receive ONE current screenshot of the page the user is on plus the prior-narration tail (your own recent outputs).

Your job: in 1-2 short sentences, describe WHAT VISIBLY CHANGED since the prior narration, AND THE KEY VISIBLE FACTS the operator needs to know RIGHT NOW (errors on screen, modal dialogs, login state, what page they're on, what the assistant just rendered).

Rules:
- Be terse. 1-2 sentences. ~30 words max.
- Lead with what changed since prior narration. If nothing changed visibly, say "no visible change".
- Read on-screen text verbatim when it's load-bearing (error banners, dialog text, tool-card status, assistant prose tail).
- Never invent. If text is too small or cut off, say "(text below fold)".
- Never opine. No "this looks good" / "this looks bad". Just facts.
- No preamble. No "I see...". Just the observation.`;

export class VisionNarrator {
  constructor({
    modelId = process.env.BRAINBOW_VISION_MODEL || DEFAULT_MODEL_ID,
    region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || DEFAULT_REGION,
    intervalMs = Number.parseInt(process.env.BRAINBOW_VISION_INTERVAL_MS || `${DEFAULT_INTERVAL_MS}`),
    maxTokens = Number.parseInt(process.env.BRAINBOW_VISION_MAX_TOKENS || `${DEFAULT_MAX_TOKENS}`),
    ringSize = Number.parseInt(process.env.BRAINBOW_VISION_RING_SIZE || `${DEFAULT_RING_SIZE}`),
  } = {}) {
    this.modelId = modelId;
    this.region = region;
    this.intervalMs = Math.max(750, intervalMs);
    this.maxTokens = maxTokens;
    this.ringSize = ringSize;
    this.client = null;
    this.lastError = null;
  }

  ensureClient() {
    if (!this.client) {
      this.client = new BedrockRuntimeClient({ region: this.region });
    }
    return this.client;
  }

  /**
   * Run ONE narration call against the most recent frame on `session`.
   * Returns { ts, body, frameTs } on success or { ts, error } on failure.
   * Caller is responsible for appending the result to session.visionNarration.
   */
  async narrateOnce(session) {
    const frameB64 = session?.lastFrameB64;
    if (!frameB64) {
      return { ts: Date.now(), error: 'no_frame_yet' };
    }
    const priorTail = (session.visionNarration || []).slice(-4).map(e => `[${new Date(e.ts).toISOString().slice(11, 19)}] ${e.body || e.error || ''}`).join('\n');

    const messages = [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: frameB64 },
          },
          {
            type: 'text',
            text: `URL: ${session.page?.url?.() || '(none)'}\nPrior narration tail (most recent last):\n${priorTail || '(none)'}\n\nNarrate the current frame per the system rules.`,
          },
        ],
      },
    ];

    const body = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: this.maxTokens,
      system: SYSTEM_PROMPT,
      messages,
    };

    try {
      const cmd = new InvokeModelCommand({
        modelId: this.modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(body),
      });
      const res = await this.ensureClient().send(cmd);
      const decoded = new TextDecoder().decode(res.body);
      const parsed = JSON.parse(decoded);
      const text = (parsed.content || [])
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('')
        .trim();
      this.lastError = null;
      return { ts: Date.now(), body: text || '(empty narration)', frameTs: session.frameBuffer?.at?.(-1)?.ts || Date.now() };
    } catch (e) {
      const msg = String(e?.message || e);
      if (this.lastError !== msg) {
        console.error(`[VisionNarrator:${session.sessionId}] ${msg}`);
        this.lastError = msg;
      }
      return { ts: Date.now(), error: msg };
    }
  }

  /**
   * Start a continuous narration loop on `session`. Idempotent — calling
   * twice is a no-op. The loop runs on a setInterval; each tick narrates
   * the most-recent frame and pushes onto session.visionNarration (ring
   * buffer of `ringSize` entries).
   */
  start(session) {
    if (session.visionInterval) return;
    session.visionWatching = true;
    session.visionNarration = session.visionNarration || [];
    session.visionError = null;
    const tick = async () => {
      if (!session.visionWatching) return;
      try {
        const entry = await this.narrateOnce(session);
        if (!session.visionWatching) return;
        session.visionNarration.push(entry);
        if (session.visionNarration.length > this.ringSize) {
          session.visionNarration.splice(0, session.visionNarration.length - this.ringSize);
        }
        if (entry.body) session.visionDescription = entry.body;
        if (entry.body) session.visionTimestamp = entry.ts;
        if (entry.error) session.visionError = entry.error;
      } catch (e) {
        session.visionError = String(e?.message || e);
      }
    };
    session.visionInterval = setInterval(tick, this.intervalMs);
    setImmediate(tick);
  }

  stop(session) {
    if (session.visionInterval) {
      clearInterval(session.visionInterval);
      session.visionInterval = null;
    }
    session.visionWatching = false;
  }
}

export const sharedVisionNarrator = new VisionNarrator();
