// SPDX-License-Identifier: MIT
/**
 * Brainbow — Shared Browser Control + Recording Studio
 *
 * Transport layer only. State lives in Session; lifecycle lives in SessionManager.
 * Every handler resolves a Session via sessionIdOf(req), then delegates to it.
 *
 * Usage:
 *   node server.js                          # starts on port 4444
 *   BRAINBOW_PORT=5555 node server.js       # custom port
 *   CHROME_PATH=/usr/bin/chromium node server.js
 */

import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { redactSecrets } from './src/redaction.js';
import { Session } from './src/session.js';
import { SessionManager } from './src/session-manager.js';
import { registerLiveRoutes } from './src/live-routes.js';
import { requireBrowser } from './src/require-browser.js';
import { makeViewerOpenHandler } from './src/viewer-open.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number.parseInt(process.env.BRAINBOW_PORT || process.env.GHOST_PORT || '4444');
const RECORDINGS_DIR = process.env.BRAINBOW_RECORDINGS
  || process.env.GHOST_RECORDINGS
  || path.join(os.tmpdir(), 'brainbow-recordings');
if (process.env.GHOST_RECORDINGS && !process.env.BRAINBOW_RECORDINGS) {
  console.warn('[Brainbow] GHOST_RECORDINGS is deprecated — use BRAINBOW_RECORDINGS.');
}

fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

// Check ffmpeg availability
let hasFFmpeg = false;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); hasFFmpeg = true; } catch { /* no-op */ }

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.text({ type: 'text/*' }));

// ─── Authentication Middleware ──────────────────────────────────────────────
const BRAINBOW_TOKEN = process.env.BRAINBOW_TOKEN || process.env.GHOST_SECRET;
if (process.env.GHOST_SECRET && !process.env.BRAINBOW_TOKEN) {
  console.warn('[Brainbow] GHOST_SECRET is deprecated — use BRAINBOW_TOKEN.');
}
if (BRAINBOW_TOKEN) {
  app.use((req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${BRAINBOW_TOKEN}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  });
} // If BRAINBOW_TOKEN not set, all requests pass through (backward compat for local dev)

// ─── NEVER-DIE GUARDS (shared REST :4444) ──────────────────────────────
// This is the ONE shared server every brainbow MCP shim proxies to. If it
// exits, EVERY Claude loses ALL brainbow tools at once (every `fetch` from
// every mcp-server.js fails). It must never die on a runtime throw.
//
// Real-world crash vectors this catches:
//   • a `ws` socket emitting an 'error' event with no listener (the ws
//     library re-throws those as uncaught exceptions),
//   • an async CDP screencast callback rejecting after a Chromium crash,
//   • a page-text-watcher / vision tick rejecting on a detached frame,
//   • any provider/network reject that escaped a route's try/catch.
// All of these are logged and SWALLOWED — the server keeps serving.
process.on('uncaughtException', (err, origin) => {
  try {
    console.error(`[Brainbow] uncaughtException (${origin}) — staying up:`, err?.stack || err);
  } catch { /* logging must never crash us */ }
});
process.on('unhandledRejection', (reason) => {
  try {
    console.error('[Brainbow] unhandledRejection — staying up:', reason?.stack || reason);
  } catch { /* ignore */ }
});

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });
// An HTTP server 'error' event with no listener (e.g. a transient
// ECONNRESET on a hung socket) would otherwise bubble to uncaughtException.
server.on('clientError', (err, socket) => {
  try { socket.destroy(); } catch { /* already gone */ }
});
server.on('error', (err) => {
  console.error('[Brainbow] http server error (continuing):', err?.message || err);
});

// ─── SessionManager ─────────────────────────────────────────────────────────
const MODE = process.env.BRAINBOW_MODE || 'local';
const sessionManager = new SessionManager({ SessionClass: Session, mode: MODE });

function sessionIdOf(req) {
  return req.query.sessionId
      || req.headers['x-brainbow-session']
      || req.body?.sessionId
      || 'default';
}

/**
 * whoami/viewer default: pick the most-recently-used session so opening
 * the viewer at `/` lands on the live session without the user clicking
 * through a picker. Regression from the tabs work where the default
 * always resolved to 'default' — which stayed empty when all real
 * activity happened on named sessions.
 */
function defaultViewerSessionId() {
  return sessionManager.mostRecentId() || 'default';
}

async function getSession(req, res) {
  try {
    const sid = sessionIdOf(req);
    const session = await sessionManager.get(sid);
    // Bump activity so /api/whoami's default-session pick reflects
    // real traffic, not just insertion order.
    sessionManager.touch(sid);
    return session;
  } catch (e) {
    res.status(404).json({ error: e.message, code: e.code });
    return null;
  }
}

// requireBrowser() — the auto-recover guard run before every
// browser-touching endpoint — lives in src/require-browser.js so it is
// unit-testable without binding the REST port. It gates recovery on the
// DURABLE session.wasLaunched flag (NOT session.browser, which the chromium
// disconnect handler nulls), then RE-CHECKS session.page after any relaunch.
// See src/require-browser.js for the full "session drops constantly" bug story.

// ─── Vision config (process-wide) ───────────────────────────────────────────
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const VISION_MODEL = process.env.VISION_MODEL || 'moondream';
const VISION_INTERVAL = Number.parseInt(process.env.VISION_INTERVAL || '2000');

let visionModelReady = false;

async function checkVisionModel() {
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/tags`);
    const data = await resp.json();
    const models = (data.models || []).map(m => m.name);
    const visionModels = models.filter(m =>
      /llava|minicpm|bakllava|moondream|qwen.*vl/i.test(m)
    );
    if (visionModels.length > 0) {
      visionModelReady = true;
      console.log(`[Brainbow] Vision model(s) available: ${visionModels.join(', ')}`);
      return visionModels[0].split(':')[0];
    }
    console.log(`[Brainbow] No vision model found. Available: ${models.join(', ')}. Pulling ${VISION_MODEL}...`);
    fetch(`${OLLAMA_URL}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: VISION_MODEL, stream: false }),
    }).then(() => {
      visionModelReady = true;
      console.log(`[Brainbow] ${VISION_MODEL} pulled successfully`);
    }).catch(e => console.error(`[Brainbow] Vision pull failed: ${e.message}`));
    return null;
  } catch (e) {
    console.error(`[Brainbow] Ollama not reachable: ${e.message}`);
    return null;
  }
}

// ─── Per-session vision helpers ──────────────────────────────────────────────
const DEFAULT_VISION_PROMPT = 'Describe what you see on this screen. Focus on: what app/page is shown, any error messages, loading states, data displayed, buttons/controls visible. Be concise but thorough.';

async function describeScreen(session, prompt = DEFAULT_VISION_PROMPT) {
  if (!session.lastFrameB64) return 'No browser frame available';

  const userPrompt = prompt;

  try {
    const resp = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: VISION_MODEL,
        prompt: userPrompt,
        images: [session.lastFrameB64],
        stream: false,
        options: { temperature: 0.1, num_predict: 500 },
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      session.visionError = `Ollama ${resp.status}: ${err.substring(0, 200)}`;
      return session.visionError;
    }

    const data = await resp.json();
    session.visionDescription = data.response || '';
    session.visionTimestamp = Date.now();
    session.visionError = null;
    return session.visionDescription;
  } catch (e) {
    session.visionError = e.message;
    return `Vision error: ${e.message}`;
  }
}

