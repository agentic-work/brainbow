// SPDX-License-Identifier: MIT
//
// VisionNarrator — continuous live narration of the CDP frame stream.
//
// Provider-pluggable. DEFAULT = local Ollama on the 4090 with qwen2.5vl:7b
// (free, fast, private). Any vision-capable provider works: Bedrock,
// OpenAI, Anthropic direct, OpenAI-compatible (Azure AIF, vLLM, etc).
// Add a new provider by writing one file in `src/vision-providers/`.
//
// Select provider via env:
//   BRAINBOW_VISION_PROVIDER  ollama (default) | bedrock | openai | anthropic
//   BRAINBOW_VISION_MODEL     defaults per-provider; override here
//   BRAINBOW_VISION_INTERVAL_MS   default 2500ms between narrations
//
// Why local-Ollama default: brainbow watches every frame at ~2.5s
// cadence. On a 24GB 4090 with qwen2.5vl:7b you get ~30 tok/s of
// vision narration for free. Bedrock would cost ~$0.003 per call =
// $4.30/hour. Default goes free + local.

import { appendStreamEvent } from './stream-log.js';
import { createVisionProvider } from './vision-providers/index.js';

const DEFAULT_INTERVAL_MS = 2500;
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
    provider = null,                // pass an explicit provider; default = createVisionProvider()
    intervalMs = Number.parseInt(process.env.BRAINBOW_VISION_INTERVAL_MS || `${DEFAULT_INTERVAL_MS}`),
    ringSize = Number.parseInt(process.env.BRAINBOW_VISION_RING_SIZE || `${DEFAULT_RING_SIZE}`),
  } = {}) {
    this.provider = provider || createVisionProvider();
    this.intervalMs = Math.max(750, intervalMs);
    this.ringSize = ringSize;
    this.lastError = null;
  }

  get model() { return this.provider.model; }
  get providerName() { return this.provider.name; }

  /**
   * One narration call against `session`'s most-recent frame.
   * Returns { ts, body, frameTs } on success or { ts, error } on failure.
   * Caller is responsible for appending the result to session.visionNarration.
   */
  async narrateOnce(session) {
    const frameB64 = session?.lastFrameB64;
    if (!frameB64) return { ts: Date.now(), error: 'no_frame_yet' };

    const priorTail = (session.visionNarration || [])
      .slice(-4)
      .map(e => `[${new Date(e.ts).toISOString().slice(11, 19)}] ${e.body || e.error || ''}`)
      .join('\n');

    const user = `URL: ${session.page?.url?.() || '(none)'}\nPrior narration tail (most recent last):\n${priorTail || '(none)'}\n\nNarrate the current frame per the system rules.`;

    try {
      const body = await this.provider.narrate({ system: SYSTEM_PROMPT, user, imageB64: frameB64 });
      this.lastError = null;
      return {
        ts: Date.now(),
        body,
        frameTs: session.frameBuffer?.at?.(-1)?.ts || Date.now(),
      };
    } catch (e) {
      const msg = String(e?.message || e);
      if (this.lastError !== msg) {
        console.error(`[VisionNarrator:${session.sessionId} provider=${this.provider.name} model=${this.provider.model}] ${msg}`);
        this.lastError = msg;
      }
      return { ts: Date.now(), error: msg };
    }
  }

  /** Start a continuous narration loop on `session`. Idempotent. */
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
        appendStreamEvent({ type: 'narration', sessionId: session.sessionId, ...entry });
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
