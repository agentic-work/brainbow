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
import { createServer } from 'http';
import { spawn, execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { redactSecrets } from './src/redaction.js';
import { Session } from './src/session.js';
import { SessionManager } from './src/session-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.BRAINBOW_PORT || process.env.GHOST_PORT || '4444');
const RECORDINGS_DIR = process.env.BRAINBOW_RECORDINGS
  || process.env.GHOST_RECORDINGS
  || path.join(os.tmpdir(), 'brainbow-recordings');
if (process.env.GHOST_RECORDINGS && !process.env.BRAINBOW_RECORDINGS) {
  console.warn('[Brainbow] GHOST_RECORDINGS is deprecated — use BRAINBOW_RECORDINGS.');
}

fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

// Check ffmpeg availability
let hasFFmpeg = false;
try { execSync('ffmpeg -version', { stdio: 'ignore' }); hasFFmpeg = true; } catch {}

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

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

// ─── SessionManager ─────────────────────────────────────────────────────────
const MODE = process.env.BRAINBOW_MODE || 'local';
const sessionManager = new SessionManager({ SessionClass: Session, mode: MODE });

function sessionIdOf(req) {
  return req.query.sessionId
      || req.headers['x-brainbow-session']
      || (req.body && req.body.sessionId)
      || 'default';
}

async function getSession(req, res) {
  try {
    return await sessionManager.get(sessionIdOf(req));
  } catch (e) {
    res.status(404).json({ error: e.message, code: e.code });
    return null;
  }
}

function requireBrowser(session, res) {
  if (!session.page) {
    res.status(400).json({ error: 'No browser open. POST /api/launch first.' });
    return false;
  }
  return true;
}

// ─── Vision config (process-wide) ───────────────────────────────────────────
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const VISION_MODEL = process.env.VISION_MODEL || 'moondream';
const VISION_INTERVAL = parseInt(process.env.VISION_INTERVAL || '2000');

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
async function describeScreen(session, prompt) {
  if (!session.lastFrameB64) return 'No browser frame available';

  const userPrompt = prompt || 'Describe what you see on this screen. Focus on: what app/page is shown, any error messages, loading states, data displayed, buttons/controls visible. Be concise but thorough.';

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
      if (session.hitlPending && session.hitlPending.id === id) {
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

async function encodeRecording(frames, opts = {}) {
  const { format = 'gif', quality = 'high', speed = 1.0, zoom, filename } = opts;
  const ts = Date.now();
  const outName = filename || `ghost-${ts}.${format}`;
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
    const framesDir = path.join(RECORDINGS_DIR, `ghost-${ts}-frames`);
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
      const scale = quality === 'high' ? 800 : quality === 'medium' ? 540 : 360;
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
  const sid = sessionIdOf(req);
  res.json({ sessionId: sid, mode: MODE });
});

app.get('/api/sessions', (req, res) => {
  res.json({ sessions: sessionManager.list(), mode: MODE });
});

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

app.post('/api/goto', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!requireBrowser(session, res)) return;
  try {
    const { url, waitUntil = 'domcontentloaded' } = req.body;
    session.log('goto', url);
    await session.page.goto(url, { waitUntil, timeout: 30000 });
    res.json({ ok: true, url: session.page.url(), title: await session.page.title(), sessionId: session.sessionId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Hard reload — bypass all caches
app.post('/api/reload', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!requireBrowser(session, res)) return;
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
  if (!requireBrowser(session, res)) return;
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
  if (!requireBrowser(session, res)) return;
  try {
    const { selector, text, value, delay = 0, clear = false } = req.body;
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
      session.log('type', `${safeSelector} = "${safeContent}"`);
      if (clear) {
        await session.page.click(selector, { clickCount: 3 });
        await session.page.keyboard.press('Backspace');
      }
      await session.page.type(selector, content, { delay });
    } else {
      session.log('type', `keyboard: "${safeContent}"`);
      await session.page.keyboard.type(content, { delay });
    }
    res.json({ ok: true, sessionId: session.sessionId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/key', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!requireBrowser(session, res)) return;
  try {
    const { key } = req.body;
    session.log('key', key);
    await session.page.keyboard.press(key);
    await new Promise(r => setTimeout(r, 100));
    res.json({ ok: true, sessionId: session.sessionId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/scroll', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!requireBrowser(session, res)) return;
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
  if (!requireBrowser(session, res)) return;
  try {
    const { script, expression } = req.body;
    const code = script || expression;
    session.log('eval', code?.substring(0, 100));
    const wrappedCode = `(() => { ${code} })()`;
    const result = await session.page.evaluate(wrappedCode);
    res.json({ ok: true, result, sessionId: session.sessionId });
  } catch (e) {
    if (res.headersSent) return;
    try {
      const raw = req.body.script || req.body.expression;
      const result = await session.page.evaluate(raw);
      res.json({ ok: true, result, sessionId: session.sessionId });
    } catch (e2) {
      if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
    }
  }
});

app.get('/api/pageinfo', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!requireBrowser(session, res)) return;
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
  if (!requireBrowser(session, res)) return;
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
  if (!requireBrowser(session, res)) return;
  try {
    res.json({ url: session.page.url(), title: await session.page.title(), viewport: session.page.viewport(), sessionId: session.sessionId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/screenshot', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!requireBrowser(session, res)) return;
  try {
    const fullPage = req.query.full === 'true';
    const format = req.query.format || 'jpeg';
    const quality = parseInt(req.query.quality || '70');
    const maxWidth = parseInt(req.query.maxWidth || '0');

    let buf;
    if (format === 'png') {
      buf = await session.page.screenshot({ type: 'png', fullPage });
    } else {
      buf = await session.page.screenshot({ type: 'jpeg', quality: Math.min(quality, 100), fullPage });
    }

    const MAX_BYTES = parseInt(req.query.maxBytes || '300000');
    if (buf.length > MAX_BYTES && format !== 'png') {
      buf = await session.page.screenshot({ type: 'jpeg', quality: Math.max(25, quality - 30), fullPage });
    }
    if (buf.length > MAX_BYTES && format !== 'png') {
      buf = await session.page.screenshot({ type: 'jpeg', quality: 15, fullPage });
    }
    if ((buf.length > MAX_BYTES || maxWidth > 0) && hasFFmpeg) {
      try {
        const ts = Date.now();
        const tmpIn = path.join(os.tmpdir(), `ghost_in_${ts}.jpg`);
        const tmpOut = path.join(os.tmpdir(), `ghost_out_${ts}.jpg`);
        fs.writeFileSync(tmpIn, buf);
        const wRaw = Number.isFinite(maxWidth) ? Math.floor(maxWidth) : 0;
        const w = wRaw > 0 && wRaw <= 4096 ? wRaw : 1024;
        // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process
        // — execFileSync with a fixed binary + argv array: no shell, no interpolation.
        //   `w` is a clamped integer; tmpIn/tmpOut are server-generated paths.
        execFileSync(
          'ffmpeg',
          ['-y', '-i', tmpIn, '-vf', `scale=${w}:-1`, '-q:v', '6', tmpOut],
          { stdio: 'ignore' },
        );
        buf = fs.readFileSync(tmpOut);
        fs.unlinkSync(tmpIn);
        fs.unlinkSync(tmpOut);
      } catch { /* fallback to original buf */ }
    }

    res.set('Content-Type', format === 'png' ? 'image/png' : 'image/jpeg');
    // `buf` is an image Buffer, not user-supplied string content; Content-Type above prevents HTML sniffing.
    res.send(buf); // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/frame', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!requireBrowser(session, res)) return;
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
  if (!requireBrowser(session, res)) return;
  try {
    const { selector } = req.body;
    const text = await session.page.$eval(selector, el => el.textContent);
    res.json({ text, sessionId: session.sessionId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/select', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!requireBrowser(session, res)) return;
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
  if (!requireBrowser(session, res)) return;
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
  if (!requireBrowser(session, res)) return;
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
  const n = parseInt(req.query.n) || 50;
  res.json({ log: session.actionLog.slice(-n), sessionId: session.sessionId });
});

app.post('/api/find', async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  if (!requireBrowser(session, res)) return;
  try {
    const { selector, text } = req.body;
    if (text) {
      const results = await session.page.evaluate((searchText) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const matches = [];
        let node;
        while ((node = walker.nextNode()) && matches.length < 20) {
          if (node.textContent.includes(searchText)) {
            const el = node.parentElement;
            const rect = el.getBoundingClientRect();
            matches.push({
              text: el.textContent.substring(0, 200),
              box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              tag: el.tagName.toLowerCase(),
            });
          }
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

  session.log('record-start', `${session.recordZoom ? `zoom=${JSON.stringify(session.recordZoom)}` : 'full viewport'}`);
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

  const { format = 'gif', quality = 'high', speed = 1.0, filename } = req.body || {};
  session.recording = false;
  const frames = [...session.recordFrames];
  session.recordFrames = [];
  const zoom = session.recordZoom;

  session.broadcast({ type: 'recording', state: 'encoding', format, frameCount: frames.length });
  session.log('record-stop', `${frames.length} frames → ${format}`);

  if (frames.length === 0) {
    return res.json({ ok: false, error: 'No frames captured', sessionId: session.sessionId });
  }

  try {
    const result = await encodeRecording(frames, { format, quality, speed, zoom, filename });
    session.broadcast({ type: 'recording', state: 'done', file: result.file, size: result.sizeHuman });
    res.json({ ok: true, ...result, sessionId: session.sessionId });
  } catch (e) {
    session.broadcast({ type: 'recording', state: 'error', error: e.message });
    res.status(500).json({ error: `Encoding failed: ${e.message}` });
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
        return { name: data.name || f.replace('.json', ''), file: f, steps: (data.steps || []).length, description: data.description || '' };
      } catch { return { name: f, file: f, steps: 0 }; }
    });
    res.json({ scripts });
  } catch (e) { res.json({ scripts: [], error: e.message }); }
});

app.post('/api/scripts', (req, res) => {
  const { name, description, steps } = req.body;
  if (!name || !steps) return res.status(400).json({ error: 'name and steps required' });
  const filename = name.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json';
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
  const scriptNeedsExistingBrowser = !firstStep || firstStep.action !== 'goto';
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
        if (!session.page) await session.launch({ url: params.url });
        else await session.page.goto(params.url, { waitUntil: params.waitUntil || 'domcontentloaded', timeout: 30000 });
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
  if (!requireBrowser(session, res)) return;
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
  if (!requireBrowser(session, res)) return;
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
    let node;
    while ((node = walker.nextNode())) {
      if (node.textContent.includes(searchText)) {
        const el = node.parentElement;
        if (el) { el.click(); return true; }
      }
    }
    return false;
  }, text);
  if (!clicked) throw new Error(`Text "${text}" not found on page`);
}

// ─── Static UI ───────────────────────────────────────────────────────────────
app.get('/ghostpilot_logo.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'ghostpilot_logo.png'));
});
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'ui.html'));
});

// ─── WebSocket Handling ──────────────────────────────────────────────────────
// Manual upgrade handler so we can parse sessionId from /ws/:sessionId.
// noServer: true means the ws library does NOT auto-attach, so this is the
// only upgrade handler — no race condition.
server.on('upgrade', (request, socket, head) => {
  const match = request.url && request.url.match(/^\/ws(?:\/([^/?#]+))?/);
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
    if (session.lastFrameB64) ws.send(JSON.stringify({ type: 'frame', data: session.lastFrameB64 }));
    ws.send(JSON.stringify({ type: 'log', entries: session.actionLog.slice(-20), sessionId }));
    ws.send(JSON.stringify({ type: 'recording', state: session.recording ? 'started' : 'stopped' }));

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