function requestHumanInput(session, prompt, type = 'text', timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const id = Date.now().toString(36);
    session.hitlPending = { resolve, reject, prompt, type, id };

    session.broadcast({ type: 'hitl_request', id, prompt, inputType: type });
    session.log('hitl', `Waiting for user: ${prompt}`);

    setTimeout(() => {
      if (session.hitlPending?.id === id) {
        session.hitlPending = null;
        reject(new Error('HITL timeout — user did not respond'));
      }
    }, timeoutMs);
  });
}

// ─── Pure utilities (no session state) ──────────────────────────────────────

function humanSize(bytes) {
  if (bytes > 1048576) return `${(bytes / 1048576).toFixed(1)}MB`;
  return `${(bytes / 1024).toFixed(0)}KB`;
}

function gifScaleFor(quality) {
  if (quality === 'high') return 800;
  if (quality === 'medium') return 540;
  return 360;
}

async function encodeRecording(frames, opts = {}) {
  const { format = 'gif', quality = 'high', speed = 1, zoom, filename } = opts;
  const ts = Date.now();
  // Derive a safe output name that ALWAYS carries the right extension.
  // Bug fix (2026-06-16): a caller-supplied `filename` was used verbatim with
  // NO extension, so ffmpeg could not infer the muxer and failed with exit 234
  // ("use a standard extension or specify the format manually"). Strip any
  // extension the caller added, sanitize to the /api/recordings/:name charset
  // ([A-Za-z0-9._-]), then append the correct container extension.
  let base = (filename && String(filename).trim()) || `ghost-${ts}`;
  base = base.replace(/\.(mp4|webm|gif|png|jpe?g)$/i, '');
  base = base.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '') || `ghost-${ts}`;
  const outName = `${base}.${format}`;
  const outFile = path.join(RECORDINGS_DIR, outName);

  const tmpDir = path.join(os.tmpdir(), `ghost-encode-${ts}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  for (let i = 0; i < frames.length; i++) {
    const buf = Buffer.from(frames[i].data, 'base64');
    fs.writeFileSync(path.join(tmpDir, `frame-${String(i).padStart(6, '0')}.jpg`), buf);
  }

  const durationSec = Math.max(frames[frames.length - 1].ts / 1000, 0.1);
  const rawFps = Math.min(Math.round(frames.length / durationSec), 30);
  const inputFps = Math.max(Math.round(rawFps / speed), 1);

  if (!hasFFmpeg) {
    const framesDir = path.join(RECORDINGS_DIR, `brainbow-${ts}-frames`);
    fs.renameSync(tmpDir, framesDir);
    return {
      file: framesDir,
      format: 'frames',
      frameCount: frames.length,
      duration: `${durationSec.toFixed(1)}s`,
      size: 0,
      sizeHuman: `${frames.length} frames`,
      note: 'Install ffmpeg for GIF/MP4/WebM: apt-get install ffmpeg',
    };
  }

  try {
    const cropFilter = zoom ? `crop=${zoom.width}:${zoom.height}:${zoom.x}:${zoom.y},` : '';

    if (format === 'gif') {
      const scale = gifScaleFor(quality);
      const paletteFile = path.join(tmpDir, 'palette.png');

      await runFFmpeg([
        '-framerate', String(inputFps),
        '-i', path.join(tmpDir, 'frame-%06d.jpg'),
        '-vf', `${cropFilter}scale=${scale}:-1:flags=lanczos,palettegen=max_colors=256:stats_mode=diff`,
        '-y', paletteFile,
      ]);

      await runFFmpeg([
        '-framerate', String(inputFps),
        '-i', path.join(tmpDir, 'frame-%06d.jpg'),
        '-i', paletteFile,
        '-lavfi', `${cropFilter}scale=${scale}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`,
        '-y', outFile,
      ]);
    } else if (format === 'mp4') {
      const filters = [];
      if (zoom) filters.push(`crop=${zoom.width}:${zoom.height}:${zoom.x}:${zoom.y}`);
      filters.push('pad=ceil(iw/2)*2:ceil(ih/2)*2');

      await runFFmpeg([
        '-framerate', String(inputFps),
        '-i', path.join(tmpDir, 'frame-%06d.jpg'),
        '-vf', filters.join(','),
        '-c:v', 'libx264',
        '-preset', quality === 'high' ? 'slow' : 'fast',
        '-crf', quality === 'high' ? '18' : '23',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-y', outFile,
      ]);
    } else if (format === 'webm') {
      const filters = [];
      if (zoom) filters.push(`crop=${zoom.width}:${zoom.height}:${zoom.x}:${zoom.y}`);

      await runFFmpeg([
        '-framerate', String(inputFps),
        '-i', path.join(tmpDir, 'frame-%06d.jpg'),
        ...(filters.length ? ['-vf', filters.join(',')] : []),
        '-c:v', 'libvpx-vp9',
        '-crf', '20',
        '-b:v', '0',
        '-y', outFile,
      ]);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const stat = fs.statSync(outFile);
  return {
    file: outFile,
    url: `/api/recordings/${outName}`,
    format,
    frameCount: frames.length,
    duration: `${durationSec.toFixed(1)}s`,
    fps: rawFps,
    size: stat.size,
    sizeHuman: humanSize(stat.size),
  };
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.substring(stderr.length - 500)}`));
    });
    proc.on('error', (e) => reject(new Error(`ffmpeg not found or failed: ${e.message}`)));
  });
}

// ─── Session identity endpoints ──────────────────────────────────────────────

app.get('/api/whoami', (req, res) => {
  // If the client passed ?sessionId explicitly, honor it. Otherwise pick
  // the most-recently-used session so the default viewer auto-lands on
  // the active one instead of an empty 'default' session.
  const sid = req.query.sessionId
    || req.headers['x-brainbow-session']
    || defaultViewerSessionId();
  res.json({ sessionId: sid, mode: MODE });
});

app.get('/api/sessions', (req, res) => {
  res.json({ sessions: sessionManager.list(), mode: MODE });
});

/**
 * POST /api/viewer/open  { sessionId? }
 *
 * Open the live viewer for a session in the user's default browser ON DEMAND.
 * Bug 2: the viewer no longer auto-pops on MCP/WSL startup
 * (BRAINBOW_AUTOOPEN_VIEWER now defaults false) — instead the agent or human
 * calls this when they actually want the window. Runs the same opener chain
 * the launcher used (wslview → cmd.exe → xdg-open → open). Returns
 * { ok, url, opener }. When no opener is available, ok:false but the URL is
 * still returned so a human can open it manually.
 */
app.post('/api/viewer/open', makeViewerOpenHandler({
  port: PORT,
  defaultSessionId: defaultViewerSessionId,
}));

// ─── REST API ───────────────────────────────────────────────────────────────

