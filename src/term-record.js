// Terminal recording — the other half of brainbow.
//
// Brainbow already records the browser the agent is driving. This records the
// TERMINAL the agent is living in, so a session can say "clear the screen and
// record this" and get back a GIF of that terminal doing it.
//
// Two capture paths, because "record the terminal I am in" means different
// things depending on how you got there:
//
//   attach  — the session is inside tmux, so the caller's own pane can be teed
//             live with `tmux pipe-pane`. This is literally the terminal the
//             agent is in: whatever it prints while recording is what lands in
//             the file, including output from tools the recorder never ran.
//
//   replay  — no tmux, so nothing can reach into the parent's PTY. Instead we
//             open a fresh PTY with the CALLER'S geometry, cwd and environment
//             and run the requested command in it. Same shell, same size, same
//             colours, real output — but it is a second terminal, not the one
//             the agent is sitting in. We say so in the result rather than
//             pretending otherwise.
//
// Both paths produce asciicast v2, which `agg` renders to GIF and ffmpeg turns
// into mp4/webm. Nothing here shells out through the REST server: the terminal
// is local to this process by definition.

import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pexec = promisify(execFile);

export const RECORDINGS_DIR =
  process.env.BRAINBOW_RECORDINGS ||
  process.env.GHOST_RECORDINGS ||
  path.join(os.tmpdir(), 'brainbow-recordings');

const have = (bin) => {
  try { execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }); return true; }
  catch { return false; }
};

export function capabilities() {
  return {
    asciinema: have('asciinema'),
    agg: have('agg'),
    ffmpeg: have('ffmpeg'),
    tmux: have('tmux'),
    inTmux: Boolean(process.env.TMUX),
  };
}

// ── finding the caller's terminal ────────────────────────────────────────
//
// This process is a child of the agent (agenticode / Claude Code), which is
// the one holding the PTY. Walk up the parent chain until we find a process
// with a real tty, then ask that tty how big it is. Everything is best-effort:
// a wrong guess costs us a default 100x30, not a failure.

function ppidOf(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm can contain spaces and parens, so slice from the LAST ')'
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return Number.parseInt(after[1], 10) || 0;
  } catch { return 0; }
}

function ttyOf(pid) {
  try {
    const link = fs.readlinkSync(`/proc/${pid}/fd/0`);
    return link.startsWith('/dev/pts/') || link === '/dev/tty' ? link : null;
  } catch { return null; }
}

export function detectTerminal() {
  let pid = process.pid;
  let tty = null;
  const chain = [];
  for (let hop = 0; hop < 12 && pid > 1; hop++) {
    const t = ttyOf(pid);
    chain.push({ pid, tty: t });
    if (t) { tty = t; break; }
    pid = ppidOf(pid);
  }

  let cols = Number.parseInt(process.env.COLUMNS || '', 10) || 0;
  let rows = Number.parseInt(process.env.LINES || '', 10) || 0;
  if (tty && (!cols || !rows)) {
    try {
      const out = execFileSync('sh', ['-c', `stty size < ${tty}`], { encoding: 'utf8' }).trim();
      const [r, c] = out.split(/\s+/).map(Number);
      if (r && c) { rows = r; cols = c; }
    } catch { /* the tty may not be ours to stat; fall through to defaults */ }
  }
  return {
    tty,
    pid: tty ? pid : null,
    cols: cols || 100,
    rows: rows || 30,
    term: process.env.TERM || 'xterm-256color',
    chain,
  };
}

// ── output naming ────────────────────────────────────────────────────────

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
}

function safeName(name) {
  return String(name || '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
}

function outBase(filename) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  const base = safeName(filename) || `term-${stamp()}`;
  return path.join(RECORDINGS_DIR, base);
}

// ── replay capture: a fresh PTY shaped like the caller's ─────────────────

