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
});
