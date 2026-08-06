import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as term from '../../src/term-record.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, '../../src/mcp-server.js'), 'utf8');

// Terminal recording is the counterpart to the browser recording tools: same
// idea, different surface. These tests cover the parts that are pure — the tool
// registration, the TTY walk, and the auto-fit measurement — without spawning a
// PTY, so they stay fast and work in CI where there is no terminal at all.

describe('term recording — tool surface', () => {
  it('registers the four terminal tools', async () => {
    const mod = await import('../../src/mcp-server.js');
    for (const name of ['term_record', 'term_attach_start', 'term_attach_stop', 'term_status']) {
      expect(mod.TOOLS.find((t) => t.name === name), `${name} missing`).toBeTruthy();
    }
  });

  it('requires a command on term_record and nothing else', async () => {
    const mod = await import('../../src/mcp-server.js');
    const t = mod.TOOLS.find((x) => x.name === 'term_record');
    expect(t.inputSchema.required).toEqual(['command']);
    expect(Object.keys(t.inputSchema.properties)).toEqual(
      expect.arrayContaining(['command', 'clear', 'formats', 'theme', 'speed']),
    );
  });

  it('dispatches each terminal tool', () => {
    for (const name of ['term_record', 'term_attach_start', 'term_attach_stop', 'term_status']) {
      expect(SRC).toMatch(new RegExp(`case '${name}':`));
    }
  });

  it('tells the caller when it captured a stand-in rather than their own pane', () => {
    // The honesty of the replay path is the whole point — if this note is ever
    // dropped, a GIF from a fresh PTY starts passing as the agent's own session.
    expect(SRC).toMatch(/Not the agent.{0,2}s own pane/);
  });
});

describe('term recording — terminal detection', () => {
  it('walks up to a real tty and always returns usable geometry', () => {
    const t = term.detectTerminal();
    expect(t.cols).toBeGreaterThan(0);
    expect(t.rows).toBeGreaterThan(0);
    expect(Array.isArray(t.chain)).toBe(true);
    if (t.tty) expect(t.tty).toMatch(/^\/dev\/(pts\/\d+|tty)$/);
  });

  it('reports which binaries the capture paths need', () => {
    const c = term.capabilities();
    for (const k of ['asciinema', 'agg', 'ffmpeg', 'tmux', 'inTmux']) {
      expect(typeof c[k]).toBe('boolean');
    }
  });

  it('refuses to attach when the caller is not inside tmux', () => {
    const saved = process.env.TMUX;
    delete process.env.TMUX;
    try {
      expect(() => term.attachStart({ sessionId: 'unit' })).toThrow(/not inside tmux/);
    } finally {
      if (saved !== undefined) process.env.TMUX = saved;
    }
  });

  it('reports no capture in progress for an unknown session', () => {
    expect(term.attachStatus({ sessionId: 'nope' })).toEqual({ attached: false, sessionId: 'nope' });
  });
});

describe('term recording — auto-fit', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-term-'));
  const write = (name, events) => {
    const p = path.join(tmp, name);
    const header = JSON.stringify({ version: 2, width: 80, height: 50 });
    fs.writeFileSync(p, `${header}\n${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
    return p;
  };

  it('crops a short line-oriented recording down to the rows it used', () => {
    const cast = write('short.cast', [[0.1, 'o', 'one\ntwo\nthree\n']]);
    expect(term.fitRows(cast, 50)).toBe(4);
  });

  it('measures from the last clear, not the start of the recording', () => {
    const cast = write('cleared.cast', [
      [0.1, 'o', 'noise\n'.repeat(30)],
      [0.2, 'o', '\x1b[2J'],
      [0.3, 'o', 'after\n'],
    ]);
    expect(term.fitRows(cast, 50)).toBe(3);
  });

  it('leaves the full grid alone when the recording took the alternate screen', () => {
    // vim, less, a TUI — these are using the whole terminal deliberately.
    const cast = write('alt.cast', [[0.1, 'o', '\x1b[?1049hhello\n']]);
    expect(term.fitRows(cast, 50)).toBeNull();
  });

  it('leaves the full grid alone when the cursor was positioned absolutely', () => {
    const cast = write('abs.cast', [[0.1, 'o', '\x1b[12;40Hhello\n']]);
    expect(term.fitRows(cast, 50)).toBeNull();
  });

  it('does not crop when the content already fills the terminal', () => {
    const cast = write('full.cast', [[0.1, 'o', 'x\n'.repeat(60)]]);
    expect(term.fitRows(cast, 50)).toBeNull();
  });

  it('returns null rather than throwing on a cast it cannot read', () => {
    expect(term.fitRows(path.join(tmp, 'missing.cast'), 50)).toBeNull();
  });
});