app.post('/api/launch', async (req, res) => {
  try {
    const session = await sessionManager.get(sessionIdOf(req));
    const result = await session.launch(req.body || {});
    res.json({ ...result, sessionId: session.sessionId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/close', async (req, res) => {
  const sid = sessionIdOf(req);
  await sessionManager.remove(sid);
  res.json({ ok: true, sessionId: sid });
});

/**
 * Multi-tab endpoints — all actions target the active tab by default,
 * so existing click/type/goto calls don't need to care about tabs.
 * `GET /api/tabs`     → list tabs (index, active, url, title)
 * `POST /api/tabs/new`   { url?, activate? } → open a new tab
 * `POST /api/tabs/switch` { index } → activate a tab (restarts screencast on it)
 * `POST /api/tabs/close`  { index } → close a tab (can't close the last one)
 */
app.get('/api/tabs', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!(await requireBrowser(session, res))) return;
  try {
    const tabs = await session.listTabs();
    res.json({ tabs, count: tabs.length, sessionId: session.sessionId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tabs/new', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!(await requireBrowser(session, res))) return;
  try {
    const { url, activate } = req.body || {};
    const result = await session.openTab({ url, activate });
    res.json({ ...result, sessionId: session.sessionId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tabs/switch', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!(await requireBrowser(session, res))) return;
  try {
    const { index } = req.body || {};
    if (typeof index !== 'number') {
      return res.status(400).json({ error: '{index} number required' });
    }
    const result = await session.switchTab(index);
    res.json({ ...result, sessionId: session.sessionId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tabs/close', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!(await requireBrowser(session, res))) return;
  try {
    const { index } = req.body || {};
    if (typeof index !== 'number') {
      return res.status(400).json({ error: '{index} number required' });
    }
    const result = await session.closeTab(index);
    res.json({ ...result, sessionId: session.sessionId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/goto', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!(await requireBrowser(session, res))) return;
  try {
    const { url, waitUntil = 'domcontentloaded' } = req.body;
    session.log('goto', url);
    await session.page.goto(url, { waitUntil, timeout: 30000 });
    res.json({ ok: true, url: session.page.url(), title: await session.page.title(), sessionId: session.sessionId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/resize { width, height }
 *
 * Resize the viewport of a running session without losing page state.
 * Agents (and humans) use this when they need a different aspect ratio
 * or more room to scan a UI — e.g., "resize to 1920x1200 to capture a
 * full admin dashboard screenshot". Screencast auto-restarts at the new
 * dims so the next `/api/screen` + `/api/frame` returns the right size.
 *
 * Unlike Playwright MCP's `browser_resize` which silently resets on
 * context rebuild, this persists on Session until the next resize or
 * close.
 */
app.post('/api/resize', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!(await requireBrowser(session, res))) return;
  try {
    const { width, height } = req.body || {};
    if (!width || !height) {
      return res.status(400).json({ error: 'width and height required in body' });
    }
    const result = await session.resize(width, height);
    res.json({ ...result, sessionId: session.sessionId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * GET|POST /api/snapshot — accessibility tree of the live page.
 *
 * Mirrors Playwright MCP's `browser_snapshot` shape: returns
 * { url, title, viewport, tree } where `tree` is the Chromium
 * accessibility tree serialized to JSON. Agents can pick elements
 * by role/name without writing CSS selectors.
 *
 * Optional body: { interestingOnly: boolean } — when false, returns
 * the full DOM a11y tree (large); defaults to true which filters to
 * actionable/meaningful nodes only.
 */
app.post('/api/snapshot', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!(await requireBrowser(session, res))) return;
  try {
    const result = await session.snapshot(req.body || {});
    res.json({ ...result, sessionId: session.sessionId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/snapshot', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!(await requireBrowser(session, res))) return;
  try {
    const result = await session.snapshot({});
    res.json({ ...result, sessionId: session.sessionId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * GET /api/observe?since=<ts>&screenshot=1&save=/path.png
 *
 * "Give me everything in one call" endpoint — optimized for agent
 * loops that co-drive a browser with a human. Returns:
 *   - ts:             now (epoch ms) — pass back as `since` next call
 *   - url + title:    current nav state
 *   - viewport:       {width,height}
 *   - screenshotPath: if ?screenshot=1 we write a PNG to disk and
 *                     return its filesystem path; caller Read()s it.
 *                     Defaults off. If ?save= given, writes there;
 *                     otherwise /tmp/brainbow-obs/<sessionId>-<ts>.png
 *   - consoleDelta:   console messages with ts > since
 *   - actionDelta:    action-log entries with ts > since
 *   - visibleText:    first 400 chars of document.body.innerText
 *                     (cheap way to tell "is the streaming done")
 *   - viewerUrl:      `http://<host>:<port>/?session=<id>` so you
 *                     can join the same live viewer I'm looking at
 *
 * Purpose: replace the multi-call pattern (screenshot + pageinfo +
 * console + eval) with ONE call per observation tick. Polling is
 * `curl /api/observe?since=$TS` → get the next tick in 1 roundtrip.
 */
app.get('/api/observe', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!(await requireBrowser(session, res))) return;
  try {
    const since = Number.parseInt(req.query.since || '0') || 0;
    const wantShot = req.query.screenshot === '1' || req.query.screenshot === 'true';
    const ts = Date.now();
    const [visibleText, title] = await Promise.all([
      session.page.evaluate(() => document.body?.innerText?.slice(0, 400) || '').catch(() => ''),
      session.page.title().catch(() => ''),
    ]);
    let screenshotPath = null;
    if (wantShot) {
      const dir = path.join(os.tmpdir(), 'brainbow-obs');
      fs.mkdirSync(dir, { recursive: true });
      screenshotPath = req.query.save || path.join(dir, `${session.sessionId}-${ts}.png`);
      const buf = await session.page.screenshot({ type: 'png' });
      fs.writeFileSync(screenshotPath, buf);
    }
    const protocol = req.protocol;
    const host = req.get('host');
    const viewerUrl = `${protocol}://${host}/?session=${encodeURIComponent(session.sessionId)}`;

    res.json({
      ts,
      url: session.page.url(),
      title,
      viewport: { ...session.viewport },
      visibleText,
      screenshotPath,
      consoleDelta: (session.consoleMessages || []).filter(m => (m.ts || 0) > since),
      actionDelta: (session.actionLog || []).filter(a => new Date(a.ts).getTime() > since),
      viewerUrl,
      sessionId: session.sessionId,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * GET /api/tail?after=<ts>&limit=<n>
 *
 * Event-stream tail — returns all session events (actions, console,
 * dialogs) newer than `after` (epoch ms), in chronological order.
 * Cheap polling for agents that want to react to events rather than
 * request-response screenshot loops.
 *
 * Each entry: { kind: 'action'|'console', ts, ...fields }.
 */
app.get('/api/tail', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  try {
    const after = Number.parseInt(req.query.after || '0') || 0;
    const limit = Math.min(1000, Math.max(1, Number.parseInt(req.query.limit || '500')));
    // Action timestamps are ISO strings; convert to epoch and spread
    // first so the numeric ts isn't overwritten by the string.
    const actions = (session.actionLog || [])
      .map(a => ({ ...a, kind: 'action', ts: new Date(a.ts).getTime() }))
      .filter(e => e.ts > after);
    const console = (session.consoleMessages || [])
      .map(m => ({ ...m, kind: 'console' }))
      .filter(e => e.ts > after);
    const merged = [...actions, ...console]
      .sort((a, b) => a.ts - b.ts)
      .slice(-limit);
    res.json({
      ts: Date.now(),
      count: merged.length,
      events: merged,
      sessionId: session.sessionId,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/wait-for — like /api/wait but also supports:
 *   - urlPattern: regex the current page URL must match
 *   - textGone:   text that must DISAPPEAR (inverse of `text`)
 *   - networkIdle: wait N ms with no pending requests
 * Returns { ok, matched, elapsedMs } or { ok:false, error, elapsedMs }.
 */
app.post('/api/wait-for', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!(await requireBrowser(session, res))) return;
  const started = Date.now();
  try {
    const { selector, text, textGone, urlPattern, networkIdle, timeout = 30000 } = req.body || {};
    session.log('wait-for', JSON.stringify({ selector, text, textGone, urlPattern, networkIdle }).slice(0, 200));
    if (urlPattern) {
      const re = new RegExp(urlPattern);
      await session.page.waitForFunction(
        (pattern) => new RegExp(pattern).test(location.href),
        { timeout },
        urlPattern,
      );
    } else if (textGone) {
      await session.page.waitForFunction(
        (t) => !document.body.innerText.includes(t),
        { timeout },
        textGone,
      );
    } else if (text) {
      await session.page.waitForFunction(
        (t) => document.body.innerText.includes(t),
        { timeout },
        text,
      );
    } else if (selector) {
      await session.page.waitForSelector(selector, { visible: true, timeout });
    } else if (networkIdle) {
      await session.page.waitForNetworkIdle({ idleTime: Number(networkIdle), timeout });
    } else {
      return res.status(400).json({ error: 'need one of: selector, text, textGone, urlPattern, networkIdle' });
    }
    res.json({ ok: true, matched: true, elapsedMs: Date.now() - started, sessionId: session.sessionId });
  } catch (e) {
    res.json({ ok: false, matched: false, error: e.message, elapsedMs: Date.now() - started, sessionId: session.sessionId });
  }
});

/**
 * GET /api/console — ring buffer of the last N page-side console
 * messages captured since session launch. Supports ?level=error|warn
 * filters and ?limit=N head-limit for large dumps.
 */
app.get('/api/console', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!(await requireBrowser(session, res))) return;
  try {
    const level = String(req.query.level || '').toLowerCase();
    const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit || '200')));
    let msgs = session.consoleMessages || [];
    if (level) {
      const wanted = new Set(
        level === 'error' ? ['error', 'pageerror'] :
        level === 'warn' || level === 'warning' ? ['warning', 'warn'] :
        [level]
      );
      msgs = msgs.filter((m) => wanted.has(m.type));
    }
    res.json({
      count: msgs.length,
      messages: msgs.slice(-limit),
      sessionId: session.sessionId,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Hard reload — bypass all caches
app.post('/api/reload', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!(await requireBrowser(session, res))) return;
  try {
    const { noCache = true } = req.body || {};
    session.log('reload', noCache ? 'hard (no-cache)' : 'soft');
    if (noCache && session.cdpSession) {
      await session.cdpSession.send('Network.setCacheDisabled', { cacheDisabled: true });
      await session.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      await session.cdpSession.send('Network.setCacheDisabled', { cacheDisabled: false });
    } else {
      await session.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    res.json({ ok: true, url: session.page.url(), title: await session.page.title(), sessionId: session.sessionId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/click', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!(await requireBrowser(session, res))) return;
  try {
    const { selector, text, x, y, button = 'left', timeout = 10000 } = req.body;
    if (x !== undefined && y !== undefined) {
      session.log('click', `(${x}, ${y})`);
      await session.page.mouse.click(x, y, { button });
    } else if (text) {
      session.log('click', `text="${text}"`);
      await clickByText(session, text);
    } else if (selector) {
      session.log('click', selector);
      await session.page.waitForSelector(selector, { timeout });
      await session.page.click(selector);
    } else {
      return res.status(400).json({ error: 'Provide selector, text, or x/y coordinates' });
    }
    await new Promise(r => setTimeout(r, 200));
    res.json({ ok: true, sessionId: session.sessionId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/type', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!(await requireBrowser(session, res))) return;
  try {
    const {
      selector,
      text,
      value,
      delay = 0,
      clear = false,
      // When submit is true, press Enter after typing. Used to get
      // past gates like MS login where the "Next" button is a form
      // submit. We delay 150ms between last keystroke and Enter so
      // React/Angular forms have time to commit the input's value to
      // their internal state — Microsoft's login in particular
      // validates the framework-held value, not the DOM value, and
      // races otherwise. Caller can override with submitDelayMs.
      submit = false,
      submitDelayMs = 150,
      // For frameworks that only react to programmatic input events
      // (React tracks input-value with a proxy); dispatch a synthetic
      // 'input' + 'change' + 'blur' after page.type so onChange fires.
      dispatchEvents = true,
    } = req.body;
    const content = value || text;
    let isPasswordField = selector && /password|passwd|secret|token|api[_-]?key|credential/i.test(selector);
    if (!isPasswordField && selector) {
      try {
        isPasswordField = await session.page.$eval(selector, el => el.type === 'password' || el.autocomplete === 'current-password' || el.autocomplete === 'new-password');
      } catch {}
    }
    const safeContent = isPasswordField ? '******' : content?.substring(0, 50);
    const safeSelector = selector ? redactSecrets(selector) : '';
    if (selector) {
      session.log('type', `${safeSelector} = "${safeContent}"${submit ? ' [submit]' : ''}`);
      if (clear) {
        await session.page.click(selector, { clickCount: 3 });
        await session.page.keyboard.press('Backspace');
      }
      await session.page.type(selector, content, { delay });
      if (dispatchEvents) {
        // Force React/Angular/Vue form state sync. page.type fires real
        // keydown/keypress/input/keyup events per char, which React sees
        // via its synthetic event system — but only if the component
        // subscribed to the native input event. Belt + suspenders: also
        // dispatch a programmatic input event that mirrors the DOM
        // value, plus a blur to trigger any on-blur validators.
        try {
          await session.page.$eval(selector, (el) => {
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          });
        } catch { /* selector might have scrolled; non-fatal */ }
      }
    } else {
      session.log('type', `keyboard: "${safeContent}"${submit ? ' [submit]' : ''}`);
      await session.page.keyboard.type(content, { delay });
    }
    if (submit) {
      await new Promise(r => setTimeout(r, submitDelayMs));
      await session.page.keyboard.press('Enter');
    }
    res.json({ ok: true, sessionId: session.sessionId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// /api/key and its alias /api/keyboard — older clients used
// /api/keyboard which didn't exist and returned a 404 HTML page that
// looked like success to JSON-parsers. Accept both names now so no
// caller silently misses keypresses.
const handleKey = async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!(await requireBrowser(session, res))) return;
  try {
    const { key } = req.body;
    session.log('key', key);
    await session.page.keyboard.press(key);
    await new Promise(r => setTimeout(r, 100));
    res.json({ ok: true, sessionId: session.sessionId });
  } catch (e) { res.status(500).json({ error: e.message }); }
};
app.post('/api/key', handleKey);
app.post('/api/keyboard', handleKey);

app.post('/api/scroll', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!(await requireBrowser(session, res))) return;
  try {
    const { x = 0, y = 300, selector } = req.body;
    session.log('scroll', `dy=${y}`);
    if (selector) {
      await session.page.$eval(selector, (el, dy) => el.scrollBy(0, dy), y);
    } else {
      await session.page.mouse.wheel({ deltaX: x, deltaY: y });
    }
    res.json({ ok: true, sessionId: session.sessionId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/eval', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!(await requireBrowser(session, res))) return;
  const code = req.body.script || req.body.expression;
  if (typeof code !== 'string' || !code.trim()) {
    return res.status(400).json({ ok: false, error: 'eval requires a non-empty `script` string' });
  }
  session.log('eval', code.substring(0, 100));

  // Wrap in an ASYNC IIFE so scripts can use top-level `await` (fetch, waits,
  // async DOM probes) AND a top-level `return`. The prior wrapper was a plain
  // `(() => { ... })()` arrow — any `await` was a SyntaxError, which silently
  // fell through to a broken fallback that returned `undefined` (so the caller
  // got `{ok:true}` with no `result`). Puppeteer awaits a returned Promise, so
  // the async IIFE's resolved value is what we serialize back.
  const wrappedAsync = `(async () => { ${code} })()`;
  // Fallback: treat the script as a bare expression (`document.title`, `2+2`)
  // with no `return` — wrap it as an async expression body.
  const wrappedExpr = `(async () => (${code}))()`;

  const tryEval = async (src) => session.page.evaluate(src);

  try {
    const result = await tryEval(wrappedAsync);
    return res.json({ ok: true, result: result === undefined ? null : result, sessionId: session.sessionId });
  } catch (e1) {
    // statement-body compile failed (e.g. it was a bare expression) — retry as expression
    try {
      const result = await tryEval(wrappedExpr);
      return res.json({ ok: true, result: result === undefined ? null : result, sessionId: session.sessionId });
    } catch (e2) {
      if (res.headersSent) return;
      return res.status(500).json({
        ok: false,
        error: e1.message,
        error_expr: e2.message,
        hint: 'Script runs in an async function: use `await` freely and `return <value>` at the end (or pass a single bare expression).',
      });
    }
  }
});

app.get('/api/pageinfo', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!(await requireBrowser(session, res))) return;
  try {
    const text = await session.page.evaluate(() => document.body.innerText.substring(0, 2000));
    const url = session.page.url();
    const title = await session.page.title();
    res.json({ url, title, text, sessionId: session.sessionId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/wait', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!(await requireBrowser(session, res))) return;
  try {
    const { selector, text, timeout = 15000 } = req.body;
    session.log('wait', selector || `text="${text}"`);
    if (text) {
      await session.page.waitForFunction(
        (t) => document.body.innerText.includes(t),
        { timeout },
        text
      );
    } else {
      await session.page.waitForSelector(selector, { visible: true, timeout });
    }
    res.json({ ok: true, found: true, sessionId: session.sessionId });
  } catch (e) { res.json({ ok: false, found: false, error: e.message }); }
});

app.get('/api/page', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!(await requireBrowser(session, res))) return;
  try {
    res.json({ url: session.page.url(), title: await session.page.title(), viewport: session.page.viewport(), sessionId: session.sessionId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function captureAndCompress(page, { format, quality, fullPage, maxBytes }) {
  if (format === 'png') return page.screenshot({ type: 'png', fullPage });
  let buf = await page.screenshot({ type: 'jpeg', quality: Math.min(quality, 100), fullPage });
  if (buf.length > maxBytes) {
    buf = await page.screenshot({ type: 'jpeg', quality: Math.max(25, quality - 30), fullPage });
  }
  if (buf.length > maxBytes) {
    buf = await page.screenshot({ type: 'jpeg', quality: 15, fullPage });
  }
  return buf;
}

function downscaleWithFFmpeg(buf, maxWidth) {
  const ts = Date.now();
  const tmpIn = path.join(os.tmpdir(), `ghost_in_${ts}.jpg`);
  const tmpOut = path.join(os.tmpdir(), `ghost_out_${ts}.jpg`);
  fs.writeFileSync(tmpIn, buf);
  const wRaw = Number.isFinite(maxWidth) ? Math.floor(maxWidth) : 0;
  const w = wRaw > 0 && wRaw <= 4096 ? wRaw : 1024;
  try {
    // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process
    // — execFileSync with a fixed binary + argv array: no shell, no interpolation.
    //   `w` is a clamped integer; tmpIn/tmpOut are server-generated paths.
    execFileSync(
      'ffmpeg',
      ['-y', '-i', tmpIn, '-vf', `scale=${w}:-1`, '-q:v', '6', tmpOut],
      { stdio: 'ignore' },
    );
    return fs.readFileSync(tmpOut);
  } finally {
    try { fs.unlinkSync(tmpIn); } catch { /* best-effort */ }
    try { fs.unlinkSync(tmpOut); } catch { /* best-effort */ }
  }
}

app.get('/api/screenshot', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!(await requireBrowser(session, res))) return;
  try {
    const fullPage = req.query.full === 'true';
    const format = req.query.format || 'jpeg';
    const quality = Number.parseInt(req.query.quality || '70');
    const maxWidth = Number.parseInt(req.query.maxWidth || '0');
    const maxBytes = Number.parseInt(req.query.maxBytes || '300000');

    let buf = await captureAndCompress(session.page, { format, quality, fullPage, maxBytes });

    const shouldDownscale = format !== 'png' && (buf.length > maxBytes || maxWidth > 0);
    if (shouldDownscale && hasFFmpeg) {
      try { buf = downscaleWithFFmpeg(buf, maxWidth); } catch { /* fallback to original */ }
    }

    res.set('Content-Type', format === 'png' ? 'image/png' : 'image/jpeg');
    // `buf` is an image Buffer, not user-supplied string content; Content-Type above prevents HTML sniffing.
    res.send(buf); // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/frame', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!(await requireBrowser(session, res))) return;
  try {
    let b64 = session.lastFrameB64;
    if (!b64) {
      const buf = await session.page.screenshot({ type: 'jpeg', quality: 60 });
      b64 = buf.toString('base64');
    }
    res.json({
      ok: true,
      frame: b64,
      width: session.viewport.width,
      height: session.viewport.height,
      timestamp: Date.now(),
      source: session.lastFrameB64 ? 'screencast' : 'screenshot',
      sessionId: session.sessionId,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/text', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!(await requireBrowser(session, res))) return;
  try {
    const { selector } = req.body;
    const text = await session.page.$eval(selector, el => el.textContent);
    res.json({ text, sessionId: session.sessionId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/select', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!(await requireBrowser(session, res))) return;
  try {
    const { selector, value, label } = req.body;
    session.log('select', `${selector} = ${value || label}`);
    await session.page.select(selector, value || label);
    res.json({ ok: true, sessionId: session.sessionId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/upload', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!(await requireBrowser(session, res))) return;
  try {
    const { selector, filePath } = req.body;
    session.log('upload', filePath);
    const input = await session.page.$(selector);
    await input.uploadFile(filePath);
    res.json({ ok: true, sessionId: session.sessionId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/dialog', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!(await requireBrowser(session, res))) return;
  try {
    const { action = 'accept', text } = req.body;
    session.page.once('dialog', async (dialog) => {
      if (action === 'accept') await dialog.accept(text);
      else await dialog.dismiss();
    });
    res.json({ ok: true, waiting: true, sessionId: session.sessionId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/log', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  const n = Number.parseInt(req.query.n) || 50;
  res.json({ log: session.actionLog.slice(-n), sessionId: session.sessionId });
});

app.post('/api/find', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!(await requireBrowser(session, res))) return;
  try {
    // Forgiveness: accept `query`/`q` as aliases for `text` (callers reach for
    // a generic "query" param). Guard against BOTH missing — the old code fell
    // straight into `$$eval(undefined)`, which threw the opaque
    // "Cannot read properties of undefined (reading 'startsWith')" 500.
    const selector = req.body.selector;
    const text = req.body.text || req.body.query || req.body.q;
    if (!selector && !text) {
      return res.status(400).json({
        ok: false,
        error: 'find requires `selector` (a CSS selector) or `text` (visible text to match)',
        sessionId: session.sessionId,
      });
    }
    if (text) {
      const results = await session.page.evaluate((searchText) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const matches = [];
        let node = walker.nextNode();
        while (node && matches.length < 20) {
          if (node.textContent.includes(searchText)) {
            const el = node.parentElement;
            const rect = el.getBoundingClientRect();
            matches.push({
              text: el.textContent.substring(0, 200),
              box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              tag: el.tagName.toLowerCase(),
            });
          }
          node = walker.nextNode();
        }
        return matches;
      }, text);
      res.json({ count: results.length, elements: results, sessionId: session.sessionId });
    } else {
      const results = await session.page.$$eval(selector, (els) =>
        els.slice(0, 20).map((el, i) => ({
          index: i,
          text: el.textContent?.substring(0, 200),
          box: (() => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })(),
          tag: el.tagName.toLowerCase(),
        }))
      );
      res.json({ count: results.length, elements: results, sessionId: session.sessionId });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Recording API ───────────────────────────────────────────────────────────

app.post('/api/record/start', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  const { zoom } = req.body || {};
  if (session.recording) return res.status(400).json({ error: 'Already recording' });

  session.recording = true;
  session.recordFrames = [];
  session.recordStartTime = Date.now();
  session.recordZoom = zoom || null;

  const zoomLabel = session.recordZoom ? `zoom=${JSON.stringify(session.recordZoom)}` : 'full viewport';
  session.log('record-start', zoomLabel);
  session.broadcast({ type: 'recording', state: 'started' });
  res.json({ ok: true, recording: true, sessionId: session.sessionId });
});

app.post('/api/record/zoom', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  const { x, y, width, height, reset } = req.body || {};
  if (reset) {
    session.recordZoom = null;
    session.log('record-zoom', 'reset to full viewport');
  } else {
    session.recordZoom = { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
    session.log('record-zoom', `${session.recordZoom.x},${session.recordZoom.y} ${session.recordZoom.width}x${session.recordZoom.height}`);
  }
  session.broadcast({ type: 'recording', state: 'zoom', zoom: session.recordZoom });
  res.json({ ok: true, zoom: session.recordZoom, sessionId: session.sessionId });
});

app.post('/api/record/stop', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!session.recording) return res.status(400).json({ error: 'Not recording' });

  const { format = 'gif', quality = 'high', speed = 1, filename } = req.body || {};
  // Snapshot frames WITHOUT discarding the live buffer yet. Bug fix
  // (2026-06-16): the buffer used to be cleared + `recording` flipped false
  // BEFORE encode, so an encode failure (e.g. a bad filename) lost all frames
  // and any retry hit the `!session.recording` guard with a 400. We now keep
  // the recording session intact across encode and only release it on SUCCESS,
  // so a failed encode can be retried against the same frames.
  const frames = [...session.recordFrames];
  const zoom = session.recordZoom;

  session.broadcast({ type: 'recording', state: 'encoding', format, frameCount: frames.length });
  session.log('record-stop', `${frames.length} frames → ${format}`);

  if (frames.length === 0) {
    session.recording = false;
    session.recordFrames = [];
    return res.json({ ok: false, error: 'No frames captured', sessionId: session.sessionId });
  }

  try {
    const result = await encodeRecording(frames, { format, quality, speed, zoom, filename });
    // Encode succeeded — now it is safe to release the recording session.
    session.recording = false;
    session.recordFrames = [];
    session.recordZoom = null;
    session.broadcast({ type: 'recording', state: 'done', file: result.file, size: result.sizeHuman });
    res.json({ ok: true, ...result, sessionId: session.sessionId });
  } catch (e) {
    // Keep `session.recording` true + the frame buffer intact so the caller can
    // retry record_stop (e.g. with a corrected filename/format) without losing
    // the captured frames.
    session.broadcast({ type: 'recording', state: 'error', error: e.message });
    session.log('record-stop-error', `${e.message} — frames retained (${frames.length}), retry record_stop`);
    res.status(500).json({ error: `Encoding failed: ${e.message}`, retryable: true, framesRetained: frames.length, sessionId: session.sessionId });
  }
});

app.get('/api/record/status', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  res.json({
    recording: session.recording,
    frames: session.recordFrames.length,
    duration: session.recording ? Date.now() - session.recordStartTime : 0,
    zoom: session.recordZoom,
    ffmpeg: hasFFmpeg,
    sessionId: session.sessionId,
  });
});

app.get('/api/recordings', (req, res) => {
  try {
    const files = fs.readdirSync(RECORDINGS_DIR)
      .filter(f => /\.(gif|mp4|webm|png|jpg)$/.test(f))
      .map(f => {
        const stat = fs.statSync(path.join(RECORDINGS_DIR, f));
        return { name: f, size: stat.size, sizeHuman: humanSize(stat.size), created: stat.mtime };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created));
    res.json({ recordings: files, dir: RECORDINGS_DIR });
  } catch (e) { res.json({ recordings: [], error: e.message }); }
});

app.get('/api/recordings/:name', (req, res) => {
  const safeName = path.basename(req.params.name);
  if (!/^[A-Za-z0-9._-]+$/.test(safeName)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const recordingsRoot = path.resolve(RECORDINGS_DIR);
  // safeName already basename-stripped + charset-allowlisted above.
  const filePath = path.resolve(recordingsRoot, safeName); // nosemgrep: javascript.express.security.audit.express-path-join-resolve-traversal.express-path-join-resolve-traversal
  if (!filePath.startsWith(recordingsRoot + path.sep)) {
    return res.status(400).json({ error: 'Path traversal' });
  }
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(filePath); // nosemgrep: javascript.express.security.audit.express-res-sendfile.express-res-sendfile
});

// ─── Scripts Engine (repeatable macros) ─────────────────────────────────────
const SCRIPTS_DIR = process.env.BRAINBOW_SCRIPTS
  || process.env.GHOST_SCRIPTS
  || path.join(__dirname, 'scripts');
if (process.env.GHOST_SCRIPTS && !process.env.BRAINBOW_SCRIPTS) {
  console.warn('[Brainbow] GHOST_SCRIPTS is deprecated — use BRAINBOW_SCRIPTS.');
}
try { fs.mkdirSync(SCRIPTS_DIR, { recursive: true }); } catch {}

app.get('/api/scripts', (req, res) => {
  try {
    const files = fs.readdirSync(SCRIPTS_DIR).filter(f => f.endsWith('.json'));
    const scripts = files.map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(SCRIPTS_DIR, f), 'utf8'));
        return { name: data.name || f.replaceAll('.json', ''), file: f, steps: (data.steps || []).length, description: data.description || '' };
      } catch { return { name: f, file: f, steps: 0 }; }
    });
    res.json({ scripts });
  } catch (e) { res.json({ scripts: [], error: e.message }); }
});

app.post('/api/scripts', (req, res) => {
  const { name, description, steps } = req.body;
  if (!name || !steps) return res.status(400).json({ error: 'name and steps required' });
  const filename = name.replaceAll(/[^a-zA-Z0-9_-]/g, '_') + '.json';
  fs.writeFileSync(path.join(SCRIPTS_DIR, filename), JSON.stringify({ name, description, steps }, null, 2));
  res.json({ ok: true, file: filename });
});

app.post('/api/scripts/:name/run', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;

  const rawName = path.basename(req.params.name);
  if (!/^[A-Za-z0-9._-]+$/.test(rawName)) {
    return res.status(400).json({ error: 'Invalid script name' });
  }
  const filename = rawName.endsWith('.json') ? rawName : rawName + '.json';
  const scriptsRoot = path.resolve(SCRIPTS_DIR);
  const filepath = path.resolve(scriptsRoot, filename); // nosemgrep: javascript.express.security.audit.express-path-join-resolve-traversal.express-path-join-resolve-traversal
  if (!filepath.startsWith(scriptsRoot + path.sep)) {
    return res.status(400).json({ error: 'Path traversal' });
  }
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Script not found' });

  const script = JSON.parse(fs.readFileSync(filepath, 'utf8'));
  session.log('script-run', `${script.name} (${script.steps.length} steps)`);

  // If the first step isn't 'goto' and no browser is open yet, bail early
  // with a clear message — otherwise each browser-touching step fails with
  // a null-dereference that gets returned as an opaque per-step error.
  const firstStep = script.steps[0];
  const scriptNeedsExistingBrowser = firstStep?.action !== 'goto';
  if (scriptNeedsExistingBrowser && !session.page) {
    return res.status(400).json({
      error: 'No browser open. POST /api/launch first, or start the script with a goto step.',
      sessionId: session.sessionId,
    });
  }

  const results = [];
  for (const step of script.steps) {
    try {
      const { action, ...params } = step;
      let result;

      if (action === 'goto') {
        if (session.page) await session.page.goto(params.url, { waitUntil: params.waitUntil || 'domcontentloaded', timeout: 30000 });
        else await session.launch({ url: params.url });
        result = { ok: true };
      } else if (action === 'click') {
        if (params.text) await clickByText(session, params.text);
        else if (params.selector) { await session.page.waitForSelector(params.selector, { timeout: params.timeout || 10000 }); await session.page.click(params.selector); }
        else if (params.x !== undefined) await session.page.mouse.click(params.x, params.y);
        result = { ok: true };
      } else if (action === 'type') {
        if (params.selector) await session.page.type(params.selector, params.value || params.text, { delay: params.delay || 0 });
        else await session.page.keyboard.type(params.value || params.text, { delay: params.delay || 0 });
        result = { ok: true };
      } else if (action === 'key') {
        await session.page.keyboard.press(params.key);
        result = { ok: true };
      } else if (action === 'wait') {
        if (params.ms) await new Promise(r => setTimeout(r, params.ms));
        else if (params.selector) await session.page.waitForSelector(params.selector, { visible: true, timeout: params.timeout || 15000 });
        else if (params.text) await session.page.waitForFunction((t) => document.body.innerText.includes(t), { timeout: params.timeout || 15000 }, params.text);
        result = { ok: true };
      } else if (action === 'hitl') {
        result = await requestHumanInput(session, params.prompt || 'Input needed', params.type || 'text', params.timeout || 120000);
      } else if (action === 'fill_hitl') {
        if (session.lastHitlResponse && params.selector) {
          await session.page.type(params.selector, session.lastHitlResponse, { delay: params.delay || 0 });
          result = { ok: true, filled: true };
        } else {
          result = { ok: false, error: 'No HITL response available' };
        }
      } else {
        result = { ok: false, error: `Unknown action: ${action}` };
      }

      session.log('script-step', `${action}: ok`);
      results.push({ action, ...result });
    } catch (e) {
      session.log('script-step', `${step.action}: FAIL ${e.message}`);
      results.push({ action: step.action, ok: false, error: e.message });
      if (step.required !== false) break;
    }

    await new Promise(r => setTimeout(r, step.delay || 300));
  }

  res.json({ ok: true, results, stepsRun: results.length, totalSteps: script.steps.length, sessionId: session.sessionId });
});

// ─── Human-in-the-Loop (HITL) ────────────────────────────────────────────────

app.post('/api/hitl/respond', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  const { value, id } = req.body;
  if (!session.hitlPending) return res.status(400).json({ error: 'No pending HITL request' });
  if (id && session.hitlPending.id !== id) return res.status(400).json({ error: 'HITL request ID mismatch' });

  session.lastHitlResponse = value;
  session.hitlPending.resolve({ ok: true, value });
  session.hitlPending = null;

  session.broadcast({ type: 'hitl_resolved', id });
  session.log('hitl', 'User responded');
  res.json({ ok: true, sessionId: session.sessionId });
});

app.post('/api/hitl/cancel', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!session.hitlPending) return res.json({ ok: true, message: 'Nothing pending', sessionId: session.sessionId });
  session.hitlPending.reject(new Error('HITL cancelled by user'));
  session.hitlPending = null;
  session.broadcast({ type: 'hitl_cancelled' });
  res.json({ ok: true, sessionId: session.sessionId });
});

app.get('/api/hitl/status', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  res.json({
    pending: !!session.hitlPending,
    prompt: session.hitlPending?.prompt,
    type: session.hitlPending?.type,
    id: session.hitlPending?.id,
    sessionId: session.sessionId,
  });
});

// ─── Vision (per-session, uses process-wide Ollama) ──────────────────────────

app.post('/api/vision/describe', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  const { prompt } = req.body || {};
  const description = await describeScreen(session, prompt);
  res.json({
    description,
    timestamp: Date.now(),
    model: VISION_MODEL,
    error: session.visionError,
    sessionId: session.sessionId,
  });
});

app.get('/api/vision/status', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  res.json({
    description: session.visionDescription,
    timestamp: session.visionTimestamp,
    age: session.visionTimestamp ? Date.now() - session.visionTimestamp : -1,
    watching: session.visionWatching,
    model: VISION_MODEL,
    modelReady: visionModelReady,
    error: session.visionError,
    sessionId: session.sessionId,
  });
});

app.post('/api/vision/watch', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  const { interval = VISION_INTERVAL, prompt } = req.body || {};

  if (session.visionWatching) {
    clearInterval(session.visionInterval);
  }

  session.visionWatching = true;
  session.log('vision-watch', `started (every ${interval}ms)`);

  await describeScreen(session, prompt);

  session.visionInterval = setInterval(async () => {
    if (!session.lastFrameB64) return;
    await describeScreen(session, prompt);
    session.broadcast({
      type: 'vision',
      description: session.visionDescription,
      timestamp: session.visionTimestamp,
    });
  }, interval);

  res.json({
    ok: true,
    watching: true,
    interval,
    description: session.visionDescription,
    sessionId: session.sessionId,
  });
});

app.post('/api/vision/stop', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (session.visionInterval) {
    clearInterval(session.visionInterval);
    session.visionInterval = null;
  }
  session.visionWatching = false;
  session.log('vision-watch', 'stopped');
  res.json({ ok: true, watching: false, sessionId: session.sessionId });
});

app.get('/api/screen', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!(await requireBrowser(session, res))) return;
  try {
    const [text, title, url] = await Promise.all([
      session.page.evaluate(() => document.body.innerText.substring(0, 8000)),
      session.page.title(),
      Promise.resolve(session.page.url()),
    ]);
    res.json({
      url, title, text,
      vision: session.visionDescription,
      visionAge: session.visionTimestamp ? `${((Date.now() - session.visionTimestamp) / 1000).toFixed(1)}s ago` : 'none',
      sessionId: session.sessionId,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/vision/full', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!(await requireBrowser(session, res))) return;
  try {
    const [pageText, title, url] = await Promise.all([
      session.page.evaluate(() => document.body.innerText.substring(0, 5000)),
      session.page.title(),
      Promise.resolve(session.page.url()),
    ]);

    let description = session.visionDescription;
    if (!description || Date.now() - session.visionTimestamp > 5000) {
      description = await describeScreen(session);
    }

    res.json({
      url,
      title,
      pageText: pageText.substring(0, 3000),
      visionDescription: description,
      visionAge: session.visionTimestamp ? Date.now() - session.visionTimestamp : -1,
      sessionId: session.sessionId,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Helper: find element by text ────────────────────────────────────────────
async function clickByText(session, text) {
  const clicked = await session.page.evaluate((searchText) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (node.textContent.includes(searchText)) {
        const el = node.parentElement;
        if (el) { el.click(); return true; }
      }
      node = walker.nextNode();
    }
    return false;
  }, text);
  if (!clicked) throw new Error(`Text "${text}" not found on page`);
}

// ─── Static UI ───────────────────────────────────────────────────────────────
// Brand icon — cropped brain+rainbow PNG.
app.get('/brainbow-icon.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'brainbow-icon.png'));
});
app.get('/brainbow-icon-64.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'brainbow-icon-64.png'));
});
app.get('/brainbow.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'brainbow.png'));
});
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'ui.html'));
});

// ─── WebSocket Handling ──────────────────────────────────────────────────────
// Manual upgrade handler so we can parse sessionId from /ws/:sessionId.
// noServer: true means the ws library does NOT auto-attach, so this is the
// only upgrade handler — no race condition.
const WS_PATH_RE = /^\/ws(?:\/([^/?#]+))?/;
server.on('upgrade', (request, socket, head) => {
  const match = WS_PATH_RE.exec(request.url ?? '');
  if (!match) {
    socket.destroy();
    return;
  }
  const sessionId = decodeURIComponent(match[1] || 'default');
  wss.handleUpgrade(request, socket, head, async (ws) => {
    let session;
    try {
      session = await sessionManager.get(sessionId);
    } catch (e) {
      ws.close(1008, JSON.stringify({ error: e.message, code: e.code }));
      return;
    }
    session.subscribe(ws);
    // CRITICAL: a ws socket that emits 'error' with NO listener is re-thrown
    // by the ws library as an uncaught exception → process exit. A viewer
    // tab closing mid-frame, a network blip, or a 1006 abnormal close all
    // emit 'error'. Listen + swallow so a dropped viewer can never take the
    // shared REST server (and thus every Claude's brainbow tools) down.
    ws.on('error', (err) => {
      console.error(`[Brainbow:${sessionId}] viewer ws error (ignored):`, err?.message || err);
    });
    try {
      if (session.lastFrameB64) ws.send(JSON.stringify({ type: 'frame', data: session.lastFrameB64 }));
      ws.send(JSON.stringify({ type: 'log', entries: session.actionLog.slice(-20), sessionId }));
      ws.send(JSON.stringify({ type: 'recording', state: session.recording ? 'started' : 'stopped' }));
    } catch (e) {
      // Socket may have closed between accept and first send.
      console.error(`[Brainbow:${sessionId}] initial ws send failed (ignored):`, e?.message || e);
    }

    ws.on('close', () => session.unsubscribe(ws));

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (!session.page) return;
        if (msg.type === 'click') { await session.page.mouse.click(msg.x, msg.y); session.log('human-click', `(${msg.x}, ${msg.y})`); }
        else if (msg.type === 'mousemove') { await session.page.mouse.move(msg.x, msg.y); }
        else if (msg.type === 'type') { await session.page.keyboard.type(msg.text); session.log('human-type', msg.text?.substring(0, 50)); }
        else if (msg.type === 'key') { await session.page.keyboard.press(msg.key); session.log('human-key', msg.key); }
        else if (msg.type === 'scroll') { await session.page.mouse.wheel({ deltaX: 0, deltaY: msg.dy || 300 }); }
        else if (msg.type === 'mousedown') { await session.page.mouse.down(); }
        else if (msg.type === 'mouseup') { await session.page.mouse.up(); }
      } catch {}
    });
  });
});

// ─── Live observation routes (Bedrock Sonnet narrator + log tails + /api/live)
registerLiveRoutes(app, { sessionManager, getSession });

// ─── Start ───────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  checkVisionModel();
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║             B R A I N B O W                               ║
║   Shared Browser + Recording Studio                       ║
╠═══════════════════════════════════════════════════════════╣
║                                                           ║
║   Viewer:     http://localhost:${String(PORT).padEnd(5)}                      ║
║   API:        http://localhost:${String(PORT).padEnd(5)}/api/*                ║
║   Recordings: ${RECORDINGS_DIR.substring(0, 43).padEnd(43)}║
║                                                           ║
║   Engine:     puppeteer-core + system Chromium (no PW)    ║
║   ffmpeg:     ${hasFFmpeg ? 'YES — GIF/MP4/WebM encoding ready' : 'NO  — install for video encoding'}${''.padEnd(hasFFmpeg ? 5 : 6)}║
║   Mode:       ${MODE.padEnd(44)}║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
`);
});
