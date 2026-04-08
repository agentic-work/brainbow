/**
 * GhostPilot v2.0 — Shared Browser Control + Recording Studio
 *
 * Zero Playwright. Uses puppeteer-core + system Chromium via CDP.
 * CDP Page.screencastFrame for near-native streaming (~30fps).
 * Human sees live stream, Claude controls via REST API.
 * Human can click/type directly in the viewer.
 *
 * Recording: captures CDP frames → encodes to GIF/MP4/WebM via ffmpeg.
 * Zoom: crops and scales action zones for cinematic demos.
 * Hard reload: bypass browser cache on demand.
 *
 * Usage:
 *   node server.js                          # starts on port 4444
 *   GHOST_PORT=5555 node server.js          # custom port
 *   CHROME_PATH=/usr/bin/chromium node server.js
 */

import express from 'express';
import puppeteer from 'puppeteer-core';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.GHOST_PORT || '4444');
const RECORDINGS_DIR = process.env.GHOST_RECORDINGS || path.join(os.tmpdir(), 'ghostpilot-recordings');

fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

// ─── Find System Chromium ───────────────────────────────────────────────
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  try {
    return execSync('which chromium || which chromium-browser || which google-chrome 2>/dev/null', { encoding: 'utf8' }).trim().split('\n')[0];
  } catch {}
  // Last resort: try to find any chrome-like binary via npx or common paths
  const fallbacks = [
    // Playwright's downloaded chromium (if someone has it installed separately)
    path.join(os.homedir(), '.cache/ms-playwright/chromium-*/chrome-linux/chrome'),
    path.join(os.homedir(), '.cache/puppeteer/chrome/*/chrome-linux64/chrome'),
  ];
  for (const pattern of fallbacks) {
    try {
      const result = execSync(`ls ${pattern} 2>/dev/null | head -1`, { encoding: 'utf8' }).trim();
      if (result && fs.existsSync(result)) return result;
    } catch {}
  }
  throw new Error('No Chromium found. Set CHROME_PATH env or install: apt-get install chromium');
}

// Check ffmpeg availability
let hasFFmpeg = false;
try { execSync('ffmpeg -version', { stdio: 'ignore' }); hasFFmpeg = true; } catch {}

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.text({ type: 'text/*' }));

