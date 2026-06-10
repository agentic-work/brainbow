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
import { appendStreamEvent } from './stream-log.js';

// When BRAINBOW_FRAME_LOG is set, Session writes one NDJSON line per
// unique screencast frame: { ts, sessionId, tabIndex, url, path }. The
// `path` is a per-frame PNG written to /tmp/brainbow-frames/. Agents
// that want to watch the stream live can `Monitor` this file and
// Read each line's `path` as a new frame arrives — closest thing to
// "see it live" available through request/response tool protocols.
// Left OFF by default (no disk IO impact); opt-in via env.
const FRAME_LOG_PATH = process.env.BRAINBOW_FRAME_LOG || '';
const FRAME_LOG_SAMPLE_MS = Number.parseInt(process.env.BRAINBOW_FRAME_LOG_SAMPLE_MS || '400');
const FRAME_LOG_DIR = path.join(os.tmpdir(), 'brainbow-frames');
if (FRAME_LOG_PATH) {
  try { fs.mkdirSync(FRAME_LOG_DIR, { recursive: true }); } catch {}
}

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

    // Browser state — lazy.
    // `tabs` tracks every open page so /api/tabs/* can list/switch/close.
    // `page` is a plain property that always points at the currently
    // active tab; all existing endpoints use it and don't need to know
    // that multi-tab exists unless they care.
    this.browser = null;
    this.page = null;
    this.tabs = [];
    this.cdpSession = null;
    this.screencastRunning = false;

    // ─── Durable recovery state (survives a chromium disconnect) ──────────
    // `wasLaunched` records that this session ever had a browser, so the REST
    // requireBrowser() guard knows transparent relaunch is allowed even after
    // the disconnect handler has nulled `this.browser`. `lastUrl` records the
    // last successfully-navigated URL so ensureBrowser() relaunches BACK TO
    // WHERE WE WERE — the persistent profile keeps cookies, so the web-app
    // session stays valid and the user is NOT bounced to about:blank / re-SSO.
    // The disconnect handler clears the dead handles but MUST NOT clear these.
    this.wasLaunched = false;
    this.lastUrl = null;

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

    // Page-text watcher — polls document.body.innerText every
    // BRAINBOW_PAGE_TEXT_INTERVAL_MS (default 2000ms). If the text
    // delta from last poll is non-trivial (>40 chars added/removed),
    // emit a `page_text` NDJSON event with the new tail + headings +
    // links so the AI sees what the vision narrator might miss
    // (small text, below-fold content, links/buttons by label).
    this.pageTextInterval = null;
    this.lastPageText = '';
    this.pageTextWatching = false;

    // Subscribers (WebSocket viewers tied to this session)
    this.subscribers = new Set();

    // Last-frame-log write timestamp (ms). The CDP screencast fires at
    // ~30fps; writing every single frame to disk would thrash IO. We
    // sample at FRAME_LOG_SAMPLE_MS (default 400ms = ~2.5fps) which
    // gives an agent enough granularity to "watch" without overwhelming.
    this._lastFrameLogTs = 0;
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
    // Live-frame-log: sampled, opt-in. Writes one JPEG per sampled
    // frame and appends an NDJSON event (type: 'frame') via
    // appendStreamEvent so frames + narration + log-tail lines share
    // one Monitor-able stream.
    if (FRAME_LOG_PATH && ts - this._lastFrameLogTs >= FRAME_LOG_SAMPLE_MS) {
      this._lastFrameLogTs = ts;
      try {
        const framePath = path.join(FRAME_LOG_DIR, `${this.sessionId}-${ts}.jpg`);
        fs.writeFileSync(framePath, Buffer.from(base64Data, 'base64'));
        appendStreamEvent({
          type: 'frame',
          ts,
          sessionId: this.sessionId,
          tabIndex: this.tabs?.indexOf(this.page) ?? 0,
          url: this.page?.url?.() || '',
          path: framePath,
        });
      } catch { /* disk full / perm issue → silently skip */ }
    }
  }

  log(action, detail = '') {
    const safeDetail = redactSecrets(String(detail).substring(0, 500));
    const entry = { ts: new Date().toISOString(), action, detail: safeDetail, sessionId: this.sessionId };
    this.actionLog.push(entry);
    if (this.actionLog.length > this.maxActionLogSize) this.actionLog.shift();
    // Broadcast as 'action' so the viewer's right-side log panel
    // populates in real time. The ws handler in ui.html already routes
    // {type:'action'} → addLog; the only missing piece was this push.
    this.broadcast({ type: 'action', ...entry });
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

  /**
   * Is there a live, connected browser with a usable page right now?
   * Puppeteer's browser.isConnected() flips false the instant the
   * Chromium process dies — that's the authoritative liveness check
   * (a non-null `this.page` can still be a dead handle after a crash).
   */
  isAlive() {
    try {
      return !!(this.browser && this.browser.isConnected() && this.page && !this.page.isClosed?.());
    } catch {
      return false;
    }
  }

  /**
   * Guarantee a usable browser before an action. If the browser crashed
   * or was never launched, (re)launch transparently so callers never see
   * a "Target closed" / "No browser open" error from a recoverable state.
   * Preserves the last viewport + reopens the last URL when we have one.
   * Returns true if a relaunch happened (caller may want to re-navigate).
   */
  async ensureBrowser(opts = {}) {
    if (this.isAlive()) return false;
    // Tear down any half-dead remnants before a clean relaunch.
    if (this.browser) {
      try { await this.close(); } catch { /* best effort */ }
    }
    this.log('ensure-browser', `relaunching dead/absent browser → ${this.lastUrl || 'about:blank'}`);
    await this.launch({
      // Reopen WHERE WE WERE so a dropped chromium transparently comes back to
      // the same page. Persistent profile means cookies survive → no re-login.
      url: this.lastUrl || undefined,
      width: this.viewport.width,
      height: this.viewport.height,
      ...opts,
    });
    return true;
  }

  /**
   * Actually spawn the puppeteer browser. Isolated into one method so unit
   * tests can override it with a fake browser (via `_launchBrowserForTest`)
   * and exercise launch()'s state-setting logic without a real Chromium.
   */
  async _launchBrowser(launchOpts) {
    if (this._launchBrowserForTest) return this._launchBrowserForTest(launchOpts);
    return puppeteer.launch(launchOpts);
  }

  async launch(opts = {}) {
    if (this.browser) await this.close();

    const chromePath = findChrome();
    this.log('launch', `chrome=${chromePath} url=${opts.url || 'about:blank'}`);

    // Mark the session as having been launched BEFORE the (possibly slow)
    // browser spawn. This is the durable flag requireBrowser() gates recovery
    // on — it must be set even if a later step (goto) throws, so a partial
    // launch is still recoverable rather than reading as "never launched".
    this.wasLaunched = true;

    const width = opts.width || this.viewport.width;
    const height = opts.height || this.viewport.height;
    this.viewport = { width, height };

    // Persistent profile — cookies, saved creds, session storage all
    // survive across /api/launch cycles. Without this, every relaunch
    // drops the user back on the login page (user feedback: "why isn't
    // it saving creds like a normal browser would"). Profile dir is
    // per-sessionId so multiple sessions don't stomp each other.
    const profileDir = process.env.BRAINBOW_PROFILE_DIR
      || path.join(os.homedir(), '.cache', 'brainbow', 'profiles', this.sessionId);
    try { fs.mkdirSync(profileDir, { recursive: true }); } catch {}
    this.log('profile', profileDir);

    this.browser = await this._launchBrowser({
      executablePath: chromePath,
      headless: 'new',
      userDataDir: profileDir,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        `--window-size=${width},${height}`,
        '--disable-gpu',
        '--disable-extensions',
        '--no-first-run',
        '--disable-default-apps',
        // Let Chromium keep cookies + local storage across runs.
        '--restore-last-session',
      ],
    });

    // Detect Chromium crashes / unexpected exits. In headless WSL2 the
    // GPU/renderer process can OOM or hang and the browser disconnects.
    // Without this listener the stale `this.browser`/`this.page` handles
    // linger and the NEXT tool call throws "Target closed" deep inside an
    // async path (which used to crash the unguarded server). Null the
    // handles so isAlive() returns false and ensureBrowser() can relaunch
    // transparently on the next call.
    this.browser.on('disconnected', () => {
      this.log('browser-disconnected', `chromium exited/crashed — handles cleared, will relaunch to ${this.lastUrl || 'about:blank'} on next use`);
      this.screencastRunning = false;
      this.cdpSession = null;
      this.browser = null;
      this.page = null;
      this.tabs = [];
      // NOTE: deliberately do NOT clear wasLaunched / lastUrl here. Those are
      // the DURABLE recovery state — clearing them is exactly the bug that
      // defeated self-healing (requireBrowser saw browser=null and gave up,
      // and a manual relaunch landed on about:blank → user logged out). The
      // browser/page/cdp/tabs handles above ARE dead; the recovery intent is
      // not.
      this.stopPageTextWatcher();
    });

    const firstPage = (await this.browser.pages())[0] || await this.browser.newPage();
    await firstPage.setViewport({ width, height });
    this.attachPageListeners(firstPage);
    this.tabs = [firstPage];
    this.page = firstPage;

    if (opts.url) {
      await this.page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      // Record where we landed so a later disconnect can relaunch BACK here.
      this.lastUrl = opts.url;
    }
    // Capture the live URL (covers about:blank-less restores + any redirect).
    try {
      const landed = this.page.url();
      if (landed && landed !== 'about:blank') this.lastUrl = landed;
    } catch { /* page may be detaching — keep prior lastUrl */ }

    await this.startScreencast();
    this.startPageTextWatcher();
    return { ok: true, url: this.page.url() };
  }

  /**
   * Poll document.body.innerText every interval; if the text changed by
   * more than `minDelta` characters, write a `page_text` event into the
   * unified NDJSON stream so the AI sees DOM-grade text (headings,
   * links, button labels) it might miss from the vision narration.
   */
  startPageTextWatcher() {
    if (this.pageTextInterval) return;
    const intervalMs = Number.parseInt(process.env.BRAINBOW_PAGE_TEXT_INTERVAL_MS || '2000');
    const minDelta = Number.parseInt(process.env.BRAINBOW_PAGE_TEXT_MIN_DELTA || '40');
    const maxBody = Number.parseInt(process.env.BRAINBOW_PAGE_TEXT_MAX_BODY || '3000');
    this.pageTextWatching = true;
    const tick = async () => {
      if (!this.pageTextWatching || !this.page) return;
      try {
        const probe = await this.page.evaluate((maxBody) => {
          const text = (document.body?.innerText || '').slice(0, maxBody);
          const headings = Array.from(document.querySelectorAll('h1,h2,h3'))
            .slice(0, 20)
            .map(h => ({ tag: h.tagName.toLowerCase(), text: (h.textContent || '').trim().slice(0, 120) }))
            .filter(h => h.text);
          const links = Array.from(document.querySelectorAll('a[href]'))
            .slice(0, 40)
            .map(a => ({ text: (a.textContent || '').trim().slice(0, 80), href: a.getAttribute('href')?.slice(0, 200) || '' }))
            .filter(l => l.text);
          const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
            .slice(0, 30)
            .map(b => (b.textContent || b.getAttribute('aria-label') || '').trim().slice(0, 80))
            .filter(Boolean);
          return { text, headings, links, buttons, url: location.href, title: document.title };
        }, maxBody);
        const newText = probe.text || '';
        const delta = Math.abs(newText.length - this.lastPageText.length);
        const changed = newText !== this.lastPageText && (delta >= minDelta || this.lastPageText === '');
        if (changed) {
          this.lastPageText = newText;
          appendStreamEvent({
            type: 'page_text',
            ts: Date.now(),
            sessionId: this.sessionId,
            url: probe.url,
            title: probe.title,
            headings: probe.headings,
            links: probe.links.slice(0, 20),
            buttons: probe.buttons.slice(0, 15),
            textTail: newText.slice(-1500),
            textLength: newText.length,
          });
        }
      } catch { /* page navigating / detached → next tick */ }
    };
    this.pageTextInterval = setInterval(tick, Math.max(500, intervalMs));
    setImmediate(tick);
  }

  stopPageTextWatcher() {
    if (this.pageTextInterval) {
      clearInterval(this.pageTextInterval);
      this.pageTextInterval = null;
    }
    this.pageTextWatching = false;
  }

  /**
   * Attach load / dialog / console / pageerror listeners to a page.
   * Called on every tab (not just the first) so console + log events
   * from ANY tab land in the session's shared ring buffers.
   */
  attachPageListeners(page) {
    page.on('load', () => this.log('page-load', page.url()));
    page.on('dialog', async (dialog) => {
      this.log('dialog', `${dialog.type()}: ${dialog.message()}`);
      this.broadcast({ type: 'dialog', dialogType: dialog.type(), message: dialog.message() });
    });
    page.on('console', (msg) => {
      const entry = {
        ts: Date.now(),
        type: msg.type(),
        text: String(msg.text()).slice(0, 1000),
        location: msg.location()?.url || '',
        tabIndex: this.tabs.indexOf(page),
      };
      this.consoleMessages.push(entry);
      if (this.consoleMessages.length > this.maxConsoleSize) {
        this.consoleMessages.shift();
      }
      appendStreamEvent({ type: 'console', sessionId: this.sessionId, ...entry });
    });
    page.on('pageerror', (err) => {
      const entry = {
        ts: Date.now(),
        type: 'pageerror',
        text: String(err.message || err).slice(0, 1000),
        location: '',
        tabIndex: this.tabs.indexOf(page),
      };
      this.consoleMessages.push(entry);
      if (this.consoleMessages.length > this.maxConsoleSize) {
        this.consoleMessages.shift();
      }
      appendStreamEvent({ type: 'console', sessionId: this.sessionId, ...entry });
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        const url = frame.url();
        // Keep lastUrl tracking the ACTIVE tab's current page so a mid-session
        // disconnect relaunches to where the user actually is, not just the
        // initial launch URL. Ignore background tabs + about:blank.
        if (page === this.page && url && url !== 'about:blank') {
          this.lastUrl = url;
        }
        appendStreamEvent({
          type: 'navigation',
          ts: Date.now(),
          sessionId: this.sessionId,
          tabIndex: this.tabs.indexOf(page),
          url,
        });
      }
    });
  }

  /**
   * Open a new tab in the same browser. By default the new tab
   * becomes the active one (so subsequent click/type/goto target
   * it), matching Chrome's "open in new tab" UX. Pass
   * `{ activate: false }` to open in background.
   */
  async openTab({ url, activate = true } = {}) {
    if (!this.browser) throw new Error('No browser open. launch() first.');
    const page = await this.browser.newPage();
    await page.setViewport({ ...this.viewport });
    this.attachPageListeners(page);
    this.tabs.push(page);
    const index = this.tabs.length - 1;
    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    this.log('tab-open', `#${index} ${url || 'about:blank'}`);
    if (activate) {
      await this.switchTab(index);
    }
    return { index, url: page.url(), title: await page.title().catch(() => '') };
  }

  /**
   * Switch the active tab. Stops the current screencast, re-points
   * `this.page`, and starts a new screencast on the now-active tab.
   * Idempotent: switching to the already-active index is a no-op.
   */
  async switchTab(index) {
    if (!this.tabs[index]) throw new Error(`No tab at index ${index}`);
    if (this.page === this.tabs[index]) return { index, activated: false };
    await this.stopScreencast();
    this.page = this.tabs[index];
    await this.page.bringToFront();
    await this.startScreencast();
    this.log('tab-switch', `→ #${index} ${this.page.url()}`);
    return { index, activated: true, url: this.page.url() };
  }

  /**
   * Close a tab. If the active tab is closed, activates the previous
   * one (or the next one if we closed index 0). Closing the last
   * remaining tab is disallowed — use Session.close() to tear the
   * whole session down.
   */
  async closeTab(index) {
    if (!this.tabs[index]) throw new Error(`No tab at index ${index}`);
    if (this.tabs.length === 1) {
      throw new Error('Cannot close the last tab; call /api/close to end the session');
    }
    const closing = this.tabs[index];
    const wasActive = this.page === closing;
    this.tabs.splice(index, 1);
    try { await closing.close(); } catch { /* already closed */ }
    if (wasActive) {
      const nextIdx = Math.min(index, this.tabs.length - 1);
      await this.switchTab(nextIdx);
    }
    this.log('tab-close', `#${index}`);
    return { closed: index, active: this.tabs.indexOf(this.page), remaining: this.tabs.length };
  }

  /** List all tabs with their url + title for UI rendering. */
  async listTabs() {
    const activeIndex = this.tabs.indexOf(this.page);
    const out = [];
    for (let i = 0; i < this.tabs.length; i++) {
      const page = this.tabs[i];
      out.push({
        index: i,
        active: i === activeIndex,
        url: page.url(),
        title: await page.title().catch(() => ''),
      });
    }
    return out;
  }

  async startScreencast() {
    if (!this.page || this.screencastRunning) return;
    try {
      this.cdpSession = await this.page.createCDPSession();
      this.cdpSession.on('Page.screencastFrame', async (params) => {
        // This whole callback runs detached from any request promise — an
        // unhandled throw here becomes an unhandledRejection on the process.
        // Belt-and-suspenders: wrap the entire body so a frame arriving
        // after the page/CDP target died can never escalate to a crash.
        try {
          this.pushFrame(params.data);
          this.broadcast({ type: 'frame', data: params.data });
          await this.cdpSession?.send('Page.screencastFrameAck', { sessionId: params.sessionId });
        } catch { /* session/target closed mid-frame — drop it */ }
      });
      await this.cdpSession.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 92,
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
        const buf = await this.page.screenshot({ type: 'jpeg', quality: 90 });
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
    this.stopPageTextWatcher();
    if (this.visionInterval) {
      clearInterval(this.visionInterval);
      this.visionInterval = null;
    }
    if (this.browser) {
      try { await this.browser.close(); } catch {}
      this.browser = null;
      this.page = null;
      this.tabs = [];
      this.cdpSession = null;
    }
    this.subscribers.clear();
    this.log('closed');
  }
}
