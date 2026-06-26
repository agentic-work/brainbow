// SPDX-License-Identifier: MIT
//
// Brainbow — programmatic library API. Use this if you want to embed a
// brainbow instance INSIDE your Node app (the way `playwright.chromium
// .launch()` works) instead of running the REST server.
//
//   import { Brainbow } from '@agenticwork/brainbow';
//   const bb = await Brainbow.launch({
//     url: 'https://example.com',
//     width: 1280, height: 800,
//     vision: { provider: 'ollama', model: 'qwen2.5vl:7b', intervalMs: 1500 },
//     logs: [{ name: 'api', command: 'kubectl logs -f deployment/my-api -n my-namespace' }],
//   });
//   const snap = await bb.observe();    // { image, narration, dom, console, logs, cursor }
//   await bb.click({ selector: 'button.login' });
//   await bb.type('hello');
//   await bb.goto('https://google.com');
//   for await (const ev of bb.stream()) { ... }
//   await bb.close();
//
// Each .launch() returns an isolated instance with its own chrome profile,
// its own session id, its own vision narrator, its own log tails. Multiple
// concurrent instances are safe — they don't share state.
//
// Apps that need a viewer can call `bb.viewerHandle()` to get a snapshot
// (image + DOM + narration) on demand, OR mount the existing brainbow REST
// server alongside via `bb.serve(port)` and share the viewer URL.

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Session } from './session.js';
import { VisionNarrator } from './vision-narrator.js';
import { createVisionProvider } from './vision-providers/index.js';
import { LogTailManager } from './log-tail.js';

/**
 * One isolated brainbow instance. Public API mirrors what the REST server
 * exposes, but in-process and per-instance.
 */
export class Brainbow extends EventEmitter {
  /**
   * Spawn a new brainbow instance.
   *
   * @param {Object} opts
   * @param {string} [opts.url]             — initial URL to load
   * @param {string} [opts.sessionId]       — override the auto-generated id
   * @param {number} [opts.width=1920]      — viewport width (HD recording quality)
   * @param {number} [opts.height=1200]     — viewport height
   * @param {Object|false} [opts.vision]    — vision narrator config OR false to disable
   * @param {string} [opts.vision.provider] — 'ollama'|'bedrock'|'openai'|'anthropic'
   * @param {string} [opts.vision.model]    — model id
   * @param {number} [opts.vision.intervalMs] — narration tick (default 2500)
   * @param {Array}  [opts.logs]            — [{name, command}] tails to start
   * @returns {Promise<Brainbow>}
   */
  static async launch(opts = {}) {
    const sessionId = opts.sessionId || `bb-${randomUUID().slice(0, 8)}`;
    const session = new Session(sessionId, {
      maxFrameBufferSize: opts.maxFrameBufferSize,
      maxActionLogSize: opts.maxActionLogSize,
    });

    let narrator = null;
    if (opts.vision !== false) {
      const visionOpts = opts.vision || {};
      const provider = createVisionProvider(visionOpts.provider, visionOpts);
      narrator = new VisionNarrator({
        provider,
        intervalMs: visionOpts.intervalMs,
        ringSize: visionOpts.ringSize,
      });
    }

    const logs = new LogTailManager({ enabled: true });
    for (const t of opts.logs || []) logs.subscribe({ name: t.name, command: t.command });

    await session.launch({ url: opts.url, width: opts.width, height: opts.height });
    if (narrator) narrator.start(session);

    return new Brainbow({ session, narrator, logs });
  }

  constructor({ session, narrator, logs }) {
    super();
    this._session = session;
    this._narrator = narrator;
    this._logs = logs;
    this._cursor = 0;
    this._closed = false;
  }

  get sessionId() { return this._session.sessionId; }
  get url() { return this._session.page?.url?.() || null; }
  get provider() { return this._narrator?.providerName || null; }
  get model() { return this._narrator?.model || null; }

