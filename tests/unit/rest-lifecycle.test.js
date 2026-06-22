// SPDX-License-Identifier: MIT
//
// MCP-owned REST lifecycle — the zombie-REST fix (task requirement #1).
//
// Pins:
//   (a) ADOPT: a healthy REST already on the port is adopted, NOT duplicated,
//       and is NOT owned (so we never kill someone else's REST).
//   (b) SPAWN: when nothing is on the port, server.js is spawned as a
//       NON-detached child (detached:false, no unref) → owned by us.
//   (c) STOP kills the owned child (SIGTERM) when we are the last owner.
//   (d) REFCOUNT: with another live owner registered, stop() LEAVES the REST
//       running (multi-session safety).
//   (e) installTraps wires exit/SIGTERM/SIGINT and the sync exit-trap issues a
//       SIGTERM to the owned child.
//   (f) autostart:false → adopt-only (never spawns).
//
// All external effects (spawn / fetch / fs / kill) are injected; no real
// process, port, or filesystem is touched.

import { describe, it, expect, beforeEach } from 'vitest';
import { createRestLifecycle } from '../../src/rest-lifecycle.js';
import { EventEmitter } from 'node:events';

// ─── fakes ──────────────────────────────────────────────────────────────────
function makeFakeChild(pid = 4321) {
  const ee = new EventEmitter();
  ee.pid = pid;
  ee.exitCode = null;
  ee.killed = false;
  ee.signals = [];
  ee.kill = (sig) => { ee.signals.push(sig); ee.killed = true; return true; };
  return ee;
}

function makeHarness({ restUpSequence = [false], autostart = true } = {}) {
  // fetch returns ok per restUpSequence (consumed in order, last value sticks).
  let i = 0;
  const fetchImpl = async () => {
    const ok = i < restUpSequence.length ? restUpSequence[i] : restUpSequence[restUpSequence.length - 1];
    i++;
    return { ok };
  };
  const spawned = [];
  const spawn = (cmd, args, opts) => {
    const child = makeFakeChild(9000 + spawned.length);
    spawned.push({ cmd, args, opts, child });
    return child;
  };
  const kills = [];
  const fakeFs = new Map();           // refdir owner files
  const killProcess = (pid, sig) => { kills.push({ pid, sig }); return true; };

  const lc = createRestLifecycle({
    serverJs: '/fake/server.js',
    port: '4444',
    baseUrl: 'http://localhost:4444',
    env: { BRAINBOW_REST_REFDIR: '/fake/refdir' },
    logger: () => {},
    deps: {
      spawn,
      fetchImpl,
      execPath: '/usr/bin/node',
      existsSync: () => true,
      mkdirSync: () => {},
      writeFileSync: (p) => { fakeFs.set(p, '1'); },
      readdirSync: () => [...fakeFs.keys()].map((p) => p.split('/').pop()),
      rmSync: (p) => { fakeFs.delete(p); },
      openLogFd: () => 'ignore',
      sleep: () => Promise.resolve(),
      killProcess,
      pid: 1111,
    },
  });
  return { lc, spawned, kills, fakeFs };
}

describe('REST lifecycle — adopt-or-spawn + managed child', () => {
  it('(a) adopts an already-healthy REST WITHOUT spawning, and does not own it', async () => {
    const { lc, spawned } = makeHarness({ restUpSequence: [true] });
    const r = await lc.start();
    expect(r.ok).toBe(true);
    expect(r.adopted).toBe(true);
    expect(r.owned).toBe(false);
    expect(spawned.length).toBe(0);            // NO duplicate REST
  });

  it('(b) spawns server.js as a NON-detached child when the port is down', async () => {
    // first probe: down; then (after spawn) up.
    const { lc, spawned } = makeHarness({ restUpSequence: [false, true] });
    const r = await lc.start();
    expect(r.ok).toBe(true);
    expect(r.owned).toBe(true);
    expect(spawned.length).toBe(1);
    const opts = spawned[0].opts;
    expect(opts.detached).toBe(false);          // NOT orphaned (the zombie fix)
    expect(spawned[0].args).toEqual(['/fake/server.js']);
    expect(opts.env.BRAINBOW_PORT).toBe('4444');
  });

  it('(c) stop() SIGTERMs the owned child when we are the last owner', async () => {
    const { lc } = makeHarness({ restUpSequence: [false, true] });
    await lc.start();
    const child = lc._state.child;
    const res = await lc.stop();
    expect(res.stopped).toBe(true);
    expect(child.signals).toContain('SIGTERM');
  });

  it('(d) refcount: with another live owner present, stop() LEAVES the REST running', async () => {
    const { lc, fakeFs } = makeHarness({ restUpSequence: [false, true] });
    await lc.start();             // registers owner 1111
    // Inject a SECOND live owner (a different Claude session) into the refdir.
    // killProcess(pid,0) returns true in our fake → counted as live.
    fakeFs.set('/fake/refdir/2222', '1');
    const child = lc._state.child;
    const res = await lc.stop();
    expect(res.stopped).toBe(false);
    expect(res.reason).toBe('other-owners');
    expect(child.signals).not.toContain('SIGTERM');   // shared REST untouched
  });

  it('(e) installTraps registers exit/SIGTERM/SIGINT; sync exit-trap SIGTERMs the owned child', async () => {
    const { lc, kills } = makeHarness({ restUpSequence: [false, true] });
    await lc.start();
    const fakeProc = new EventEmitter();
    fakeProc.exit = () => {};
    const { syncKill } = lc.installTraps(fakeProc);
    expect(fakeProc.listenerCount('exit')).toBe(1);
    expect(fakeProc.listenerCount('SIGTERM')).toBe(1);
    expect(fakeProc.listenerCount('SIGINT')).toBe(1);
    // Fire the synchronous exit trap directly — last owner → SIGTERM the child.
    syncKill();
    expect(kills.some((k) => k.sig === 'SIGTERM')).toBe(true);
  });

  it('(f) autostart:false → adopt-only (never spawns)', async () => {
    const { lc, spawned } = makeHarness({ restUpSequence: [false] });
    const r = await lc.start({ autostart: false });
    expect(r.ok).toBe(false);
    expect(r.autostartDisabled).toBe(true);
    expect(spawned.length).toBe(0);
  });
});

describe('REST lifecycle — source regression: no detached orphan spawn', () => {
  it('rest-lifecycle never spawns with detached:true / unref()', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, '..', '..', 'src', 'rest-lifecycle.js'), 'utf8');
    // The managed child must be detached:false and must NOT unref.
    expect(src).toMatch(/detached:\s*false/);
    expect(src).not.toMatch(/\.unref\(\)/);
  });

  it('bin/brainbow-mcp no longer spawns an orphan REST (no setsid nohup … & disown)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const shim = fs.readFileSync(path.join(here, '..', '..', 'bin', 'brainbow-mcp'), 'utf8');
    // The old orphan pattern (setsid nohup server.js & disown) must be GONE.
    expect(shim).not.toMatch(/setsid\s+nohup\s+env\s+BRAINBOW_PORT/);
    // And it must forward the autostart toggle to the Node MCP that now owns it.
    expect(shim).toMatch(/export BRAINBOW_AUTOSTART_REST/);
  });
});
