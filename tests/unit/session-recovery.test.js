// SPDX-License-Identifier: MIT
//
// Bug 1 — durable recovery state on Session.
//
// The chromium `disconnected` handler nulls the dead browser/page/cdp/tabs
// (those handles ARE dead) but MUST preserve the state needed to come back
// to where the user was: `wasLaunched` (so requireBrowser knows recovery is
// allowed) and `lastUrl` (so ensureBrowser relaunches onto the same page,
// keeping the persistent-profile SSO session intact instead of dumping the
// user on about:blank and forcing a re-login).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Session } from '../../src/session.js';

describe('Session durable recovery state (Bug 1)', () => {
  let session;

  beforeEach(() => {
    session = new Session('recovery-1', { autoLaunch: false });
  });

  afterEach(async () => {
    await session.close();
  });

  it('starts un-launched with no lastUrl', () => {
    expect(session.wasLaunched).toBe(false);
    expect(session.lastUrl).toBeFalsy();
  });

  it('(3) preserves wasLaunched + lastUrl across a simulated disconnect', async () => {
    // Drive launch() far enough to set the durable state WITHOUT a real
    // browser: stub the heavy bits launch() calls so we exercise the real
    // state-setting code paths.
    const URL = 'https://example.com/app';

    // Stub the browser-touching internals launch() invokes.
    session.close = async () => {};               // launch() calls close() if browser set (it isn't)
    session.startScreencast = async () => {};
    session.startPageTextWatcher = () => {};
    session.attachPageListeners = () => {};

    // Fake puppeteer browser whose disconnect handler we can fire manually.
    let disconnectHandler = null;
    const fakePage = {
      setViewport: async () => {},
      goto: async () => {},
      url: () => URL,
    };
    const fakeBrowser = {
      on: (evt, cb) => { if (evt === 'disconnected') disconnectHandler = cb; },
      pages: async () => [fakePage],
      newPage: async () => fakePage,
      isConnected: () => true,
    };
    // Replace puppeteer.launch indirection: launch() calls puppeteer.launch
    // + findChrome. Easiest seam: override the methods launch() depends on by
    // monkeypatching launch to use our fake browser. Instead, we shim the
    // _launchBrowser hook the implementation must expose so tests don't need
    // a real chromium.
    session._launchBrowserForTest = async () => fakeBrowser;

    await session.launch({ url: URL });

    expect(session.wasLaunched).toBe(true);
    expect(session.lastUrl).toBe(URL);
    expect(typeof disconnectHandler).toBe('function');

    // Fire the disconnect handler — Chromium dropped.
    disconnectHandler();

    // The dead handles are cleared…
    expect(session.browser).toBe(null);
    expect(session.page).toBe(null);
    expect(session.tabs).toEqual([]);
    // …but the recovery state SURVIVES.
    expect(session.wasLaunched).toBe(true);
    expect(session.lastUrl).toBe(URL);
  });

  it('(3b) ensureBrowser() relaunches with the preserved lastUrl', async () => {
    session.wasLaunched = true;
    session.lastUrl = 'https://example.com/app';
    session.browser = null;
    session.page = null;

    let relaunchOpts = null;
    session.launch = async (opts) => { relaunchOpts = opts; };

    await session.ensureBrowser();

    expect(relaunchOpts).toBeTruthy();
    expect(relaunchOpts.url).toBe('https://example.com/app');
    // viewport carried over too
    expect(relaunchOpts.width).toBe(session.viewport.width);
    expect(relaunchOpts.height).toBe(session.viewport.height);
  });
});
