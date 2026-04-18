// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionManager } from '../../src/session-manager.js';

// Stub Session so the SessionManager unit tests don't launch real browsers.
class StubSession {
  constructor(sessionId) { this.sessionId = sessionId; this.closed = false; }
  async close() { this.closed = true; }
}

describe('SessionManager', () => {
  let mgr;

  beforeEach(() => {
    mgr = new SessionManager({ SessionClass: StubSession, mode: 'local' });
  });

  afterEach(async () => {
    await mgr.closeAll();
  });

  it('lazily creates a session on first get() in local mode', async () => {
    const s = await mgr.get('default');
    expect(s).toBeInstanceOf(StubSession);
    expect(s.sessionId).toBe('default');
  });

  it('returns the same instance for repeated get() with same id', async () => {
    const a = await mgr.get('foo');
    const b = await mgr.get('foo');
    expect(a).toBe(b);
  });

  it('returns different instances for different ids', async () => {
    const a = await mgr.get('one');
    const b = await mgr.get('two');
    expect(a).not.toBe(b);
  });

  it('throws on unknown sessionId in cloud mode (no lazy create)', async () => {
    const cloudMgr = new SessionManager({ SessionClass: StubSession, mode: 'cloud' });
    await expect(cloudMgr.get('never-created')).rejects.toThrow(/unknown_session/);
  });

  it('explicitly creates in cloud mode via create()', async () => {
    const cloudMgr = new SessionManager({ SessionClass: StubSession, mode: 'cloud' });
    const s = await cloudMgr.create('explicit-id');
    expect(s.sessionId).toBe('explicit-id');
    expect(await cloudMgr.get('explicit-id')).toBe(s);
    await cloudMgr.closeAll();
  });

  it('closes a session via remove() and forgets it', async () => {
    const s = await mgr.get('to-remove');
    await mgr.remove('to-remove');
    expect(s.closed).toBe(true);
    const fresh = await mgr.get('to-remove'); // local mode auto-recreates
    expect(fresh).not.toBe(s);
  });

  it('lists active session ids', async () => {
    await mgr.get('a');
    await mgr.get('b');
    expect(mgr.list().sort()).toEqual(['a', 'b']);
  });

  it('closeAll closes every session and empties the map', async () => {
    const a = await mgr.get('a');
    const b = await mgr.get('b');
    await mgr.closeAll();
    expect(a.closed).toBe(true);
    expect(b.closed).toBe(true);
    expect(mgr.list()).toEqual([]);
  });

  it('default sessionId is "default" when get() called with no arg', async () => {
    const s = await mgr.get();
    expect(s.sessionId).toBe('default');
  });
});
