/**
 * GhostPilot — Shared Browser Control
 *
 * Uses CDP Page.screencastFrame for near-native streaming speed.
 * Human sees a live stream. Claude controls via REST API.
 * Human can click/type directly in the viewer.
 *
 * Usage:
 *   node server.js                          # starts on port 4444
 *   GHOST_PORT=5555 node server.js          # custom port
 */

import express from 'express';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.GHOST_PORT || '4444');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ type: 'text/*' }));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ─── Browser State ───────────────────────────────────────────────────────
let browser = null;
let context = null;
let page = null;
let cdpSession = null;
let screencastRunning = false;
let lastFrameB64 = null;
let actionLog = [];

function log(action, detail = '') {
  const entry = { ts: new Date().toISOString(), action, detail: String(detail).substring(0, 500) };
  actionLog.push(entry);
  if (actionLog.length > 200) actionLog.shift();
  console.log(`[GhostPilot] ${action}${detail ? ': ' + detail : ''}`);
  broadcast({ type: 'action', ...entry });
}

// ─── WebSocket Broadcasting ──────────────────────────────────────────────
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

// ─── CDP Screencast (hardware-accelerated, ~30fps) ───────────────────────
async function startScreencast() {
  if (!page || screencastRunning) return;
  try {
    cdpSession = await page.context().newCDPSession(page);
    cdpSession.on('Page.screencastFrame', async (params) => {
      lastFrameB64 = params.data;
      broadcast({ type: 'frame', data: params.data });
      // Acknowledge frame so CDP sends the next one
      try {
        await cdpSession.send('Page.screencastFrameAck', { sessionId: params.sessionId });
      } catch { /* session may be closed */ }
    });
    await cdpSession.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 80,
      maxWidth: 1440,
      maxHeight: 900,
      everyNthFrame: 1, // every frame
    });
    screencastRunning = true;
    log('screencast', 'started (CDP accelerated)');
  } catch (e) {
    console.error('[GhostPilot] CDP screencast failed, falling back to screenshots:', e.message);
    // Fallback to screenshot polling
    startScreenshotFallback();
  }
}

let fallbackInterval = null;
function startScreenshotFallback() {
  if (fallbackInterval) return;
  fallbackInterval = setInterval(async () => {
    if (!page) return;
    try {
      const buf = await page.screenshot({ type: 'jpeg', quality: 75, fullPage: false });
      lastFrameB64 = buf.toString('base64');
      broadcast({ type: 'frame', data: lastFrameB64 });
    } catch {}
  }, 150); // ~7fps fallback
}

async function stopScreencast() {
  if (cdpSession && screencastRunning) {
    try { await cdpSession.send('Page.stopScreencast'); } catch {}
    screencastRunning = false;
  }
  if (fallbackInterval) { clearInterval(fallbackInterval); fallbackInterval = null; }
}

// ─── Browser Lifecycle ───────────────────────────────────────────────────
async function launchBrowser(opts = {}) {
  if (browser) await closeBrowser();
  log('launch', `url=${opts.url || 'about:blank'}`);

  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--window-size=1440,900',
      '--disable-gpu',  // for consistency in headless
    ],
  });

  context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
  });

  page = await context.newPage();

  page.on('load', () => { log('page-load', page.url()); });
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
  await stopScreencast();
  if (browser) {
    try { await browser.close(); } catch {}
    browser = null; context = null; page = null; cdpSession = null;
  }
  log('closed');
}

function requirePage(res) {
  if (!page) { res.status(400).json({ error: 'No browser open. POST /api/launch first.' }); return false; }
  return true;
}

// ─── REST API ────────────────────────────────────────────────────────────

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

