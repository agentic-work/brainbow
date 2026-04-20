// SPDX-License-Identifier: MIT
//
// Session: per-sessionId state container. Owns one browser, one CDP
// session, one bounded frame buffer, one action log, recording state,
// HITL queue, and vision cache. All previously module-global state in
// server.js moves here so multi-session works with no rewrite (spec §7).

import puppeteer from 'puppeteer-core';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactSecrets } from './redaction.js';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);

export function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  try {
    return execSync('which chromium || which chromium-browser || which google-chrome 2>/dev/null', { encoding: 'utf8' }).trim().split('\n')[0];
  } catch {}
  const fallbacks = [
    path.join(os.homedir(), '.cache/ms-playwright/chromium-*/chrome-linux/chrome'),
    path.join(os.homedir(), '.cache/puppeteer/chrome/*/chrome-linux64/chrome'),
  ];
  for (const pattern of fallbacks) {
    try {
      const result = execSync(`ls ${pattern} 2>/dev/null | head -1`, { encoding: 'utf8' }).trim();
      if (result && fs.existsSync(result)) return result;
    } catch {}
  }
  throw new Error('No Chromium found. Set CHROME_PATH env or install: apt-get install chromium');
}

const DEFAULT_FRAME_BUFFER = 300;     // ~10s @ 30fps
const DEFAULT_ACTION_LOG = 200;
// Bumped from 1440x900 → 1920x1200 so observe() screenshots fit more
// chat/code content in a single frame. Agents (Claude) auto-downscale
// the image in their Read tool anyway; higher source resolution gives
// them sharper text in the downscaled view. Users can still override
// per-launch via { width, height } in the launch payload.
const DEFAULT_VIEWPORT = { width: 1920, height: 1200 };

export class Session {
  constructor(sessionId, opts = {}) {
    this.sessionId = sessionId;
    this.maxFrameBufferSize = opts.maxFrameBufferSize ?? DEFAULT_FRAME_BUFFER;
    this.maxActionLogSize = opts.maxActionLogSize ?? DEFAULT_ACTION_LOG;

    // Browser state — lazy
    this.browser = null;
    this.page = null;
    this.cdpSession = null;
    this.screencastRunning = false;

    // Frame state
    this.lastFrameB64 = null;
    this.frameBuffer = [];                 // recent N frames for catch-up
    this.viewport = { ...DEFAULT_VIEWPORT };

    // Recording state
    this.recording = false;
    this.recordFrames = [];
    this.recordStartTime = 0;
    this.recordZoom = null;

    // Action log
    this.actionLog = [];

    // HITL state
    this.hitlPending = null;
    this.lastHitlResponse = null;

    // Vision state
    this.visionDescription = '';
    this.visionTimestamp = 0;
    this.visionWatching = false;
    this.visionInterval = null;
    this.visionError = null;

    // Console messages captured from the page — ring buffer of the last
    // N log/warn/error entries. Populated on launch() via the console
    // event listener. Exposed via GET /api/console for agents that
    // need to verify page-side state (e.g. "did the app hit a React
    // warning during this turn?") without opening DevTools.
    this.consoleMessages = [];
    this.maxConsoleSize = 200;

    // Subscribers (WebSocket viewers tied to this session)
    this.subscribers = new Set();
  }

  pushFrame(base64Data, ts = Date.now()) {
    this.lastFrameB64 = base64Data;
    this.frameBuffer.push({ data: base64Data, ts });
    if (this.frameBuffer.length > this.maxFrameBufferSize) {
      this.frameBuffer.shift();
    }
    if (this.recording) {
      this.recordFrames.push({ data: base64Data, ts: Date.now() - this.recordStartTime });
    }
  }

  log(action, detail = '') {
    const safeDetail = redactSecrets(String(detail).substring(0, 500));
    const entry = { ts: new Date().toISOString(), action, detail: safeDetail, sessionId: this.sessionId };
    this.actionLog.push(entry);
    if (this.actionLog.length > this.maxActionLogSize) this.actionLog.shift();
    return entry;
  }