export async function recordCommand({
  command,
  cwd = process.cwd(),
  cols,
  rows,
  clear = true,
  title,
  idleLimit = 2,
  filename,
  timeoutMs = 15 * 60 * 1000,
} = {}) {
  if (!command || !String(command).trim()) throw new Error('command is required');
  if (!have('asciinema')) throw new Error('asciinema is not installed — cannot capture a PTY');

  const term = detectTerminal();
  const base = outBase(filename);
  const cast = `${base}.cast`;

  // `clear` is the "clear the page" half of the request: the recording opens on
  // an empty screen instead of whatever scrollback happened to be there.
  const script = `${clear ? 'clear; ' : ''}${command}`;

  const args = [
    'rec', cast,
    '--overwrite',
    '--quiet',
    '--cols', String(cols || term.cols),
    '--rows', String(rows || term.rows),
    '--idle-time-limit', String(idleLimit),
    '--command', script,
  ];
  if (title) args.push('--title', title);

  await new Promise((resolve, reject) => {
    const child = spawn('asciinema', args, {
      cwd,
      env: { ...process.env, TERM: term.term },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`recording exceeded ${Math.round(timeoutMs / 1000)}s and was killed`));
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    // A non-zero exit is the RECORDED command failing, not the recorder — the
    // cast is still valid and a failed run is often exactly what you wanted on
    // camera. Only a missing cast file is fatal.
    child.on('close', () => {
      clearTimeout(timer);
      if (fs.existsSync(cast)) resolve();
      else reject(new Error(`asciinema produced no cast: ${err.trim().slice(0, 400)}`));
    });
  });

  return { cast, mode: 'replay', terminal: term, cwd, command: script };
}

// ── attach capture: the caller's real tmux pane ──────────────────────────
//
// tmux pipe-pane tees the pane's output to a command while the pane keeps
// running. That is the only way to capture the terminal the agent is already
// sitting in without having wrapped it at startup. We timestamp the chunks as
// they arrive and assemble an asciicast at stop time.

const attached = new Map(); // sessionId -> { raw, cast, pane, started, cols, rows }

export function attachStart({ sessionId = 'default', pane, filename } = {}) {
  if (!process.env.TMUX) {
    throw new Error(
      'not inside tmux — the caller\'s PTY cannot be teed. Use mode "replay", ' +
      'or start the agent inside tmux to capture its own terminal live.',
    );
  }
  if (attached.has(sessionId)) throw new Error(`already attached for session ${sessionId}`);
  if (!have('tmux')) throw new Error('tmux is not installed');

  const target = pane || execFileSync('tmux', ['display-message', '-p', '#{pane_id}'], { encoding: 'utf8' }).trim();
  const size = execFileSync(
    'tmux', ['display-message', '-p', '-t', target, '#{pane_width} #{pane_height}'],
    { encoding: 'utf8' },
  ).trim().split(/\s+/).map(Number);

  const base = outBase(filename);
  const raw = `${base}.raw`;
  fs.writeFileSync(raw, '');

  // -o toggles: the same command again stops the tee. Timestamps come from the
  // reader side at stop, so we record our own start clock here.
  execFileSync('tmux', ['pipe-pane', '-t', target, '-O', `cat >> ${JSON.stringify(raw)}`]);

  const state = {
    raw,
    cast: `${base}.cast`,
    pane: target,
    started: Date.now(),
    cols: size[0] || 100,
    rows: size[1] || 30,
    watcher: null,
    chunks: [],
  };
  // Poll the tee file and timestamp growth, which is what turns a flat byte
  // stream back into something with timing.
  let seen = 0;
  state.watcher = setInterval(() => {
    try {
      const sz = fs.statSync(raw).size;
      if (sz > seen) {
        const fd = fs.openSync(raw, 'r');
        const buf = Buffer.alloc(sz - seen);
        fs.readSync(fd, buf, 0, buf.length, seen);
        fs.closeSync(fd);
        seen = sz;
        state.chunks.push([(Date.now() - state.started) / 1000, buf.toString('utf8')]);
      }
    } catch { /* file may be mid-write; next tick will catch up */ }
  }, 40);

  attached.set(sessionId, state);
  return { sessionId, pane: target, raw, cols: state.cols, rows: state.rows };
}

