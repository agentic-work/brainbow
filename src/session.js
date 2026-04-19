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
const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

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