// ─── Authentication Middleware ──────────────────────────────────────────────
const GHOST_SECRET = process.env.GHOST_SECRET;
if (GHOST_SECRET) {
  app.use((req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${GHOST_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  });
} // If GHOST_SECRET not set, all requests pass through (backward compat for local dev)

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ─── Secret Redaction ────────────────────────────────────────────────────
const SECRET_PATTERNS = [
  /(?:password|passwd|pwd|pass|secret|token|api[_-]?key|auth|bearer|credential)[\s]*[=:]["']?\s*\S+/gi,
  /Bearer\s+[A-Za-z0-9._\-]+/gi,
  /(?:awc_|sk-|pk-|ghp_|gho_|github_pat_|xox[bpars]-)[A-Za-z0-9_\-]{10,}/g,
  /eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}/g,
  /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
  /(?:client[_-]?secret|access[_-]?key|secret[_-]?key)[\s]*[=:]["']?\s*\S+/gi,
  /(?:password|pwd)=[^&;\s"']+/gi,
  // OAuth/SSO URL parameters — redact tenant IDs, client IDs, tokens, state, codes
  /(?:client_id|tenant|state|code|nonce|id_token|access_token|refresh_token|assertion)=[^&\s"']+/gi,
  // Azure AD / Microsoft login URLs — redact tenant GUID from path
  /login\.microsoftonline\.com\/[0-9a-f-]{36}/gi,
  // Any GUID that looks like a tenant/client ID in an OAuth context
  /(?:oauth2|authorize|token|callback)[^"'\s]*[0-9a-f-]{36}/gi,
];

function redactSecrets(text) {
  if (!text) return text;
  let result = text;
  for (const p of SECRET_PATTERNS) {
    // Reset lastIndex for global regexes to avoid stale state
    p.lastIndex = 0;
    result = result.replace(p, (match) => {
      // For OAuth URL params, redact just the value
      const eqIdx = match.search(/[=:]\s*/);
      if (eqIdx > 0) return match.substring(0, eqIdx + 1) + '******';
      // For login URLs with tenant, replace the tenant GUID
      if (/login\.microsoftonline/i.test(match)) return 'login.microsoftonline.com/******';
      if (match.length > 8) return match.substring(0, 4) + '******';
      return '******';
    });
  }
  return result;
}

// ─── State ──────────────────────────────────────────────────────────────
let browser = null;
let page = null;
let cdpSession = null;
let screencastRunning = false;
let lastFrameB64 = null;
let viewportW = 1440, viewportH = 900;
let actionLog = [];

// Recording state
let recording = false;
let recordFrames = [];   // { data: base64, ts: number (ms since start) }
let recordStartTime = 0;
let recordZoom = null;   // { x, y, width, height } in page pixels

function log(action, detail = '') {
  const safeDetail = redactSecrets(String(detail).substring(0, 500));
  const entry = { ts: new Date().toISOString(), action, detail: safeDetail };
  actionLog.push(entry);
  if (actionLog.length > 200) actionLog.shift();
  console.log(`[GhostPilot] ${action}${safeDetail ? ': ' + safeDetail : ''}`);
  broadcast({ type: 'action', ...entry });
}

// ─── WebSocket Broadcasting ─────────────────────────────────────────────
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

// ─── CDP Screencast ─────────────────────────────────────────────────────
async function startScreencast() {
  if (!page || screencastRunning) return;
  try {
    cdpSession = await page.createCDPSession();
    cdpSession.on('Page.screencastFrame', async (params) => {
      lastFrameB64 = params.data;
      broadcast({ type: 'frame', data: params.data });

      // Capture frames for recording
      if (recording) {
        recordFrames.push({ data: params.data, ts: Date.now() - recordStartTime });
      }

      try {
        await cdpSession.send('Page.screencastFrameAck', { sessionId: params.sessionId });
      } catch { /* session closed */ }
    });
    await cdpSession.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 80,
      maxWidth: viewportW,
      maxHeight: viewportH,
      everyNthFrame: 1,
    });
    screencastRunning = true;
    log('screencast', 'started (CDP)');
  } catch (e) {
    console.error('[GhostPilot] CDP screencast failed, falling back:', e.message);
    startScreenshotFallback();
  }
}

let fallbackInterval = null;
function startScreenshotFallback() {
  if (fallbackInterval) return;
  fallbackInterval = setInterval(async () => {
    if (!page) return;
    try {
      const buf = await page.screenshot({ type: 'jpeg', quality: 75 });
      lastFrameB64 = buf.toString('base64');
      broadcast({ type: 'frame', data: lastFrameB64 });
      if (recording) {
        recordFrames.push({ data: lastFrameB64, ts: Date.now() - recordStartTime });
      }
    } catch {}
  }, 100); // ~10fps fallback
}

async function stopScreencast() {
  if (cdpSession && screencastRunning) {
    try { await cdpSession.send('Page.stopScreencast'); } catch {}
    screencastRunning = false;
  }
  if (fallbackInterval) { clearInterval(fallbackInterval); fallbackInterval = null; }
}

// ─── Browser Lifecycle ──────────────────────────────────────────────────
async function launchBrowser(opts = {}) {
  if (browser) await closeBrowser();

  const chromePath = findChrome();
  log('launch', `chrome=${chromePath} url=${opts.url || 'about:blank'}`);

  const width = opts.width || 1440;
  const height = opts.height || 900;
  viewportW = width;
  viewportH = height;

  browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      `--window-size=${width},${height}`,
      '--disable-gpu',
      '--disable-extensions',
      '--no-first-run',
      '--disable-default-apps',
    ],
  });

  page = (await browser.pages())[0] || await browser.newPage();
  await page.setViewport({ width, height });

  page.on('load', () => log('page-load', page.url()));
  page.on('dialog', async (dialog) => {
    log('dialog', `${dialog.type()}: ${dialog.message()}`);
    broadcast({ type: 'dialog', dialogType: dialog.type(), message: dialog.message() });
  });

  if (opts.url) {
    await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }

  await startScreencast();
  return { ok: true, url: page.url() };
}

async function closeBrowser() {
  if (recording) { recording = false; recordFrames = []; }
  await stopScreencast();
  if (browser) {
    try { await browser.close(); } catch {}
    browser = null; page = null; cdpSession = null;
  }
  log('closed');
}

function requirePage(res) {
  if (!page) { res.status(400).json({ error: 'No browser open. POST /api/launch first.' }); return false; }
  return true;
}