export function attachStop({ sessionId = 'default' } = {}) {
  const state = attached.get(sessionId);
  if (!state) throw new Error(`no attached recording for session ${sessionId}`);
  attached.delete(sessionId);
  clearInterval(state.watcher);
  try { execFileSync('tmux', ['pipe-pane', '-t', state.pane]); } catch { /* pane may be gone */ }

  // final drain
  try {
    const sz = fs.statSync(state.raw).size;
    const seen = state.chunks.reduce((a, [, s]) => a + Buffer.byteLength(s), 0);
    if (sz > seen) {
      const fd = fs.openSync(state.raw, 'r');
      const buf = Buffer.alloc(sz - seen);
      fs.readSync(fd, buf, 0, buf.length, seen);
      fs.closeSync(fd);
      state.chunks.push([(Date.now() - state.started) / 1000, buf.toString('utf8')]);
    }
  } catch { /* nothing left to drain */ }

  const header = {
    version: 2,
    width: state.cols,
    height: state.rows,
    timestamp: Math.floor(state.started / 1000),
    env: { SHELL: process.env.SHELL || '/bin/sh', TERM: process.env.TERM || 'xterm-256color' },
  };
  const body = state.chunks.map(([t, s]) => JSON.stringify([t, 'o', s])).join('\n');
  fs.writeFileSync(state.cast, `${JSON.stringify(header)}\n${body}\n`);
  return { cast: state.cast, mode: 'attach', pane: state.pane, events: state.chunks.length };
}

export function attachStatus({ sessionId = 'default' } = {}) {
  const state = attached.get(sessionId);
  if (!state) return { attached: false, sessionId };
  return {
    attached: true,
    sessionId,
    pane: state.pane,
    elapsedMs: Date.now() - state.started,
    events: state.chunks.length,
    bytes: state.chunks.reduce((a, [, s]) => a + Buffer.byteLength(s), 0),
  };
}


