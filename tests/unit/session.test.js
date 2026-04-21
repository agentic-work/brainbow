// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Session } from '../../src/session.js';

describe('Session', () => {
  let session;

  beforeEach(() => {
    session = new Session('test-1', { autoLaunch: false });
  });

  afterEach(async () => {
    await session.close();
  });

  it('exposes its sessionId', () => {
    expect(session.sessionId).toBe('test-1');
  });

  it('starts with no browser, no frames, not recording', () => {
    expect(session.browser).toBe(null);
    expect(session.page).toBe(null);
    expect(session.lastFrameB64).toBe(null);
    expect(session.recording).toBe(false);
    expect(session.recordFrames).toEqual([]);
  });

  it('frame buffer is bounded', () => {
    expect(session.maxFrameBufferSize).toBeGreaterThan(0);
    // simulate 500 frames into a 300-cap buffer
    for (let i = 0; i < 500; i++) {
      session.pushFrame('fakebase64', i);
    }
    expect(session.frameBuffer.length).toBeLessThanOrEqual(session.maxFrameBufferSize);
    expect(session.lastFrameB64).toBe('fakebase64');
  });

  it('logs append to a per-session action log capped at 200', () => {
    for (let i = 0; i < 250; i++) {
      session.log('test-action', `detail-${i}`);
    }
    expect(session.actionLog.length).toBe(200);
    // newest entry is detail-249
    expect(session.actionLog[session.actionLog.length - 1].detail).toContain('detail-249');
  });

  it('redacts secrets in log details', () => {
    session.log('auth', 'password=hunter2');
    const last = session.actionLog[session.actionLog.length - 1];
    expect(last.detail).not.toContain('hunter2');
  });

  it('two sessions have isolated state', () => {
    const a = new Session('a', { autoLaunch: false });
    const b = new Session('b', { autoLaunch: false });
    a.pushFrame('frame-a', 0);
    b.pushFrame('frame-b', 0);
    expect(a.lastFrameB64).toBe('frame-a');
    expect(b.lastFrameB64).toBe('frame-b');
  });

  // Teardown paths — exercise the state-cleanup branches that the
  // integration/trip-wire suites would normally drive through a real
  // Chromium. Injecting fake interval handles + CDP stubs lets the unit
  // tier cover close() + stopScreencast() without a browser.

  it('stopScreencast clears a polling fallback interval', async () => {
    let cleared = false;
    const fakeInterval = setInterval(() => {}, 1_000);
    session._fallbackInterval = fakeInterval;
    session.screencastRunning = true;
    session.cdpSession = { send: async () => { cleared = true; } };
    await session.stopScreencast();
    expect(session._fallbackInterval).toBe(null);
    expect(session.screencastRunning).toBe(false);
    expect(cleared).toBe(true);
  });

  it('stopScreencast swallows CDP errors', async () => {
    session._fallbackInterval = null;
    session.screencastRunning = true;
    session.cdpSession = { send: async () => { throw new Error('cdp gone'); } };
    await expect(session.stopScreencast()).resolves.toBeUndefined();
    expect(session.screencastRunning).toBe(false);
  });

  it('close() clears visionInterval and closes the mock browser', async () => {
    let closed = false;
    session.visionInterval = setInterval(() => {}, 1_000);
    session.browser = { close: async () => { closed = true; } };
    session.page = { fake: true };
    session.cdpSession = { fake: true };
    session.recording = true;
    session.recordFrames = [{ ts: 1, data: 'x' }];
    await session.close();
    expect(session.visionInterval).toBe(null);
    expect(session.browser).toBe(null);
    expect(session.page).toBe(null);
    expect(session.cdpSession).toBe(null);
    expect(session.recording).toBe(false);
    expect(session.recordFrames).toEqual([]);
    expect(closed).toBe(true);
  });

  it('close() swallows browser.close errors', async () => {
    session.browser = { close: async () => { throw new Error('browser already dead'); } };
    session.page = { fake: true };
    await expect(session.close()).resolves.toBeUndefined();
    expect(session.browser).toBe(null);
  });

  it('startScreenshotFallback is idempotent', () => {
    session.startScreenshotFallback();
    const first = session._fallbackInterval;
    session.startScreenshotFallback();
    expect(session._fallbackInterval).toBe(first);
    clearInterval(session._fallbackInterval);
    session._fallbackInterval = null;
  });

  it('screenshot fallback captures frames when page is present', async () => {
    const frames = [];
    session.page = {
      screenshot: async () => Buffer.from('testjpeg-bytes'),
    };
    session.broadcast = (msg) => frames.push(msg);

    session.startScreenshotFallback();
    // Let the 100ms interval fire at least once
    await new Promise((r) => setTimeout(r, 180));
    clearInterval(session._fallbackInterval);
    session._fallbackInterval = null;

    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0].type).toBe('frame');
    expect(frames[0].data).toMatch(/^[A-Za-z0-9+/]/);
  });

  it('startScreencast falls back to screenshot polling when CDP throws', async () => {
    const originalError = console.error;
    console.error = () => {};          // silence the logged failure
    try {
      session.page = {
        createCDPSession: async () => { throw new Error('no CDP'); },
        screenshot: async () => Buffer.from('snap'),
      };
      await session.startScreencast();
      expect(session._fallbackInterval).not.toBe(null);
      expect(session.screencastRunning).toBe(false);
    } finally {
      if (session._fallbackInterval) clearInterval(session._fallbackInterval);
      session._fallbackInterval = null;
      console.error = originalError;
    }
  });

  it('startScreencast is a no-op when no page is attached', async () => {
    session.page = null;
    await session.startScreencast();
    expect(session.screencastRunning).toBe(false);
    expect(session._fallbackInterval).toBeFalsy();
  });

  it('screenshot fallback no-ops when page is missing', async () => {
    session.page = null;
    const calls = [];
    const origBroadcast = session.broadcast.bind(session);
    session.broadcast = (msg) => calls.push(msg);
    try {
      session.startScreenshotFallback();
      await new Promise((r) => setTimeout(r, 180));
      clearInterval(session._fallbackInterval);
      session._fallbackInterval = null;
      const frames = calls.filter((m) => m && m.type === 'frame');
      expect(frames).toHaveLength(0);
    } finally {
      session.broadcast = origBroadcast;
    }
  });
});