  /**
   * One-shot snapshot of everything — image + DOM + narration delta + console
   * delta + log tail delta — since the last observe() call (or `since` ts).
   */
  async observe({ image = true, dom = true, since = null } = {}) {
    const cursor = since ?? this._cursor;
    const now = Date.now();
    const page = this._session.page;
    const url = page?.url?.() || null;
    const title = await page?.title?.().catch(() => null);

    let domSnap = null;
    if (dom && page) {
      try {
        domSnap = await page.evaluate(() => ({
          counts: {
            toolCards: document.querySelectorAll('[data-testid*="tool-card"], .tool-card, .cm-tool-card').length,
            iframes: document.querySelectorAll('iframe').length,
            buttons: document.querySelectorAll('button').length,
            inputs: document.querySelectorAll('input, textarea').length,
            messages: document.querySelectorAll('[data-testid*="message"], .message-bubble').length,
          },
          isStreaming: document.querySelector('[data-streaming="true"]') != null,
          bodyTextTail: (document.body?.innerText || '').slice(-2000),
        }));
      } catch { /* page navigating */ }
    }

    const narrationDelta = (this._session.visionNarration || []).filter(e => e.ts > cursor);
    const consoleDelta = (this._session.consoleMessages || []).filter(e => e.ts > cursor);
    const actionDelta = (this._session.actionLog || [])
      .map(a => ({ ...a, ts: Date.parse(a.ts) || Date.now() }))
      .filter(a => a.ts > cursor);
    const logsDelta = this._logs.snapshot(cursor);
    const imageB64 = image ? this._session.lastFrameB64 : null;

    this._cursor = now;
    return {
      sessionId: this.sessionId,
      cursor: now,
      url, title,
      image: imageB64,
      imageMimeType: imageB64 ? 'image/jpeg' : null,
      dom: domSnap,
      narration: {
        watching: this._session.visionWatching,
        provider: this.provider, model: this.model,
        latestBody: this._session.visionDescription,
        latestTs: this._session.visionTimestamp,
        lastError: this._session.visionError,
        delta: narrationDelta,
      },
      consoleDelta,
      actionDelta,
      logsDelta,
    };
  }

  /** Async-iterable stream of every NDJSON event for this instance. */
  async *stream() {
    let cursor = 0;
    while (!this._closed) {
      await new Promise(r => setTimeout(r, 750));
      if (this._closed) break;
      const snap = await this.observe({ image: false, dom: false, since: cursor });
      cursor = snap.cursor;
      for (const e of snap.narration.delta) yield { type: 'narration', ...e };
      for (const e of snap.consoleDelta) yield { type: 'console', ...e };
      for (const e of snap.actionDelta) yield { type: 'action', ...e };
      for (const [name, lines] of Object.entries(snap.logsDelta)) {
        for (const l of lines) yield { type: 'log', name, ...l };
      }
    }
  }

  /** Click an element by selector OR by {x, y}. */
  async click({ selector, x, y, button = 'left' } = {}) {
    const page = this._requirePage();
    if (selector) {
      await page.waitForSelector(selector, { timeout: 5000 });
      await page.click(selector, { button });
    } else if (typeof x === 'number' && typeof y === 'number') {
      await page.mouse.click(x, y, { button });
    } else throw new Error('click needs selector OR x+y');
    this._session.log('click', selector || `(${x},${y})`);
  }

  /** Type text into the page (optionally focusing a selector first). */
  async type(text, { selector, delay = 0 } = {}) {
    const page = this._requirePage();
    if (selector) await page.focus(selector);
    await page.keyboard.type(text, { delay });
    this._session.log('type', text.slice(0, 80));
  }

  /** Press a single key (Enter, Escape, Tab, etc). */
  async key(key) {
    const page = this._requirePage();
    await page.keyboard.press(key);
    this._session.log('key', key);
  }

  /** Navigate to a URL. */
  async goto(url, { waitUntil = 'domcontentloaded', timeout = 30000 } = {}) {
    const page = this._requirePage();
    await page.goto(url, { waitUntil, timeout });
    this._session.log('goto', url);
  }

  /** Run JS in the page context, returns the JSON-serializable result. */
  async eval(scriptOrFn, ...args) {
    const page = this._requirePage();
    return page.evaluate(scriptOrFn, ...args);
  }

  /** Wait for selector / text / urlContains. */
  async waitFor({ selector, text, urlContains, timeout = 15000 } = {}) {
    const page = this._requirePage();
    if (selector) return page.waitForSelector(selector, { timeout });
    if (text) return page.waitForFunction((t) => document.body?.innerText?.includes(t), { timeout }, text);
    if (urlContains) return page.waitForFunction((u) => location.href.includes(u), { timeout }, urlContains);
    throw new Error('waitFor needs selector|text|urlContains');
  }

  /** Capture a fresh screenshot as a Buffer. */
  async screenshot({ type = 'jpeg', quality = 85, fullPage = false } = {}) {
    const page = this._requirePage();
    return page.screenshot({ type, quality, fullPage });
  }

  /** Subscribe to an external log tail (kubectl logs -f etc). */
  subscribeLog({ name, command }) {
    return this._logs.subscribe({ name, command });
  }
  unsubscribeLog(name) { return this._logs.unsubscribe(name); }
  listLogs() { return this._logs.list(); }

  /** Tear it all down. */
  async close() {
    if (this._closed) return;
    this._closed = true;
    if (this._narrator) this._narrator.stop(this._session);
    this._logs.stopAll();
    await this._session.close();
  }

  _requirePage() {
    if (this._closed) throw new Error('Brainbow instance is closed');
    if (!this._session.page) throw new Error('no page — did the chrome crash?');
    return this._session.page;
  }
}

export default { Brainbow };