// ── auto-fit ─────────────────────────────────────────────────────────────
//
// agg renders the whole terminal grid, so a 51-row terminal printing 12 rows
// of output gives you a GIF that is three quarters empty. Measure what the
// recording actually drew and hand agg a matching height.
//
// Only safe for line-oriented output. Anything that took the alternate screen
// (vim, a TUI, less) or moved the cursor absolutely is using the full grid on
// purpose, so leave those alone.
export function fitRows(cast, maxRows) {
  let text = '';
  try {
    const lines = fs.readFileSync(cast, 'utf8').split('\n');
    for (const line of lines.slice(1)) {
      if (!line.startsWith('[')) continue;
      try {
        const ev = JSON.parse(line);
        if (ev[1] === 'o') text += ev[2];
      } catch { /* truncated tail */ }
    }
  } catch { return null; }

  if (/\x1b\[\?1049[hl]/.test(text)) return null;          // alt screen
  if (/\x1b\[\d*;\d*[Hf]/.test(text)) return null;         // absolute cursor moves

  // Split on the clear BEFORE stripping escapes — the CSI strip below would
  // otherwise eat the clear sequence itself and we would measure the scrollback
  // we are trying to throw away.
  const afterClear = text.split(/\x1b\[2J|\x1bc/).pop();
  const plain = afterClear
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')       // OSC
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')                // CSI
    .replace(/\r/g, '');
  // A trailing newline already puts the cursor on the next line, so the split
  // length IS the row the terminal ended on. Adding one more leaves a blank.
  const used = plain.split('\n').length;
  const want = Math.min(maxRows, Math.max(3, used));
  return want < maxRows ? want : null;
}

// ── rendering ────────────────────────────────────────────────────────────

const THEMES = {
  // Matches the gnomus/brainbow palette: warm paper on near-black.
  gnomus: '14120E,EFE7D6,14120E,C4593A,7FBF95,D8A54B,7FA6C4,B48EAD,8ABFB8,EFE7D6,6B6355,D86E4D,96D4AA,E8BC6A,9CBFD8,C9A6C4,A4D4CD,FFFFFF',
  dracula: 'dracula',
  monokai: 'monokai',
  solarized: 'solarized-dark',
  asciinema: 'asciinema',
};

export async function renderGif(cast, {
  theme = 'gnomus',
  fontSize = 16,
  speed = 1,
  fpsCap = 24,
  lineHeight,
  cols,
  rows,
  autoFit = true,
  castRows,
} = {}) {
  if (!have('agg')) throw new Error('agg is not installed — cannot render a GIF from the cast');
  const gif = cast.replace(/\.cast$/, '.gif');
  const args = [
    '--theme', THEMES[theme] || theme,
    '--font-size', String(fontSize),
    '--speed', String(speed),
    '--fps-cap', String(fpsCap),
  ];
  if (lineHeight) args.push('--line-height', String(lineHeight));
  if (cols) args.push('--cols', String(cols));
  if (rows) args.push('--rows', String(rows));
  else if (autoFit && castRows) {
    const fitted = fitRows(cast, castRows);
    if (fitted) args.push('--rows', String(fitted));
  }
  args.push(cast, gif);
  await pexec('agg', args, { maxBuffer: 32 * 1024 * 1024 });
  return gif;
}

export async function renderVideo(gif, { format = 'mp4', quality = 'high' } = {}) {
  if (!have('ffmpeg')) throw new Error('ffmpeg is not installed');
  const out = gif.replace(/\.gif$/, `.${format}`);
  const crf = { high: 18, medium: 24, low: 30 }[quality] ?? 18;
  // yuv420p + even dimensions, or half the players in the world refuse it.
  const args = [
    '-y', '-nostdin', '-i', gif,
    '-movflags', '+faststart',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
    '-crf', String(crf),
  ];
  if (format === 'webm') args.splice(args.indexOf('-crf'), 0, '-c:v', 'libvpx-vp9', '-b:v', '0');
  args.push(out);
  await pexec('ffmpeg', args, { maxBuffer: 32 * 1024 * 1024 });
  return out;
}

export function describe(file) {
  const s = fs.statSync(file);
  const kb = s.size / 1024;
  return {
    path: file,
    name: path.basename(file),
    bytes: s.size,
    size: kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`,
  };
}

// ── the whole job, front to back ─────────────────────────────────────────

export async function record(opts = {}) {
  const {
    mode = 'auto',
    formats = ['gif'],
    theme, fontSize, speed, fpsCap,
    ...rest
  } = opts;

  const useAttach = mode === 'attach' || (mode === 'auto' && Boolean(process.env.TMUX) && !rest.command);
  if (useAttach) throw new Error('attach mode is started and stopped separately — call term_attach_start / term_attach_stop');

  const { cast, terminal, ...meta } = await recordCommand(rest);
  const outputs = {};
  outputs.cast = describe(cast);
  const gif = await renderGif(cast, {
    theme, fontSize, speed, fpsCap,
    autoFit: opts.autoFit !== false,
    castRows: rest.rows || terminal.rows,
  });
  outputs.gif = describe(gif);
  for (const f of formats.filter((f) => f !== 'gif' && f !== 'cast')) {
    outputs[f] = describe(await renderVideo(gif, { format: f }));
  }
  return { ...meta, terminal, outputs, dir: RECORDINGS_DIR };
}

export async function renderFromCast(cast, { formats = ['gif'], theme, fontSize, speed, fpsCap, autoFit, castRows } = {}) {
  const outputs = { cast: describe(cast) };
  const gif = await renderGif(cast, { theme, fontSize, speed, fpsCap, autoFit, castRows });
  outputs.gif = describe(gif);
  for (const f of formats.filter((f) => f !== 'gif' && f !== 'cast')) {
    outputs[f] = describe(await renderVideo(gif, { format: f }));
  }
  return outputs;
}
