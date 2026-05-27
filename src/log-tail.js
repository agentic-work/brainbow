// SPDX-License-Identifier: MIT
//
// LogTailManager — per-session map of named external command tails.
//
// Purpose: a Session can have N concurrent tails attached to it, each a
// long-running child_process running e.g. `kubectl logs -f deployment/...`
// or `docker logs -f ...` or `tail -F /var/log/foo`. Stdout + stderr are
// accumulated into a per-tail ring buffer with timestamps. The /api/live
// endpoint returns log lines newer than the caller's cursor.
//
// Security: this spawns arbitrary shell commands on the host running
// brainbow. ONLY enable when BRAINBOW_LOG_TAILS_ENABLED=true (default OFF).
// In hosted/multi-tenant deployments this should stay off — log tails are
// for local-dev "AI watches the api logs while I drive the UI" workflows.

import { spawn } from 'node:child_process';
import { appendStreamEvent } from './stream-log.js';

const DEFAULT_RING_SIZE = 1000;

function tokenizeCommand(command) {
  // Naive shell-like tokenization: split on whitespace, honoring single
  // and double quotes. Good enough for `kubectl logs -f deployment/foo`
  // style commands. For anything more complex, callers should run it
  // through `bash -c "..."` themselves.
  const tokens = [];
  let cur = '';
  let quote = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (cur) { tokens.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
}

export class LogTail {
  constructor({ name, command, ringSize = DEFAULT_RING_SIZE }) {
    this.name = name;
    this.command = command;
    this.ringSize = ringSize;
    this.lines = [];          // { ts, stream: 'stdout'|'stderr', line }
    this.proc = null;
    this.startedAt = 0;
    this.exitCode = null;
    this.killed = false;
    this._stdoutBuf = '';
    this._stderrBuf = '';
  }

  start() {
    if (this.proc) return;
    const tokens = tokenizeCommand(this.command);
    if (tokens.length === 0) throw new Error('empty command');
    this.startedAt = Date.now();
    this.proc = spawn(tokens[0], tokens.slice(1), {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    this.proc.stdout.on('data', (chunk) => this._ingest(chunk, 'stdout'));
    this.proc.stderr.on('data', (chunk) => this._ingest(chunk, 'stderr'));
    this.proc.on('exit', (code) => {
      this.exitCode = code ?? -1;
      this._push('stderr', `[log-tail '${this.name}' exited code=${this.exitCode}]`);
    });
    this.proc.on('error', (e) => {
      this._push('stderr', `[log-tail '${this.name}' spawn error: ${e.message}]`);
    });
  }

  _ingest(chunk, stream) {
    const bufKey = stream === 'stdout' ? '_stdoutBuf' : '_stderrBuf';
    this[bufKey] += String(chunk);
    let nl;
    while ((nl = this[bufKey].indexOf('\n')) !== -1) {
      const line = this[bufKey].slice(0, nl);
      this[bufKey] = this[bufKey].slice(nl + 1);
      this._push(stream, line);
    }
    if (this[bufKey].length > 8192) {
      // Flush an unterminated line if it's clearly stuck. Prevents OOM
      // on a process that never emits a newline.
      this._push(stream, this[bufKey]);
      this[bufKey] = '';
    }
  }

  _push(stream, line) {
    const entry = { ts: Date.now(), stream, line };
    this.lines.push(entry);
    if (this.lines.length > this.ringSize) {
      this.lines.splice(0, this.lines.length - this.ringSize);
    }
    appendStreamEvent({ type: 'log', name: this.name, ...entry });
  }

  /** Return all lines newer than `sinceTs` (ms). 0 = all. */
  since(sinceTs = 0) {
    if (!sinceTs) return this.lines.slice();
    return this.lines.filter(l => l.ts > sinceTs);
  }

  stop() {
    if (!this.proc || this.killed) return;
    this.killed = true;
    try { this.proc.kill('SIGTERM'); } catch {}
    setTimeout(() => {
      try {
        if (this.proc && !this.proc.killed) this.proc.kill('SIGKILL');
      } catch {}
    }, 2000).unref();
  }

  status() {
    return {
      name: this.name,
      command: this.command,
      startedAt: this.startedAt,
      exitCode: this.exitCode,
      running: this.proc != null && this.exitCode == null,
      lineCount: this.lines.length,
    };
  }
}

export class LogTailManager {
  constructor({ enabled = process.env.BRAINBOW_LOG_TAILS_ENABLED === 'true' } = {}) {
    this.enabled = enabled;
    this.tails = new Map();
  }

  ensureEnabled() {
    if (!this.enabled) {
      const err = new Error('log_tails_disabled: set BRAINBOW_LOG_TAILS_ENABLED=true to enable');
      err.code = 'log_tails_disabled';
      throw err;
    }
  }

  subscribe({ name, command }) {
    this.ensureEnabled();
    if (!name || !command) throw new Error('name and command required');
    if (this.tails.has(name)) {
      const err = new Error(`log_tail_exists: ${name}`);
      err.code = 'log_tail_exists';
      throw err;
    }
    const tail = new LogTail({ name, command });
    tail.start();
    this.tails.set(name, tail);
    return tail.status();
  }

  unsubscribe(name) {
    const t = this.tails.get(name);
    if (!t) return false;
    t.stop();
    this.tails.delete(name);
    return true;
  }

  get(name) {
    return this.tails.get(name) || null;
  }

  list() {
    return Array.from(this.tails.values()).map(t => t.status());
  }

  /** Snapshot all tails since cursor. Returns { name → lines[] }. */
  snapshot(sinceTs = 0) {
    const out = {};
    for (const [name, tail] of this.tails) {
      out[name] = tail.since(sinceTs);
    }
    return out;
  }

  stopAll() {
    for (const t of this.tails.values()) t.stop();
    this.tails.clear();
  }
}
