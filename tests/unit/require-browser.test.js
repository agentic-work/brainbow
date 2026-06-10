// SPDX-License-Identifier: MIT
//
// Bug 1 — "session drops constantly" regression tests.
//
// The old requireBrowser() guard gated auto-recovery on `session.browser`.
// But the chromium `disconnected` handler NULLS `session.browser` the
// instant Chromium drops (WSL2 GPU/renderer/shm crashes fire this often).
// So the guard's `if (session.browser && !isAlive())` was FALSE → the
// transparent relaunch was SKIPPED → every subsequent /api/eval, /api/screen,
// /api/click returned "No browser open. POST /api/launch first." The
// self-healing was defeated by its own disconnect handler.
//
// The fix gates recovery on a DURABLE flag — `session.wasLaunched` — that
// survives a disconnect (the handler may null the dead browser/page/cdp/tabs
// but must NOT clear wasLaunched/lastUrl). These tests pin that contract.

import { describe, it, expect } from 'vitest';
import { requireBrowser } from '../../src/require-browser.js';

// Minimal Express-res stub: records status + json so we can assert the 400.
function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

// Session stub mimicking the post-disconnect state: the disconnect handler
// has nulled browser/page but wasLaunched/lastUrl survive. isAlive() is
// derived from browser+page like the real Session.
function makeSession(overrides = {}) {
  const s = {
    sessionId: 'test',
    wasLaunched: false,
    lastUrl: null,
    browser: null,
    page: null,
    ensureBrowserCalls: [],
    logs: [],
    isAlive() { return !!(this.browser && this.page); },
    async ensureBrowser(opts = {}) {
      this.ensureBrowserCalls.push(opts);
      // Stubbed relaunch: bring the browser/page back, as the real
      // ensureBrowser()→launch() does.
      this.browser = { isConnected: () => true };
      this.page = { isClosed: () => false, url: () => this.lastUrl || 'about:blank' };
    },
    log(...args) { this.logs.push(args); },
    ...overrides,
  };
  return s;
}

describe('requireBrowser auto-recovery (Bug 1 — the drop)', () => {
  it('(1) recovers a post-disconnect session (wasLaunched=true, browser=null) WITHOUT a 400', async () => {
    // Simulate exactly what the chromium disconnect handler leaves behind:
    // browser/page nulled, but the session WAS launched.
    const session = makeSession({ wasLaunched: true, browser: null, page: null });
    expect(session.isAlive()).toBe(false);

    const res = makeRes();
    const ok = await requireBrowser(session, res);

    // The OLD guard checked `session.browser` (null) → skipped ensureBrowser
    // → fell through to the 400. The fix gates on wasLaunched.
    expect(session.ensureBrowserCalls.length).toBe(1);   // relaunch attempted
    expect(res.statusCode).not.toBe(400);                // NOT the drop error
    expect(res.body).toBe(null);                         // no error body sent
    expect(ok).toBe(true);                               // action may proceed
  });

  it('(2) a never-launched session still 400s "No browser open" (no silent auto-spawn)', async () => {
    const session = makeSession({ wasLaunched: false, browser: null, page: null });
    const res = makeRes();
    const ok = await requireBrowser(session, res);

    expect(session.ensureBrowserCalls.length).toBe(0);   // do NOT spin up Chromium
    expect(res.statusCode).toBe(400);
    expect(res.body?.error).toMatch(/No browser open/i);
    expect(ok).toBe(false);
  });

  it('passes through cleanly when the browser is already alive (no relaunch)', async () => {
    const session = makeSession({
      wasLaunched: true,
      browser: { isConnected: () => true },
      page: { isClosed: () => false },
    });
    const res = makeRes();
    const ok = await requireBrowser(session, res);

    expect(session.ensureBrowserCalls.length).toBe(0);
    expect(res.statusCode).toBe(null);
    expect(ok).toBe(true);
  });

  it('still 400s when ensureBrowser ran but page is STILL null (relaunch failed to produce a page)', async () => {
    const session = makeSession({
      wasLaunched: true,
      browser: null,
      page: null,
      async ensureBrowser(opts = {}) {
        this.ensureBrowserCalls.push(opts);
        // Relaunch produced no usable page (e.g. chromium came up but goto threw).
        this.browser = null;
        this.page = null;
      },
    });
    const res = makeRes();
    const ok = await requireBrowser(session, res);

    expect(session.ensureBrowserCalls.length).toBe(1);
    expect(res.statusCode).toBe(400);
    expect(ok).toBe(false);
  });

  it('returns 503 (not 400) when the relaunch itself throws', async () => {
    const session = makeSession({
      wasLaunched: true,
      browser: null,
      page: null,
      async ensureBrowser() {
        this.ensureBrowserCalls.push({});
        throw new Error('chromium binary missing');
      },
    });
    const res = makeRes();
    const ok = await requireBrowser(session, res);

    expect(res.statusCode).toBe(503);
    expect(res.body?.error).toMatch(/relaunch failed|crashed/i);
    expect(ok).toBe(false);
  });
});
