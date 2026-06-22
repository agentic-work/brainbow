// SPDX-License-Identifier: MIT
//
// VisionNarrator — continuous live narration of the CDP frame stream.
//
// Provider-pluggable. The EFFECTIVE default is decided by the launcher /
// src/vision-model-select.js, NOT this file's per-provider fallbacks:
//   - Inside a Claude Code session (CLAUDECODE=1), with no explicit pin and
//     working creds → Opus 4.8 (anthropic API id, or Bedrock us.anthropic.*).
//   - No creds → honest local fallback (ollama/moondream) + a visible warning.
//   - createVisionProvider() itself defaults to provider='bedrock' when nothing
//     is set (src/vision-providers/index.js:27).
// Any vision-capable provider works: bedrock, anthropic (direct), openai,
// ollama. Add one by writing a file in `src/vision-providers/`.
//
// Select provider/model via env (an explicit pin always wins):
//   BRAINBOW_VISION_PROVIDER  ollama | bedrock (default) | openai | anthropic
//   BRAINBOW_VISION_MODEL     model id for the chosen provider
//   BRAINBOW_VISION_INTERVAL_MS    default 2500ms between narrations (floor 750)
//   BRAINBOW_VISION_STALE_FRAME_MS frame older than this → flagged `stale`

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
    // A frame older than this is considered STALE (screencast quiet / dropped).
    // Default = 4x the interval so a normal idle gap doesn't flag.
    this.staleFrameMs = Number.parseInt(
      process.env.BRAINBOW_VISION_STALE_FRAME_MS || `${Math.max(4000, this.intervalMs * 4)}`
    );
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

    // REALTIME FRESHNESS: the newest CDP frame carries a ts. If it is older
    // than the staleness budget, the screencast has gone quiet (page idle,
    // CDP dropped, or chromium disconnected). Narrating a stale frame would
    // make the live view LIE about "now". Mark it explicitly so the caller /
    // /api/live can surface staleness instead of presenting old observations
    // as current. (A truly static page is fine — we still return the body but
    // flag frameAgeMs so the operator knows the pixels haven't moved.)
    const newestTs = session.frameBuffer?.at?.(-1)?.ts || 0;
    const frameAgeMs = newestTs ? Date.now() - newestTs : null;

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
        frameTs: newestTs || Date.now(),
        frameAgeMs,
        stale: frameAgeMs != null && frameAgeMs > this.staleFrameMs,
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
    // Reentrancy guard: a single narration call (esp. Opus 4.8 over the
    // network) can take LONGER than the interval. Without this, setInterval
    // stacks overlapping in-flight calls → out-of-order entries, wasted
    // tokens, and a narrator that falls further behind "now". We skip a tick
    // while one is already in flight so the loop always reflects the LATEST
    // frame on the NEXT free slot.
    session._visionTickInFlight = false;
    const tick = async () => {
      if (!session.visionWatching) return;
      if (session._visionTickInFlight) return;       // a prior narration is still running
      session._visionTickInFlight = true;
      try {
        const entry = await this.narrateOnce(session);
        if (!session.visionWatching) return;
        session.visionNarration.push(entry);
        if (session.visionNarration.length > this.ringSize) {
          session.visionNarration.splice(0, session.visionNarration.length - this.ringSize);
        }
        if (entry.body) session.visionDescription = entry.body;
        if (entry.body) session.visionTimestamp = entry.ts;
        // Surface provider errors on the session so /api/live.narration.lastError
        // shows them; clear it on a clean body so a recovered provider stops
        // reporting a stale error.
        if (entry.error) session.visionError = entry.error;
        else if (entry.body) session.visionError = null;
        appendStreamEvent({ type: 'narration', sessionId: session.sessionId, ...entry });
      } catch (e) {
        session.visionError = String(e?.message || e);
      } finally {
        session._visionTickInFlight = false;
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