  subscribe(ws) { this.subscribers.add(ws); }
  unsubscribe(ws) { this.subscribers.delete(ws); }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of this.subscribers) {
      if (ws.readyState === 1) ws.send(data);
    }
  }

  async launch(opts = {}) {
    if (this.browser) await this.close();

    const chromePath = findChrome();
    this.log('launch', `chrome=${chromePath} url=${opts.url || 'about:blank'}`);

    const width = opts.width || this.viewport.width;
    const height = opts.height || this.viewport.height;
    this.viewport = { width, height };

    this.browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        `--window-size=${width},${height}`,
        '--disable-gpu',
        '--disable-extensions',
        '--no-first-run',
        '--disable-default-apps',
      ],
    });

    this.page = (await this.browser.pages())[0] || await this.browser.newPage();
    await this.page.setViewport({ width, height });

    this.page.on('load', () => this.log('page-load', this.page.url()));
    this.page.on('dialog', async (dialog) => {
      this.log('dialog', `${dialog.type()}: ${dialog.message()}`);
      this.broadcast({ type: 'dialog', dialogType: dialog.type(), message: dialog.message() });
    });
    // Capture console output — ring buffer exposed via /api/console.
    this.page.on('console', (msg) => {
      const entry = {
        ts: Date.now(),
        type: msg.type(),                       // log | warning | error | info | debug
        text: String(msg.text()).slice(0, 1000),
        location: msg.location()?.url || '',
      };
      this.consoleMessages.push(entry);
      if (this.consoleMessages.length > this.maxConsoleSize) {
        this.consoleMessages.shift();
      }
    });
    this.page.on('pageerror', (err) => {
      this.consoleMessages.push({
        ts: Date.now(),
        type: 'pageerror',
        text: String(err.message || err).slice(0, 1000),
        location: '',
      });
      if (this.consoleMessages.length > this.maxConsoleSize) {
        this.consoleMessages.shift();
      }
    });

    if (opts.url) {
      await this.page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }

    await this.startScreencast();
    return { ok: true, url: this.page.url() };
  }

  async startScreencast() {
    if (!this.page || this.screencastRunning) return;
    try {
      this.cdpSession = await this.page.createCDPSession();
      this.cdpSession.on('Page.screencastFrame', async (params) => {
        this.pushFrame(params.data);
        this.broadcast({ type: 'frame', data: params.data });
        try {
          await this.cdpSession.send('Page.screencastFrameAck', { sessionId: params.sessionId });
        } catch { /* session closed */ }
      });
      await this.cdpSession.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 80,
        maxWidth: this.viewport.width,
        maxHeight: this.viewport.height,
        everyNthFrame: 1,
      });
      this.screencastRunning = true;
      this.log('screencast', 'started (CDP)');
    } catch (e) {
      console.error(`[Brainbow:${this.sessionId}] CDP screencast failed:`, e.message);
      this.startScreenshotFallback();
    }
  }

  startScreenshotFallback() {
    if (this._fallbackInterval) return;
    this._fallbackInterval = setInterval(async () => {
      if (!this.page) return;
      try {
        const buf = await this.page.screenshot({ type: 'jpeg', quality: 75 });
        const b64 = buf.toString('base64');
        this.pushFrame(b64);
        this.broadcast({ type: 'frame', data: b64 });
      } catch {}
    }, 100);
  }

  async stopScreencast() {
    if (this.cdpSession && this.screencastRunning) {
      try { await this.cdpSession.send('Page.stopScreencast'); } catch {}
      this.screencastRunning = false;
    }
    if (this._fallbackInterval) {
      clearInterval(this._fallbackInterval);
      this._fallbackInterval = null;
    }
  }

  /**
   * Resize the viewport on an active browser session.
   *
   * Why this is a first-class action (not just "relaunch with new dims"):
   * the caller shouldn't have to teardown + rebuild the session (losing
   * cookies, page state, scroll, etc.) just to swap from 1280×720 to
   * 1600×1000. Flow: stop the screencast → set the page viewport →
   * restart the screencast at the new max-dims so the frame buffer
   * starts pushing at the right resolution immediately.
   */
  async resize(width, height) {
    if (!this.page) throw new Error('No browser open. launch() first.');
    const w = Math.max(320, Math.min(4096, Math.round(Number(width))));
    const h = Math.max(240, Math.min(4096, Math.round(Number(height))));
    if (!Number.isFinite(w) || !Number.isFinite(h)) {
      throw new Error(`Invalid resize dims: ${width}x${height}`);
    }
    await this.stopScreencast();
    this.viewport = { width: w, height: h };
    await this.page.setViewport({ width: w, height: h });
    await this.startScreencast();
    this.log('resize', `${w}x${h}`);
    return { ok: true, width: w, height: h };
  }

  /**
   * Accessibility-tree snapshot — mirrors the shape Playwright's
   * browser_snapshot returns: a JSON tree of role/name/value/children.
   * Handy for agents that want to pick elements by role without CSS
   * selectors. Puppeteer exposes this via `page.accessibility.snapshot`.
   */
  async snapshot(opts = {}) {
    if (!this.page) throw new Error('No browser open. launch() first.');
    const tree = await this.page.accessibility.snapshot({
      interestingOnly: opts.interestingOnly !== false,
      root: undefined,
    });
    return {
      url: this.page.url(),
      title: await this.page.title().catch(() => ''),
      viewport: { ...this.viewport },
      tree,
    };
  }

  async close() {
    if (this.recording) { this.recording = false; this.recordFrames = []; }
    await this.stopScreencast();
    if (this.visionInterval) {
      clearInterval(this.visionInterval);
      this.visionInterval = null;
    }
    if (this.browser) {
      try { await this.browser.close(); } catch {}
      this.browser = null;
      this.page = null;
      this.cdpSession = null;
    }
    this.subscribers.clear();
    this.log('closed');
  }
}