app.post('/api/click', async (req, res) => {
  if (!requirePage(res)) return;
  try {
    const { selector, text, x, y, button = 'left', timeout = 10000 } = req.body;
    if (x !== undefined && y !== undefined) {
      log('click', `(${x}, ${y})`);
      await page.mouse.click(x, y, { button });
    } else if (text) {
      log('click', `text="${text}"`);
      await page.getByText(text, { exact: false }).first().click({ timeout });
    } else if (selector) {
      log('click', selector);
      await page.locator(selector).first().click({ timeout });
    } else {
      return res.status(400).json({ error: 'Provide selector, text, or x/y coordinates' });
    }
    await page.waitForTimeout(200);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/type', async (req, res) => {
  if (!requirePage(res)) return;
  try {
    const { selector, text, value, delay = 0, clear = false } = req.body;
    const content = value || text;
    if (selector) {
      log('type', `${selector} = "${content?.substring(0, 50)}"`);
      const el = page.locator(selector).first();
      if (clear) await el.clear();
      await el.fill(content);
    } else {
      log('type', `keyboard: "${content?.substring(0, 50)}"`);
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
    await page.waitForTimeout(100);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/scroll', async (req, res) => {
  if (!requirePage(res)) return;
  try {
    const { x = 0, y = 300, selector } = req.body;
    log('scroll', `dy=${y}`);
    if (selector) {
      await page.locator(selector).first().evaluate((el, dy) => el.scrollBy(0, dy), y);
    } else {
      await page.mouse.wheel(x, y);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/wait', async (req, res) => {
  if (!requirePage(res)) return;
  try {
    const { selector, text, state = 'visible', timeout = 15000 } = req.body;
    log('wait', selector || `text="${text}"`);
    if (text) {
      await page.getByText(text, { exact: false }).first().waitFor({ state, timeout });
    } else {
      await page.locator(selector).first().waitFor({ state, timeout });
    }
    res.json({ ok: true, found: true });
  } catch (e) { res.json({ ok: false, found: false, error: e.message }); }
});

app.get('/api/page', async (req, res) => {
  if (!requirePage(res)) return;
  try {
    res.json({ url: page.url(), title: await page.title(), viewport: page.viewportSize() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/screenshot', async (req, res) => {
  if (!requirePage(res)) return;
  try {
    const fullPage = req.query.full === 'true';
    const buf = await page.screenshot({ type: 'png', fullPage });
    res.set('Content-Type', 'image/png');
    res.send(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/text', async (req, res) => {
  if (!requirePage(res)) return;
  try {
    const { selector } = req.body;
    const text = await page.locator(selector).first().textContent();
    res.json({ text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/eval', async (req, res) => {
  if (!requirePage(res)) return;
  try {
    const { script } = req.body;
    log('eval', script?.substring(0, 100));
    const result = await page.evaluate(script);
    res.json({ result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/select', async (req, res) => {
  if (!requirePage(res)) return;
  try {
    const { selector, value, label } = req.body;
    log('select', `${selector} = ${value || label}`);
    if (label) await page.locator(selector).first().selectOption({ label });
    else await page.locator(selector).first().selectOption(value);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/upload', async (req, res) => {
  if (!requirePage(res)) return;
  try {
    const { selector, filePath } = req.body;
    log('upload', filePath);
    await page.locator(selector).first().setInputFiles(filePath);
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
    let locator = text ? page.getByText(text, { exact: false }) : page.locator(selector);
    const count = await locator.count();
    const elements = [];
    for (let i = 0; i < Math.min(count, 20); i++) {
      try {
        const box = await locator.nth(i).boundingBox();
        const txt = await locator.nth(i).textContent();
        elements.push({ index: i, box, text: txt?.substring(0, 200) });
      } catch {}
    }
    res.json({ count, elements });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Static UI ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'ui.html'));
});

// ─── WebSocket Handling ──────────────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('[GhostPilot] Viewer connected');
  if (lastFrameB64) {
    ws.send(JSON.stringify({ type: 'frame', data: lastFrameB64 }));
  }
  ws.send(JSON.stringify({ type: 'log', entries: actionLog.slice(-20) }));

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
        await page.mouse.wheel(0, msg.dy || 300);
      } else if (msg.type === 'mousedown') {
        await page.mouse.down();
      } else if (msg.type === 'mouseup') {
        await page.mouse.up();
      }
    } catch {}
  });
});

// ─── Start ───────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║           G H O S T P I L O T  v1.0              ║
║   Shared Browser — Human + AI Copiloting         ║
╠══════════════════════════════════════════════════╣
║                                                  ║
║   Viewer:  http://localhost:${PORT}               ${PORT < 10000 ? ' ' : ''}║
║   API:     http://localhost:${PORT}/api/*          ${PORT < 10000 ? ' ' : ''}║
║                                                  ║
║   CDP screencast for near-native speed.          ║
║   Click anywhere in the viewer to interact.      ║
║                                                  ║
╚══════════════════════════════════════════════════╝
`);
});