// ─── Helper: find element by text ───────────────────────────────────────
async function clickByText(text) {
  const clicked = await page.evaluate((searchText) => {
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

// ─── REST API ───────────────────────────────────────────────────────────

app.post('/api/launch', async (req, res) => {
  try {
    const result = await launchBrowser(req.body || {});
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/close', async (req, res) => {
  await closeBrowser();
  res.json({ ok: true });
});

app.post('/api/goto', async (req, res) => {
  if (!requirePage(res)) return;
  try {
    const { url, waitUntil = 'domcontentloaded' } = req.body;
    log('goto', url);
    await page.goto(url, { waitUntil, timeout: 30000 });
    res.json({ ok: true, url: page.url(), title: await page.title() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Hard reload — bypass all caches
app.post('/api/reload', async (req, res) => {
  if (!requirePage(res)) return;
  try {
    const { noCache = true } = req.body || {};
    log('reload', noCache ? 'hard (no-cache)' : 'soft');
    if (noCache && cdpSession) {
      await cdpSession.send('Network.setCacheDisabled', { cacheDisabled: true });
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      await cdpSession.send('Network.setCacheDisabled', { cacheDisabled: false });
    } else {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    res.json({ ok: true, url: page.url(), title: await page.title() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/click', async (req, res) => {
  if (!requirePage(res)) return;
  try {
    const { selector, text, x, y, button = 'left', timeout = 10000 } = req.body;
    if (x !== undefined && y !== undefined) {
      log('click', `(${x}, ${y})`);
      await page.mouse.click(x, y, { button });
    } else if (text) {
      log('click', `text="${text}"`);
      await clickByText(text);
    } else if (selector) {
      log('click', selector);
      await page.waitForSelector(selector, { timeout });
      await page.click(selector);
    } else {
      return res.status(400).json({ error: 'Provide selector, text, or x/y coordinates' });
    }
    await new Promise(r => setTimeout(r, 200));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/type', async (req, res) => {
  if (!requirePage(res)) return;
  try {
    const { selector, text, value, delay = 0, clear = false } = req.body;
    const content = value || text;
    // Redact content when typing into password/secret fields — check selector AND actual DOM element type
    let isPasswordField = selector && /password|passwd|secret|token|api[_-]?key|credential/i.test(selector);
    if (!isPasswordField && selector) {
      try {
        isPasswordField = await page.$eval(selector, el => el.type === 'password' || el.autocomplete === 'current-password' || el.autocomplete === 'new-password');
      } catch {}
    }
    const safeContent = isPasswordField ? '******' : content?.substring(0, 50);
    // Also redact the selector itself if it reveals auth field names
    const safeSelector = selector ? redactSecrets(selector) : '';
    if (selector) {
      log('type', `${safeSelector} = "${safeContent}"`);
      if (clear) {
        await page.click(selector, { clickCount: 3 });
        await page.keyboard.press('Backspace');
      }
      await page.type(selector, content, { delay });
    } else {
      log('type', `keyboard: "${safeContent}"`);
      await page.keyboard.type(content, { delay });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/key', async (req, res) => {
  if (!requirePage(res)) return;
  try {
    const { key } = req.body;
    log('key', key);
    await page.keyboard.press(key);
    await new Promise(r => setTimeout(r, 100));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/scroll', async (req, res) => {
  if (!requirePage(res)) return;
  try {
    const { x = 0, y = 300, selector } = req.body;
    log('scroll', `dy=${y}`);
    if (selector) {
      await page.$eval(selector, (el, dy) => el.scrollBy(0, dy), y);
    } else {
      await page.mouse.wheel({ deltaX: x, deltaY: y });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Evaluate JS in page (debugging)
app.post('/api/eval', async (req, res) => {
  if (!requirePage(res)) return;
  try {
    const { script, expression } = req.body;
    const code = script || expression;
    log('eval', code?.substring(0, 100));
    // Wrap in a function that returns the result so Puppeteer captures it
    const wrappedCode = `(() => { ${code} })()`;
    const result = await page.evaluate(wrappedCode);
    res.json({ ok: true, result });
  } catch (e) {
    // If wrapping fails (e.g. already a function expression), try raw
    try {
      const raw = script || expression;
      const result = await page.evaluate(raw);
      res.json({ ok: true, result });
    } catch (e2) {
      res.status(500).json({ ok: false, error: e.message });
    }
  }
});

// Get page text + URL (debugging)
app.get('/api/pageinfo', async (req, res) => {
  if (!requirePage(res)) return;
  try {
    const text = await page.evaluate(() => document.body.innerText.substring(0, 2000));
    const url = page.url();
    const title = await page.title();
    res.json({ url, title, text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/wait', async (req, res) => {
  if (!requirePage(res)) return;
  try {
    const { selector, text, timeout = 15000 } = req.body;
    log('wait', selector || `text="${text}"`);
    if (text) {
      await page.waitForFunction(
        (t) => document.body.innerText.includes(t),
        { timeout },
        text
      );
    } else {
      await page.waitForSelector(selector, { visible: true, timeout });
    }
    res.json({ ok: true, found: true });
  } catch (e) { res.json({ ok: false, found: false, error: e.message }); }
});

app.get('/api/page', async (req, res) => {
  if (!requirePage(res)) return;
  try {
    res.json({ url: page.url(), title: await page.title(), viewport: page.viewport() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/screenshot', async (req, res) => {
  if (!requirePage(res)) return;
  try {
    const fullPage = req.query.full === 'true';
    const format = req.query.format || 'jpeg'; // default to jpeg for smaller files
    const quality = parseInt(req.query.quality || '70');
    const maxWidth = parseInt(req.query.maxWidth || '0');

    let buf;
    if (format === 'png') {
      buf = await page.screenshot({ type: 'png', fullPage });
    } else {
      buf = await page.screenshot({ type: 'jpeg', quality: Math.min(quality, 100), fullPage });
    }

    // Auto-shrink to stay under 300KB - fast JPEG re-shoot before expensive ffmpeg
    const MAX_BYTES = parseInt(req.query.maxBytes || '300000');
    if (buf.length > MAX_BYTES && format !== 'png') {
      buf = await page.screenshot({ type: 'jpeg', quality: Math.max(25, quality - 30), fullPage });
    }
    if (buf.length > MAX_BYTES && format !== 'png') {
      buf = await page.screenshot({ type: 'jpeg', quality: 15, fullPage });
    }
    // ffmpeg downscale as last resort
    if ((buf.length > MAX_BYTES || maxWidth > 0) && hasFFmpeg) {
      try {
        const ts = Date.now();
        const tmpIn = path.join(os.tmpdir(), `ghost_in_${ts}.jpg`);
        const tmpOut = path.join(os.tmpdir(), `ghost_out_${ts}.jpg`);
        fs.writeFileSync(tmpIn, buf);
        const w = maxWidth > 0 ? maxWidth : 1024;
        execSync(`ffmpeg -y -i ${tmpIn} -vf scale=${w}:-1 -q:v 6 ${tmpOut} 2>/dev/null`);
        buf = fs.readFileSync(tmpOut);
        fs.unlinkSync(tmpIn);
        fs.unlinkSync(tmpOut);
      } catch { /* fallback to original buf */ }
    }

    res.set('Content-Type', format === 'png' ? 'image/png' : 'image/jpeg');
    res.send(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Returns the latest screencast frame as base64 JSON — no file I/O needed by the caller.
// Use this from Claude instead of saving screenshots to disk and reading them as images.
// Falls back to a fresh screenshot if no screencast frame is cached.
app.get('/api/frame', async (req, res) => {
  if (!requirePage(res)) return;
  try {
    let b64 = lastFrameB64;
    if (!b64) {
      // No screencast frame cached — take a fresh JPEG screenshot
      const buf = await page.screenshot({ type: 'jpeg', quality: 60 });
      b64 = buf.toString('base64');
    }
    res.json({
      ok: true,
      frame: b64,
      width: viewportW,
      height: viewportH,
      timestamp: Date.now(),
      source: lastFrameB64 ? 'screencast' : 'screenshot',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/text', async (req, res) => {
  if (!requirePage(res)) return;
  try {
    const { selector } = req.body;
    const text = await page.$eval(selector, el => el.textContent);
    res.json({ text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Duplicate /api/eval removed — consolidated above (line 377)

app.post('/api/select', async (req, res) => {
  if (!requirePage(res)) return;
  try {
    const { selector, value, label } = req.body;
    log('select', `${selector} = ${value || label}`);
    await page.select(selector, value || label);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/upload', async (req, res) => {
  if (!requirePage(res)) return;
  try {
    const { selector, filePath } = req.body;
    log('upload', filePath);
    const input = await page.$(selector);
    await input.uploadFile(filePath);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/dialog', async (req, res) => {
  if (!requirePage(res)) return;
  try {
    const { action = 'accept', text } = req.body;
    page.once('dialog', async (dialog) => {
      if (action === 'accept') await dialog.accept(text);
      else await dialog.dismiss();
    });
    res.json({ ok: true, waiting: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/log', (req, res) => {
  const n = parseInt(req.query.n) || 50;
  res.json({ log: actionLog.slice(-n) });
});

app.post('/api/find', async (req, res) => {
  if (!requirePage(res)) return;
  try {
    const { selector, text } = req.body;
    if (text) {
      const results = await page.evaluate((searchText) => {
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
      res.json({ count: results.length, elements: results });
    } else {
      const results = await page.$$eval(selector, (els) =>
        els.slice(0, 20).map((el, i) => ({
          index: i,
          text: el.textContent?.substring(0, 200),
          box: (() => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })(),
          tag: el.tagName.toLowerCase(),
        }))
      );
      res.json({ count: results.length, elements: results });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Recording API ──────────────────────────────────────────────────────

app.post('/api/record/start', (req, res) => {
  const { zoom } = req.body || {};
  if (recording) return res.status(400).json({ error: 'Already recording' });

  recording = true;
  recordFrames = [];
  recordStartTime = Date.now();
  recordZoom = zoom || null;

  log('record-start', `${recordZoom ? `zoom=${JSON.stringify(recordZoom)}` : 'full viewport'}`);
  broadcast({ type: 'recording', state: 'started' });
  res.json({ ok: true, recording: true });
});

app.post('/api/record/zoom', (req, res) => {
  const { x, y, width, height, reset } = req.body || {};
  if (reset) {
    recordZoom = null;
    log('record-zoom', 'reset to full viewport');
  } else {
    recordZoom = { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
    log('record-zoom', `${recordZoom.x},${recordZoom.y} ${recordZoom.width}x${recordZoom.height}`);
  }
  broadcast({ type: 'recording', state: 'zoom', zoom: recordZoom });
  res.json({ ok: true, zoom: recordZoom });
});

app.post('/api/record/stop', async (req, res) => {
  if (!recording) return res.status(400).json({ error: 'Not recording' });

  const { format = 'gif', quality = 'high', speed = 1.0, filename } = req.body || {};
  recording = false;
  const frames = [...recordFrames];
  recordFrames = [];
  const zoom = recordZoom;

  broadcast({ type: 'recording', state: 'encoding', format, frameCount: frames.length });
  log('record-stop', `${frames.length} frames → ${format}`);

  if (frames.length === 0) {
    return res.json({ ok: false, error: 'No frames captured' });
  }

  try {
    const result = await encodeRecording(frames, { format, quality, speed, zoom, filename });
    broadcast({ type: 'recording', state: 'done', file: result.file, size: result.sizeHuman });
    res.json({ ok: true, ...result });
  } catch (e) {
    broadcast({ type: 'recording', state: 'error', error: e.message });
    res.status(500).json({ error: `Encoding failed: ${e.message}` });
  }
});

app.get('/api/record/status', (req, res) => {
  res.json({
    recording,
    frames: recordFrames.length,
    duration: recording ? Date.now() - recordStartTime : 0,
    zoom: recordZoom,
    ffmpeg: hasFFmpeg,
  });
});

// List/serve recordings
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
  const filePath = path.join(RECORDINGS_DIR, path.basename(req.params.name));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(filePath);
});

// ─── Scripts Engine (repeatable macros) ─────────────────────────────────
const SCRIPTS_DIR = process.env.GHOST_SCRIPTS || path.join(__dirname, 'scripts');
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
  log('script-saved', `${name} (${steps.length} steps)`);
  res.json({ ok: true, file: filename });
});

app.post('/api/scripts/:name/run', async (req, res) => {
  const filename = req.params.name.endsWith('.json') ? req.params.name : req.params.name + '.json';
  const filepath = path.join(SCRIPTS_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Script not found' });

  const script = JSON.parse(fs.readFileSync(filepath, 'utf8'));
  log('script-run', `${script.name} (${script.steps.length} steps)`);

  const results = [];
  for (const step of script.steps) {
    try {
      const { action, ...params } = step;
      let result;

      if (action === 'goto') {
        // Auto-launch browser if not open
        if (!page) await launchBrowser({ url: params.url });
        else await page.goto(params.url, { waitUntil: params.waitUntil || 'domcontentloaded', timeout: 30000 });
        result = { ok: true };
      } else if (action === 'click') {
        if (params.text) await clickByText(params.text);
        else if (params.selector) { await page.waitForSelector(params.selector, { timeout: params.timeout || 10000 }); await page.click(params.selector); }
        else if (params.x !== undefined) await page.mouse.click(params.x, params.y);
        result = { ok: true };
      } else if (action === 'type') {
        if (params.selector) await page.type(params.selector, params.value || params.text, { delay: params.delay || 0 });
        else await page.keyboard.type(params.value || params.text, { delay: params.delay || 0 });
        result = { ok: true };
      } else if (action === 'key') {
        await page.keyboard.press(params.key);
        result = { ok: true };
      } else if (action === 'wait') {
        if (params.ms) await new Promise(r => setTimeout(r, params.ms));
        else if (params.selector) await page.waitForSelector(params.selector, { visible: true, timeout: params.timeout || 15000 });
        else if (params.text) await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout: params.timeout || 15000 }, params.text);
        result = { ok: true };
      } else if (action === 'hitl') {
        // Human-in-the-loop: ask the user for input via GhostPilot UI
        result = await requestHumanInput(params.prompt || 'Input needed', params.type || 'text', params.timeout || 120000);
      } else if (action === 'fill_hitl') {
        // Fill a field with the last HITL response
        if (lastHitlResponse && params.selector) {
          await page.type(params.selector, lastHitlResponse, { delay: params.delay || 0 });
          result = { ok: true, filled: true };
        } else {
          result = { ok: false, error: 'No HITL response available' };
        }
      } else {
        result = { ok: false, error: `Unknown action: ${action}` };
      }

      log('script-step', `${action}: ok`);
      results.push({ action, ...result });
    } catch (e) {
      log('script-step', `${step.action}: FAIL ${e.message}`);
      results.push({ action: step.action, ok: false, error: e.message });
      if (step.required !== false) break; // Stop on required step failure
    }

    // Small delay between steps for visual feedback
    await new Promise(r => setTimeout(r, step.delay || 300));
  }

  res.json({ ok: true, results, stepsRun: results.length, totalSteps: script.steps.length });
});

// ─── Human-in-the-Loop (HITL) ──────────────────────────────────────────
let hitlPending = null;  // { resolve, reject, prompt, type, id }
let lastHitlResponse = null;

function requestHumanInput(prompt, type = 'text', timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const id = Date.now().toString(36);
    hitlPending = { resolve, reject, prompt, type, id };

    broadcast({ type: 'hitl_request', id, prompt, inputType: type });
    log('hitl', `Waiting for user: ${prompt}`);

    setTimeout(() => {
      if (hitlPending && hitlPending.id === id) {
        hitlPending = null;
        reject(new Error('HITL timeout — user did not respond'));
      }
    }, timeoutMs);
  });
}

// HITL response endpoint (called from UI when user submits)
app.post('/api/hitl/respond', (req, res) => {
  const { value, id } = req.body;
  if (!hitlPending) return res.status(400).json({ error: 'No pending HITL request' });
  if (id && hitlPending.id !== id) return res.status(400).json({ error: 'HITL request ID mismatch' });

  lastHitlResponse = value;
  hitlPending.resolve({ ok: true, value });
  hitlPending = null;

  broadcast({ type: 'hitl_resolved', id });
  log('hitl', 'User responded');
  res.json({ ok: true });
});

// HITL cancel
app.post('/api/hitl/cancel', (req, res) => {
  if (!hitlPending) return res.json({ ok: true, message: 'Nothing pending' });
  hitlPending.reject(new Error('HITL cancelled by user'));
  hitlPending = null;
  broadcast({ type: 'hitl_cancelled' });
  res.json({ ok: true });
});

// Check HITL status
app.get('/api/hitl/status', (req, res) => {
  res.json({ pending: !!hitlPending, prompt: hitlPending?.prompt, type: hitlPending?.type, id: hitlPending?.id });
});

// ─── Encoding Engine ────────────────────────────────────────────────────

function humanSize(bytes) {
  if (bytes > 1048576) return `${(bytes / 1048576).toFixed(1)}MB`;
  return `${(bytes / 1024).toFixed(0)}KB`;
}

async function encodeRecording(frames, opts = {}) {
  const { format = 'gif', quality = 'high', speed = 1.0, zoom, filename } = opts;
  const ts = Date.now();
  const outName = filename || `ghost-${ts}.${format}`;
  const outFile = path.join(RECORDINGS_DIR, outName);

  // Write frames to temp dir
  const tmpDir = path.join(os.tmpdir(), `ghost-encode-${ts}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  for (let i = 0; i < frames.length; i++) {
    const buf = Buffer.from(frames[i].data, 'base64');
    fs.writeFileSync(path.join(tmpDir, `frame-${String(i).padStart(6, '0')}.jpg`), buf);
  }

  // Calculate FPS from actual frame timestamps
  const durationSec = Math.max(frames[frames.length - 1].ts / 1000, 0.1);
  const rawFps = Math.min(Math.round(frames.length / durationSec), 30);
  const inputFps = Math.max(Math.round(rawFps / speed), 1);

  if (!hasFFmpeg) {
    // No ffmpeg — save raw frames (still useful)
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
    // Build crop filter if zoom region set
    const cropFilter = zoom ? `crop=${zoom.width}:${zoom.height}:${zoom.x}:${zoom.y},` : '';

    if (format === 'gif') {
      const scale = quality === 'high' ? 800 : quality === 'medium' ? 540 : 360;
      const paletteFile = path.join(tmpDir, 'palette.png');

      // Pass 1: generate optimal palette
      await runFFmpeg([
        '-framerate', String(inputFps),
        '-i', path.join(tmpDir, 'frame-%06d.jpg'),
        '-vf', `${cropFilter}scale=${scale}:-1:flags=lanczos,palettegen=max_colors=256:stats_mode=diff`,
        '-y', paletteFile,
      ]);

      // Pass 2: encode with palette for high-quality dithering
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
      // Ensure even dimensions for H.264
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
    // Clean up temp frames
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

// ─── Static UI ──────────────────────────────────────────────────────────
app.get('/ghostpilot_logo.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'ghostpilot_logo.png'));
});
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'ui.html'));
});

// ─── WebSocket Handling ─────────────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('[GhostPilot] Viewer connected');
  if (lastFrameB64) ws.send(JSON.stringify({ type: 'frame', data: lastFrameB64 }));
  ws.send(JSON.stringify({ type: 'log', entries: actionLog.slice(-20) }));
  ws.send(JSON.stringify({ type: 'recording', state: recording ? 'started' : 'stopped' }));

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (!page) return;
      if (msg.type === 'click') {
        await page.mouse.click(msg.x, msg.y);
        log('human-click', `(${msg.x}, ${msg.y})`);
      } else if (msg.type === 'mousemove') {
        await page.mouse.move(msg.x, msg.y);
      } else if (msg.type === 'type') {
        await page.keyboard.type(msg.text);
        log('human-type', msg.text?.substring(0, 50));
      } else if (msg.type === 'key') {
        await page.keyboard.press(msg.key);
        log('human-key', msg.key);
      } else if (msg.type === 'scroll') {
        await page.mouse.wheel({ deltaX: 0, deltaY: msg.dy || 300 });
      } else if (msg.type === 'mousedown') {
        await page.mouse.down();
      } else if (msg.type === 'mouseup') {
        await page.mouse.up();
      }
    } catch {}
  });
});

// ─── Vision Agent (Ollama) ───────────────────────────────────────────────
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const VISION_MODEL = process.env.VISION_MODEL || 'moondream';
const VISION_INTERVAL = parseInt(process.env.VISION_INTERVAL || '2000'); // ms between auto-descriptions

let visionDescription = '';
let visionTimestamp = 0;
let visionWatching = false;
let visionInterval = null;
let visionError = null;
let visionModelReady = false;

// Check if vision model is available
async function checkVisionModel() {
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/tags`);
    const data = await resp.json();
    const models = (data.models || []).map(m => m.name);
    // Check for any vision-capable model
    const visionModels = models.filter(m =>
      /llava|minicpm|bakllava|moondream|qwen.*vl/i.test(m)
    );
    if (visionModels.length > 0) {
      visionModelReady = true;
      log('vision', `Found vision model(s): ${visionModels.join(', ')}`);
      return visionModels[0].split(':')[0]; // Return first available
    }
    log('vision', `No vision model found. Available: ${models.join(', ')}. Pulling ${VISION_MODEL}...`);
    // Auto-pull in background
    fetch(`${OLLAMA_URL}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: VISION_MODEL, stream: false }),
    }).then(() => {
      visionModelReady = true;
      log('vision', `${VISION_MODEL} pulled successfully`);
    }).catch(e => log('vision', `Pull failed: ${e.message}`));
    return null;
  } catch (e) {
    log('vision', `Ollama not reachable: ${e.message}`);
    return null;
  }
}

// Describe current screen via Ollama vision
async function describeScreen(prompt) {
  if (!lastFrameB64) return 'No browser frame available';

  const userPrompt = prompt || 'Describe what you see on this screen. Focus on: what app/page is shown, any error messages, loading states, data displayed, buttons/controls visible. Be concise but thorough.';

  try {
    const resp = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: VISION_MODEL,
        prompt: userPrompt,
        images: [lastFrameB64],
        stream: false,
        options: { temperature: 0.1, num_predict: 500 },
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      visionError = `Ollama ${resp.status}: ${err.substring(0, 200)}`;
      return visionError;
    }

    const data = await resp.json();
    visionDescription = data.response || '';
    visionTimestamp = Date.now();
    visionError = null;
    return visionDescription;
  } catch (e) {
    visionError = e.message;
    return `Vision error: ${e.message}`;
  }
}

// One-shot describe
app.post('/api/vision/describe', async (req, res) => {
  const { prompt } = req.body || {};
  const description = await describeScreen(prompt);
  res.json({
    description,
    timestamp: Date.now(),
    model: VISION_MODEL,
    error: visionError,
  });
});

// Get latest cached description (instant, no Ollama call)
app.get('/api/vision/status', (req, res) => {
  res.json({
    description: visionDescription,
    timestamp: visionTimestamp,
    age: visionTimestamp ? Date.now() - visionTimestamp : -1,
    watching: visionWatching,
    model: VISION_MODEL,
    modelReady: visionModelReady,
    error: visionError,
  });
});

// Start auto-watching (describes screen every N seconds)
app.post('/api/vision/watch', async (req, res) => {
  const { interval = VISION_INTERVAL, prompt } = req.body || {};

  if (visionWatching) {
    clearInterval(visionInterval);
  }

  visionWatching = true;
  log('vision-watch', `started (every ${interval}ms)`);

  // Immediate first description
  await describeScreen(prompt);

  visionInterval = setInterval(async () => {
    if (!lastFrameB64) return;
    await describeScreen(prompt);
    // Broadcast to WebSocket viewers
    broadcast({
      type: 'vision',
      description: visionDescription,
      timestamp: visionTimestamp,
    });
  }, interval);

  res.json({
    ok: true,
    watching: true,
    interval,
    description: visionDescription,
  });
});

// Stop auto-watching
app.post('/api/vision/stop', (req, res) => {
  if (visionInterval) {
    clearInterval(visionInterval);
    visionInterval = null;
  }
  visionWatching = false;
  log('vision-watch', 'stopped');
  res.json({ ok: true, watching: false });
});

// Instant screen state — DOM text + cached vision (ZERO latency)
app.get('/api/screen', async (req, res) => {
  if (!requirePage(res)) return;
  try {
    const [text, title, url] = await Promise.all([
      page.evaluate(() => document.body.innerText.substring(0, 8000)),
      page.title(),
      Promise.resolve(page.url()),
    ]);
    res.json({
      url, title, text,
      vision: visionDescription,
      visionAge: visionTimestamp ? `${((Date.now() - visionTimestamp) / 1000).toFixed(1)}s ago` : 'none',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get page text + screenshot description combined (best of both worlds)
app.get('/api/vision/full', async (req, res) => {
  if (!requirePage(res)) return;
  try {
    const [pageText, title, url] = await Promise.all([
      page.evaluate(() => document.body.innerText.substring(0, 5000)),
      page.title(),
      Promise.resolve(page.url()),
    ]);

    // If vision description is fresh (< 5s old), use cached
    let description = visionDescription;
    if (!description || Date.now() - visionTimestamp > 5000) {
      description = await describeScreen();
    }

    res.json({
      url,
      title,
      pageText: pageText.substring(0, 3000),
      visionDescription: description,
      visionAge: visionTimestamp ? Date.now() - visionTimestamp : -1,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Start ──────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  // Check for vision model on startup
  checkVisionModel();
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║           G H O S T P I L O T  v2.0                       ║
║   Shared Browser + Recording Studio                       ║
╠═══════════════════════════════════════════════════════════╣
║                                                           ║
║   Viewer:     http://localhost:${String(PORT).padEnd(5)}                      ║
║   API:        http://localhost:${String(PORT).padEnd(5)}/api/*                ║
║   Recordings: ${RECORDINGS_DIR.substring(0, 43).padEnd(43)}║
║                                                           ║
║   Engine:     puppeteer-core + system Chromium (no PW)    ║
║   ffmpeg:     ${hasFFmpeg ? 'YES — GIF/MP4/WebM encoding ready' : 'NO  — install for video encoding'}${''.padEnd(hasFFmpeg ? 5 : 6)}║
║                                                           ║
║   New: /api/record/start, /api/record/stop                ║
║        /api/record/zoom, /api/reload                      ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
`);
});
