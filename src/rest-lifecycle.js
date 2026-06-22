// SPDX-License-Identifier: MIT
//
// rest-lifecycle — make the shared brainbow REST a MANAGED CHILD of the
// long-lived MCP process, so it starts WITH the MCP and stops WITH it,
// exactly like every other MCP server.
//
// THE PROBLEM this fixes (zombie REST):
//   Historically the shim (bin/brainbow-mcp) spawned server.js with
//   `setsid nohup … & disown` — fully orphaned. When the Claude Code host
//   disconnected, mcp-server.js exited cleanly but NOTHING signaled the
//   REST. Reinforced by a detached reviveRest() spawn. Result: a REST
//   started days ago kept listening on :4444, kept winning the
//   "is the port already up?" short-circuit, and served stale bytes
//   forever with no auto-refresh.
//
// THE FIX:
//   The MCP process (mcp-server.js) owns a SINGLE managed REST child:
//     - spawn it NON-detached, in OUR process group (no unref) so a SIGTERM
//       to us reaches it and even a hard death lets the kernel clean it up;
//     - keep the child handle in module scope (`state.child`);
//     - install teardown traps (the same exit paths that today only exit
//       Node: onclose, stdin-EOF, plus process exit/SIGTERM/SIGINT) that
//       SIGTERM the child (2s grace → SIGKILL) before exiting;
//     - ADOPT-OR-SPAWN: if a healthy REST is already on the port we adopt it
//       (do NOT spawn a duplicate) — but we only OWN (kill-on-exit) the one
//       WE spawned. An adopted REST is left running for whoever owns it.
//
//   MULTI-SESSION SAFETY: one REST on :4444 serves N Claude sessions. Killing
//   it on ONE disconnect would break the others. The shared singleton is
//   guarded by a cross-process REFCOUNT (a pidfile dir of live MCP owners).
//   We only actually SIGTERM the REST when WE are the last owner standing.
//
// This module is injectable for unit tests: pass in fake { spawn, fetch,
// existsSync, … } and assert the lifecycle decisions without a real process.

import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SIGKILL_GRACE_MS = Number.parseInt(process.env.BRAINBOW_REST_KILL_GRACE_MS || '2000', 10);

/**
 * Create a lifecycle manager bound to a SERVER_JS path + port. Returns an
 * object with start / stop / restart / status / refcount helpers and the
 * teardown installer. All external effects (spawn, fetch, fs, signals) are
 * injectable via `deps` for tests.
 */
export function createRestLifecycle({
  serverJs,
  port = process.env.BRAINBOW_PORT || '4444',
  baseUrl = process.env.BRAINBOW_URL || `http://localhost:${process.env.BRAINBOW_PORT || '4444'}`,
  env = process.env,
  logger = (...a) => console.error(...a),
  deps = {},
} = {}) {
  const {
    spawn = nodeSpawn,
    fetchImpl = (typeof fetch === 'function' ? fetch : null),
    execPath = process.execPath,
    existsSync = fs.existsSync,
    mkdirSync = fs.mkdirSync,
    writeFileSync = fs.writeFileSync,
    readdirSync = fs.readdirSync,
    rmSync = fs.rmSync,
    openLogFd = defaultOpenLogFd,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    killProcess = (pid, sig) => { try { process.kill(pid, sig); return true; } catch { return false; } },
    pid = process.pid,
  } = deps;

  // Module-scoped lifecycle state for THIS MCP process.
  const state = {
    child: null,        // ChildProcess handle for the REST WE spawned (owned)
    childPid: null,
    owned: false,       // did we spawn it (vs adopt an existing one)?
    stopping: false,
  };

  // Cross-process refcount: a dir of empty files named by owner PID. Each MCP
  // process that ADOPTS-OR-SPAWNS the shared REST registers itself; on
  // teardown it deregisters. The REST is only actually killed when the dir is
  // empty (we were the last owner).
  const refDir = env.BRAINBOW_REST_REFDIR
    || path.join(os.tmpdir(), 'brainbow', `rest-owners-${port}`);
  const myRefFile = path.join(refDir, String(pid));

  function ensureRefDir() {
    try { mkdirSync(refDir, { recursive: true }); } catch { /* ignore */ }
  }
  function registerOwner() {
    ensureRefDir();
    try { writeFileSync(myRefFile, String(Date.now())); } catch { /* ignore */ }
  }
  function deregisterOwner() {
    try { rmSync(myRefFile, { force: true }); } catch { /* ignore */ }
  }
  function liveOwnerCount() {
    let live = 0;
    let files = [];
    try { files = readdirSync(refDir); } catch { return 0; }
    for (const f of files) {
      const ownerPid = Number.parseInt(f, 10);
      if (!Number.isFinite(ownerPid)) continue;
      // Treat a PID as live if it still exists (signal 0 = existence probe).
      if (ownerPid === pid || killProcess(ownerPid, 0)) live++;
      else { try { rmSync(path.join(refDir, f), { force: true }); } catch { /* stale */ } }
    }
    return live;
  }

  async function restUp(timeoutMs = 1000) {
    if (!fetchImpl) return false;
    try {
      const r = await fetchImpl(`${baseUrl}/api/whoami`, { signal: AbortSignal.timeout(timeoutMs) });
      return !!r?.ok;
    } catch { return false; }
  }

  async function waitForRest(maxMs = 15000, stepMs = 500) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if (await restUp()) return true;
      await sleep(stepMs);
    }
    return false;
  }

  /**
   * ADOPT-OR-SPAWN. Registers this process as an owner of the shared REST.
   * - If a healthy REST already answers /api/whoami → ADOPT (owned=false).
   * - Else spawn server.js as a MANAGED, NON-detached child (owned=true) and
   *   wait for it to bind.
   * Returns { ok, owned, adopted, pid|null }.
   */
  async function start({ visionEnv = {}, autostart = true } = {}) {
    registerOwner();

    if (await restUp()) {
      state.owned = false;
      logger('[brainbow-mcp] adopted existing healthy REST on', baseUrl, '(not owned by us)');
      return { ok: true, owned: false, adopted: true, pid: null };
    }

    if (!autostart) {
      logger('[brainbow-mcp] autostart disabled — not spawning REST (adopt-only mode)');
      return { ok: false, owned: false, adopted: false, pid: null, autostartDisabled: true };
    }

    if (!serverJs || !safeExists(existsSync, serverJs)) {
      logger('[brainbow-mcp] cannot spawn REST — server.js not found at', serverJs);
      return { ok: false, owned: false, adopted: false, pid: null };
    }

    const logFd = safe(() => openLogFd(env, port), 'ignore');
    const child = spawn(execPath, [serverJs], {
      // NON-detached: stays in our process group so a SIGTERM to us (or a
      // hard death) lets the kernel/our trap reach it. The OPPOSITE of the
      // old setsid+nohup+disown orphan.
      detached: false,
      stdio: ['ignore', logFd, logFd],
      env: { ...env, BRAINBOW_PORT: String(port), ...visionEnv },
    });
    // A spawned child emits 'error' async (ENOENT etc) — swallow so it can
    // never escalate to an uncaughtException and kill the MCP.
    child.on('error', (e) => logger('[brainbow-mcp] REST child spawn error:', e?.message || e));
    child.on('exit', (code, sig) => {
      logger(`[brainbow-mcp] managed REST child exited (code=${code} sig=${sig})`);
      if (state.child === child) { state.child = null; state.childPid = null; }
    });
    // Do NOT unref — we WANT the child tied to us.
    state.child = child;
    state.childPid = child.pid;
    state.owned = true;

    const up = await waitForRest();
    if (!up) {
      logger('[brainbow-mcp] managed REST did not bind', baseUrl, 'within 15s');
      return { ok: false, owned: true, adopted: false, pid: child.pid };
    }
    logger('[brainbow-mcp] managed REST up on', baseUrl, '(pid', child.pid + ', owned by this MCP)');
    return { ok: true, owned: true, adopted: false, pid: child.pid };
  }

  /**
   * Stop the REST WE own — but only if we are the last live owner (refcount).
   * Deregisters this owner first, then, if no other live owner remains AND we
   * spawned the child, SIGTERM → grace → SIGKILL it.
   * Safe to call multiple times; idempotent.
   */
  async function stop({ force = false } = {}) {
    if (state.stopping) return { stopped: false, reason: 'already-stopping' };
    state.stopping = true;
    deregisterOwner();

    const others = liveOwnerCount(); // excludes us now (deregistered)
    if (!state.owned || !state.child) {
      logger('[brainbow-mcp] stop(): no owned REST child to kill (adopted or none); leaving REST running');
      return { stopped: false, reason: 'not-owned', otherOwners: others };
    }
    if (others > 0 && !force) {
      logger(`[brainbow-mcp] stop(): ${others} other live MCP owner(s) — leaving shared REST running`);
      return { stopped: false, reason: 'other-owners', otherOwners: others };
    }

    const child = state.child;
    const cpid = state.childPid;
    logger('[brainbow-mcp] stop(): last owner — terminating managed REST pid', cpid);
    try { child.kill('SIGTERM'); } catch { /* already dead */ }

    // Grace, then hard kill if still alive.
    const killedCleanly = await raceExit(child, SIGKILL_GRACE_MS, sleep);
    if (!killedCleanly && cpid) {
      logger('[brainbow-mcp] stop(): grace elapsed — SIGKILL', cpid);
      killProcess(cpid, 'SIGKILL');
    }
    state.child = null;
    state.childPid = null;
    return { stopped: true, reason: 'killed', otherOwners: others };
  }

  /**
   * restart_rest: stop the REST we own (force, ignoring other owners is
   * intentional here — the operator explicitly asked to restart so stale bytes
   * get refreshed) and start a fresh managed child. Honors current vision env.
   */
  async function restart({ visionEnv = {} } = {}) {
    logger('[brainbow-mcp] restart_rest: forcing REST refresh');
    await stop({ force: true });
    state.stopping = false; // allow the subsequent stop() on next teardown
    // Brief settle so the port frees before re-bind.
    await sleep(300);
    return start({ visionEnv });
  }

  function status() {
    return {
      owned: state.owned,
      childPid: state.childPid,
      alive: !!(state.child && state.child.exitCode == null && !state.child.killed),
      stopping: state.stopping,
      port: String(port),
      baseUrl,
      refDir,
      liveOwners: liveOwnerCount(),
    };
  }

  /**
   * Install belt-and-suspenders process traps so the managed REST is torn
   * down on EVERY exit path. `onProcess` defaults to the real `process` but is
   * injectable for tests. The caller (mcp-server) ALSO calls stop() from its
   * own onclose/stdin-EOF handlers; these traps catch the paths those miss
   * (SIGTERM/SIGINT from a parent, uncaught process.exit, kernel signals that
   * still run 'exit').
   */
  function installTraps(onProcess = process) {
    // synchronous-only: process 'exit' cannot await. We issue a best-effort
    // synchronous SIGTERM to the owned child (no grace — the kernel reaps it
    // since it's in our group and non-detached).
    const syncKill = () => {
      try {
        deregisterOwner();
        if (state.owned && state.childPid && liveOwnerCount() === 0) {
          killProcess(state.childPid, 'SIGTERM');
        }
      } catch { /* never throw from a trap */ }
    };
    onProcess.on('exit', syncKill);
    // For signals we have a moment to do the graceful async stop, then exit.
    const onSignal = (sig) => {
      logger(`[brainbow-mcp] received ${sig} — tearing down managed REST`);
      stop().finally(() => {
        try { onProcess.exit(0); } catch { /* ignore */ }
      });
    };
    onProcess.on('SIGTERM', () => onSignal('SIGTERM'));
    onProcess.on('SIGINT', () => onSignal('SIGINT'));
    onProcess.on('SIGHUP', () => onSignal('SIGHUP'));
    return { syncKill };
  }

  return {
    start,
    stop,
    restart,
    status,
    installTraps,
    restUp,
    waitForRest,
    // exposed for tests/introspection
    _state: state,
    _refDir: refDir,
    liveOwnerCount,
    registerOwner,
    deregisterOwner,
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────
function safe(fn, fb) { try { return fn(); } catch { return fb; } }
function safeExists(existsSync, p) { try { return existsSync(p); } catch { return false; } }

function defaultOpenLogFd(env, port) {
  const logDir = env.BRAINBOW_LOG_DIR || path.join(os.tmpdir(), 'brainbow');
  const logFile = env.BRAINBOW_LOG_FILE || path.join(logDir, `brainbow-${port}.log`);
  try { fs.mkdirSync(logDir, { recursive: true }); } catch { /* ignore */ }
  try { return fs.openSync(logFile, 'a'); } catch { return 'ignore'; }
}

/**
 * Resolve true if the child exits within `graceMs`, false on timeout.
 * Used to decide whether a SIGKILL escalation is needed.
 */
function raceExit(child, graceMs, sleep) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      if (child.exitCode != null || child.killed) return finish(true);
      child.once('exit', () => finish(true));
    } catch { return finish(false); }
    sleep(graceMs).then(() => finish(false));
  });
}
