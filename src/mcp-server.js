#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Brainbow MCP stdio server — replacement for the playwright MCP.
//
// Spawned by Claude Code (or any MCP client) over stdin/stdout. Translates
// MCP tools/list + tools/call into HTTP requests against a running brainbow
// REST server (default http://localhost:4444, override with BRAINBOW_URL).
//
// The brainbow REST server MUST be running independently — this MCP server
// does not start it. Use `node server.js` (or `npm start`) in another
// terminal. Optionally `BRAINBOW_VISION_AUTOSTART=true` to auto-start
// vision narration on the first `screen`/`live` call.
//
// Tools surfaced (replaces mcp__plugin_playwright_playwright__*):
//   screen        — current frame (image) + DOM counts + url/title
//   live          — THE keystone: frame + narration + DOM + console + logs
//   launch        — open browser
//   close         — close browser
//   goto          — navigate
//   click         — click by selector or coord
//   type          — type text (optionally into a selector first)
//   key           — press a single key
//   scroll        — scroll page
//   wait_for      — wait for selector / text / url
//   eval          — run JS in page context
//   snapshot      — accessibility tree
//   find          — find by selector/text, return coords + outerHTML
//   console       — page console log tail
//   sessions      — list sessions / select
//   narrate_start — start Bedrock Sonnet live narration
//   narrate_stop  — stop narration
//   log_subscribe — start an external log tail (kubectl logs -f, etc)
//   log_unsubscribe — stop a log tail
//   log_list      — list active tails

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// ─── NEVER-DIE GUARDS ──────────────────────────────────────────────────
// An MCP stdio server that exits takes ALL of its tools down at once
// (the host reports "No such tool available: mcp__brainbow__*"). The
// #1 cause of brainbow disconnects was an unhandled rejection / uncaught
// exception bubbling to the top and exiting the process — e.g. a
// fire-and-forget spawn in the `launch` tool, an `ensureNarrator` reject,
// or a transport hiccup. These two handlers convert every such event
// into a logged line and KEEP THE PROCESS ALIVE. This is the single most
// important fix: the tool surface can never silently vanish again.
process.on('uncaughtException', (err, origin) => {
  try {
    console.error(`[brainbow-mcp] uncaughtException (${origin}) — staying alive:`, err?.stack || err);
  } catch { /* logging must never itself crash us */ }
});
process.on('unhandledRejection', (reason) => {
  try {
    console.error('[brainbow-mcp] unhandledRejection — staying alive:', reason?.stack || reason);
  } catch { /* ignore */ }
});

const BRAINBOW_URL = process.env.BRAINBOW_URL || `http://localhost:${process.env.BRAINBOW_PORT || '4444'}`;
const BRAINBOW_PORT = process.env.BRAINBOW_PORT || '4444';
const BRAINBOW_TOKEN = process.env.BRAINBOW_TOKEN || process.env.GHOST_SECRET || '';
const AUTOSTART_VISION = process.env.BRAINBOW_VISION_AUTOSTART === 'true';
const DEFAULT_SESSION_ID = process.env.BRAINBOW_SESSION || 'default';
// Resolve the repo root so we can (re)spawn the shared REST server.js if it
// ever dies under us — without this, a REST crash makes EVERY tool fail with
// ECONNREFUSED until the user manually restarts something.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(__filename)); // src/ -> repo root
const SERVER_JS = join(REPO_ROOT, 'server.js');

const visionStarted = new Set();   // sessions where we've already kicked off narrator

// Connection-level errors that mean "the shared REST server isn't answering"
// (as opposed to a 4xx/5xx it answered with). On these we try to revive it.
function isConnError(err) {
  const code = err?.cause?.code || err?.code;
  const msg = String(err?.message || err);
  return (
    code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ENOTFOUND' ||
    code === 'UND_ERR_SOCKET' || code === 'UND_ERR_CONNECT_TIMEOUT' ||
    /fetch failed|ECONNREFUSED|socket hang up|other side closed/i.test(msg)
  );
}

let restReviveInFlight = null;
// Spawn the shared REST server (idempotent-ish) and wait briefly for it to
// answer /api/whoami. Best-effort: never throws, returns true if it came up.
async function reviveRest() {
  if (restReviveInFlight) return restReviveInFlight;
  restReviveInFlight = (async () => {
    try {
      const { spawn } = await import('node:child_process');
      console.error('[brainbow-mcp] shared REST unreachable — attempting respawn of server.js');
      const child = spawn(process.execPath, [SERVER_JS], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, BRAINBOW_PORT },
      });
      child.on('error', () => {}); // async ENOENT etc — swallow, never crash us
      child.unref();
    } catch (e) {
      console.error('[brainbow-mcp] reviveRest spawn failed (continuing):', e?.message || e);
    }
    // Poll up to ~10s for the REST to bind.
    for (let i = 0; i < 20; i++) {
      try {
        const r = await fetch(`${BRAINBOW_URL}/api/whoami`, { signal: AbortSignal.timeout(1000) });
        if (r.ok) { console.error('[brainbow-mcp] shared REST is back up'); return true; }
      } catch { /* not up yet */ }
      await new Promise(r => setTimeout(r, 500));
    }
    console.error('[brainbow-mcp] shared REST did not come back within 10s');
    return false;
  })();
  try { return await restReviveInFlight; }
  finally { restReviveInFlight = null; }
}

async function brainbowRaw(method, path, body) {
  const url = `${BRAINBOW_URL}${path}`;
  const headers = { 'content-type': 'application/json' };
  if (BRAINBOW_TOKEN) headers.authorization = `Bearer ${BRAINBOW_TOKEN}`;
  const init = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  if (!res.ok) {
    const msg = parsed?.error || text || `HTTP ${res.status}`;
    const err = new Error(`brainbow ${method} ${path} -> ${res.status}: ${msg}`);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

// Wrapper that auto-revives the shared REST server on a connection error and
// retries ONCE. A transient REST restart therefore self-heals instead of
// surfacing ECONNREFUSED to the model on every subsequent tool call.
async function brainbow(method, path, body) {
  try {
    return await brainbowRaw(method, path, body);
  } catch (err) {
    if (!isConnError(err)) throw err;
    const back = await reviveRest();
    if (!back) throw err;
    return await brainbowRaw(method, path, body);
  }
}

function sessionOf(args) {
  return args?.sessionId || DEFAULT_SESSION_ID;
}

async function ensureNarrator(sessionId) {
  if (!AUTOSTART_VISION || visionStarted.has(sessionId)) return;
  try {
    await brainbow('POST', `/api/vision/live/start?sessionId=${encodeURIComponent(sessionId)}`);
    visionStarted.add(sessionId);
  } catch {
    // Bedrock creds might be missing — that's fine, narrator is opportunistic
  }
}

function textBlock(s) {
  return { type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) };
}

function imageBlock(b64, mime = 'image/jpeg') {
  return { type: 'image', data: b64, mimeType: mime };
}

const TOOLS = [
  {
    name: 'screen',
    description: 'Capture the CURRENT browser frame as an image plus structural DOM counts (tool cards, iframes, thinking blocks, etc) and the latest narration line. Use this whenever you need to SEE what is on the page right now. Returns an image you can look at.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Brainbow session id (defaults to "default")' },
        dom: { type: 'boolean', description: 'Include DOM counts (default true)', default: true },
      },
    },
  },
  {
    name: 'live',
    description: 'KEYSTONE TOOL — single-call multi-source live observation. Returns: (1) most-recent browser frame as image, (2) Bedrock-Sonnet narration entries since the last call, (3) DOM structural snapshot, (4) page console messages since last call, (5) external log tail lines since last call (kubectl logs etc, if subscribed). Pass cursor=<ms> to get only deltas; the response includes the new cursor to use next time. Call this every 2-5s while you are watching the user work.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        cursor: { type: 'number', description: 'Timestamp from previous live response. Omit on first call to get everything.' },
        image: { type: 'boolean', description: 'Include image bytes (default true). Set false to save tokens when you only want deltas.', default: true },
        dom: { type: 'boolean', description: 'Include DOM counts (default true)', default: true },
      },
    },
  },
  {
    name: 'launch',
    description: 'Open a Chromium browser for the session. If a session already has a browser, this closes it first. Use to start a fresh page or change viewport size.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        url: { type: 'string', description: 'Optional initial URL' },
        width: { type: 'number', description: 'Viewport width (default 1920)' },
        height: { type: 'number', description: 'Viewport height (default 1200)' },
      },
    },
  },
  {
    name: 'close',
    description: 'Close the browser for the session. Idempotent.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' } },
    },
  },
  {
    name: 'goto',
    description: 'Navigate the current page to the given URL.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        url: { type: 'string' },
        waitUntil: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle0', 'networkidle2'], description: 'Default domcontentloaded' },
      },
      required: ['url'],
    },
  },
  {
    name: 'click',
    description: 'Click an element. Pass either {selector} or {x, y}. The selector form retries briefly to handle React re-renders. Returns the resulting frame description.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        selector: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' },
      },
    },
  },
  {
    name: 'type',
    description: 'Type text into the page. Optionally focus a selector first.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        text: { type: 'string' },
        selector: { type: 'string', description: 'Optional — focus this element first' },
        delay: { type: 'number', description: 'Per-keystroke delay in ms (default 0)' },
      },
      required: ['text'],
    },
  },
  {
    name: 'key',
    description: 'Press a single key (Enter, Escape, Tab, ArrowDown, etc).',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        key: { type: 'string' },
      },
      required: ['key'],
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the page by dy pixels (positive=down). Use for revealing below-fold content.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        dy: { type: 'number', default: 400 },
        dx: { type: 'number', default: 0 },
      },
    },
  },
  {
    name: 'wait_for',
    description: 'Wait until a selector / text / url predicate is satisfied. Returns ok:true on success, ok:false on timeout.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        selector: { type: 'string' },
        text: { type: 'string' },
        urlContains: { type: 'string' },
        timeout: { type: 'number', default: 15000 },
      },
    },
  },
  {
    name: 'eval',
    description: 'Run JavaScript in the page context. Return the JSON-serializable result. Use for structural DOM probes when the built-in DOM counts are not enough.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        script: { type: 'string', description: 'JS to run. Will be wrapped in () => (...) so a single expression is fine. For multi-statement, write a function body and return at the end.' },
      },
      required: ['script'],
    },
  },
  {
    name: 'snapshot',
    description: 'Return the accessibility-tree snapshot of the current page (role/name/value/children). Use for selector-free element targeting.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' } },
    },
  },
  {
    name: 'find',
    description: 'Find an element by selector or visible text. Returns the bounding box, outerHTML snippet, and the index in the DOM.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        selector: { type: 'string' },
        text: { type: 'string', description: 'Visible text to match (exact-ish)' },
      },
    },
  },
  {
    name: 'console',
    description: 'Return the most recent page console log messages (browser-side console.log/warn/error + pageerror).',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        limit: { type: 'number', default: 50 },
      },
    },
  },
  {
    name: 'sessions',
    description: 'List the brainbow sessions currently active on the server.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'narrate_start',
    description: 'Start continuous Bedrock Sonnet 4.6 vision narration on the session. The model watches the frame stream and accumulates a narration log you can fetch via `live`.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' } },
    },
  },
  {
    name: 'narrate_stop',
    description: 'Stop Bedrock vision narration.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' } },
    },
  },
  {
    name: 'log_subscribe',
    description: 'Start tailing an external command (kubectl logs -f, docker logs -f, tail -F, etc) and accumulate its output in the brainbow session. Subsequent `live` calls return the new lines. Requires BRAINBOW_LOG_TAILS_ENABLED=true on the brainbow server.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'A short name for this tail (e.g. "api", "k8s-pod"). Used as the key in `live` responses.' },
        command: { type: 'string', description: 'Shell-tokenized command to spawn. Example: "kubectl logs -f deployment/agenticwork-api -n agentic-dev"' },
      },
      required: ['name', 'command'],
    },
  },
  {
    name: 'log_unsubscribe',
    description: 'Stop a previously-started log tail.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'log_list',
    description: 'List all currently-running log tails.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function callTool(name, args = {}) {
  const sessionId = sessionOf(args);
  const qs = `?sessionId=${encodeURIComponent(sessionId)}`;

  switch (name) {
    case 'screen': {
      await ensureNarrator(sessionId);
      const dom = args.dom !== false;
      const data = await brainbow('GET', `/api/live${qs}&dom=${dom}&image=true`);
      const summary = {
        sessionId: data.sessionId,
        url: data.url,
        title: data.title,
        cursor: data.cursor,
        narration_latest: data.narration?.latestBody || null,
        dom_counts: data.dom?.counts || null,
        is_streaming: data.dom?.isStreaming ?? null,
      };
      const blocks = [textBlock(summary)];
      if (data.image) blocks.push(imageBlock(data.image, data.imageMimeType || 'image/jpeg'));
      if (data.dom?.bodyTextTail) {
        blocks.push(textBlock(`Body text tail (last 2000 chars):\n${data.dom.bodyTextTail}`));
      }
      return blocks;
    }

    case 'live': {
      await ensureNarrator(sessionId);
      const includeImage = args.image !== false;
      const dom = args.dom !== false;
      const cursor = args.cursor || 0;
      const path = `/api/live${qs}&cursor=${cursor}&image=${includeImage}&dom=${dom}`;
      const data = await brainbow('GET', path);
      const summary = {
        sessionId: data.sessionId,
        cursor: data.cursor,
        url: data.url,
        title: data.title,
        narration: {
          watching: data.narration?.watching,
          model: data.narration?.model,
          lastError: data.narration?.lastError,
          deltaCount: data.narrationDelta?.length || 0,
        },
        dom: data.dom ? {
          counts: data.dom.counts,
          isStreaming: data.dom.isStreaming,
        } : null,
        consoleDeltaCount: data.consoleDelta?.length || 0,
        actionDeltaCount: data.actionDelta?.length || 0,
        logTailsEnabled: data.logTailsEnabled,
        logTailNames: Object.keys(data.logsDelta || {}),
      };
      const blocks = [textBlock(summary)];

      if (data.narrationDelta?.length) {
        const lines = data.narrationDelta.map(e => {
          const t = new Date(e.ts).toISOString().slice(11, 19);
          return e.body ? `[${t}] ${e.body}` : `[${t}] (error: ${e.error})`;
        }).join('\n');
        blocks.push(textBlock(`NARRATION DELTA (${data.narrationDelta.length} entries):\n${lines}`));
      }

      if (data.image) blocks.push(imageBlock(data.image, data.imageMimeType || 'image/jpeg'));

      if (data.dom?.bodyTextTail) {
        blocks.push(textBlock(`Body text tail (last 2000 chars):\n${data.dom.bodyTextTail}`));
      }

      if (data.consoleDelta?.length) {
        const lines = data.consoleDelta.map(c => `[${c.type}] ${c.text}`).join('\n');
        blocks.push(textBlock(`CONSOLE DELTA (${data.consoleDelta.length}):\n${lines}`));
      }

      const logEntries = Object.entries(data.logsDelta || {});
      for (const [tailName, lines] of logEntries) {
        if (!lines?.length) continue;
        const fmt = lines.map(l => {
          const t = new Date(l.ts).toISOString().slice(11, 19);
          return `[${t}][${l.stream}] ${l.line}`;
        }).join('\n');
        blocks.push(textBlock(`LOG TAIL '${tailName}' (${lines.length} new lines):\n${fmt}`));
      }

      return blocks;
    }

    case 'launch': {
      const body = {};
      if (args.url) body.url = args.url;
      if (args.width) body.width = args.width;
      if (args.height) body.height = args.height;
      const data = await brainbow('POST', `/api/launch${qs}`, body);
      // Auto-pop viewer window for this session — matches Playwright MCP UX
      // (it pops a Chromium when invoked). Honors BRAINBOW_AUTOOPEN_VIEWER=false
      // to disable.
      if (process.env.BRAINBOW_AUTOOPEN_VIEWER !== 'false') {
        const baseUrl = process.env.BRAINBOW_URL || `http://localhost:${process.env.BRAINBOW_PORT || 4444}`;
        // Fall through to per-Claude default sessionId (BRAINBOW_SESSION env)
        // set by bin/brainbow-mcp so each Claude pops its OWN viewer tab.
        const sessionId = args.sessionId || DEFAULT_SESSION_ID;
        const viewerUrl = `${baseUrl}/?sessionId=${encodeURIComponent(sessionId)}`;
        const { spawn } = await import('node:child_process');
        const tryOpen = (cmd, cmdArgs) => {
          try {
            const c = spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore' });
            // A spawned child emits 'error' ASYNCHRONOUSLY (ENOENT etc) AFTER
            // spawn() returns. With no listener that surfaces as an uncaught
            // exception on the process. Swallow it — viewer-open is best-effort.
            c.on('error', () => {});
            c.unref();
            return true;
          } catch { return false; }
        };
        // Try in order: wslview, cmd.exe (WSL), xdg-open, open
        const opened =
          tryOpen('wslview', [viewerUrl]) ||
          tryOpen('cmd.exe', ['/c', 'start', '', viewerUrl]) ||
          (process.env.DISPLAY && tryOpen('xdg-open', [viewerUrl])) ||
          tryOpen('open', [viewerUrl]);
        if (opened) console.error(`[brainbow-mcp] popped viewer at ${viewerUrl}`);
      }
      return [textBlock(data)];
    }

    case 'close':
      return [textBlock(await brainbow('POST', `/api/close${qs}`))];

    case 'goto': {
      const data = await brainbow('POST', `/api/goto${qs}`, {
        url: args.url,
        waitUntil: args.waitUntil,
      });
      return [textBlock(data)];
    }

    case 'click': {
      const body = {};
      if (args.selector) body.selector = args.selector;
      if (typeof args.x === 'number') body.x = args.x;
      if (typeof args.y === 'number') body.y = args.y;
      if (args.button) body.button = args.button;
      return [textBlock(await brainbow('POST', `/api/click${qs}`, body))];
    }

    case 'type': {
      const body = { text: args.text };
      if (args.selector) body.selector = args.selector;
      if (args.delay) body.delay = args.delay;
      return [textBlock(await brainbow('POST', `/api/type${qs}`, body))];
    }

    case 'key':
      return [textBlock(await brainbow('POST', `/api/key${qs}`, { key: args.key }))];

    case 'scroll':
      return [textBlock(await brainbow('POST', `/api/scroll${qs}`, {
        dy: args.dy ?? 400,
        dx: args.dx ?? 0,
      }))];

    case 'wait_for': {
      const body = {};
      if (args.selector) body.selector = args.selector;
      if (args.text) body.text = args.text;
      if (args.urlContains) body.urlContains = args.urlContains;
      if (args.timeout) body.timeout = args.timeout;
      return [textBlock(await brainbow('POST', `/api/wait-for${qs}`, body))];
    }

    case 'eval':
      return [textBlock(await brainbow('POST', `/api/eval${qs}`, { script: args.script }))];

    case 'snapshot':
      return [textBlock(await brainbow('POST', `/api/snapshot${qs}`, {}))];

    case 'find': {
      const body = {};
      if (args.selector) body.selector = args.selector;
      if (args.text) body.text = args.text;
      return [textBlock(await brainbow('POST', `/api/find${qs}`, body))];
    }

    case 'console': {
      const data = await brainbow('GET', `/api/console${qs}`);
      const limit = args.limit || 50;
      const messages = Array.isArray(data?.messages) ? data.messages.slice(-limit) : data;
      return [textBlock(messages)];
    }

    case 'sessions':
      return [textBlock(await brainbow('GET', '/api/sessions'))];

    case 'narrate_start':
      return [textBlock(await brainbow('POST', `/api/vision/live/start${qs}`))];

    case 'narrate_stop':
      return [textBlock(await brainbow('POST', `/api/vision/live/stop${qs}`))];

    case 'log_subscribe':
      return [textBlock(await brainbow('POST', '/api/log/subscribe', {
        name: args.name,
        command: args.command,
      }))];

    case 'log_unsubscribe':
      return [textBlock(await brainbow('POST', '/api/log/unsubscribe', { name: args.name }))];

    case 'log_list':
      return [textBlock(await brainbow('GET', '/api/log/list'))];

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

async function main() {
  const server = new Server(
    {
      name: 'brainbow',
      version: '0.7.1',
    },
    {
      capabilities: { tools: {} },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      const content = await callTool(name, args || {});
      return { content };
    } catch (e) {
      return {
        isError: true,
        content: [textBlock(`brainbow MCP error in tool '${name}': ${e.message}${e.body ? `\n${JSON.stringify(e.body, null, 2)}` : ''}`)],
      };
    }
  });

  const transport = new StdioServerTransport();

  // Transport-level resilience. If the underlying stdio stream emits an
  // error (broken pipe, partial frame), log it but DO NOT let it bubble
  // to an uncaughtException. onerror is the SDK's hook for this.
  transport.onerror = (err) => {
    console.error('[brainbow-mcp] transport error (continuing):', err?.stack || err);
  };
  // onclose fires when the host actually disconnects stdin (the Claude
  // session ended or did a /mcp reconnect). That's a legitimate exit —
  // a fresh shim is spawned on reconnect. Exit 0 (clean) so the host
  // does not treat it as a crash and back off. Guarded by a stdin-EOF
  // confirmation below so a spurious onclose can't kill a live session.
  transport.onclose = () => {
    console.error('[brainbow-mcp] stdio transport closed by host — exiting cleanly for reconnect');
    process.exit(0);
  };

  await server.connect(transport);

  // ─── KEEPALIVE HEARTBEAT ──────────────────────────────────────────────
  // Two jobs:
  //  (1) Hold a ref'd timer on the event loop so the process can NEVER exit
  //      just because the loop momentarily drained (defence-in-depth against
  //      any future code path that lets stdin go quiet without a real EOF).
  //  (2) Opportunistically keep the shared REST warm: if it has died, revive
  //      it in the background so the NEXT tool call already has a server to
  //      talk to instead of eating a cold ECONNREFUSED.
  // The timer is intentionally NOT unref()'d — that's what keeps us alive.
  const HEARTBEAT_MS = Number.parseInt(process.env.BRAINBOW_MCP_HEARTBEAT_MS || '15000', 10);
  setInterval(() => {
    fetch(`${BRAINBOW_URL}/api/whoami`, { signal: AbortSignal.timeout(2000) })
      .then(r => { if (!r.ok) throw new Error(`whoami ${r.status}`); })
      .catch(() => { reviveRest().catch(() => {}); });
  }, HEARTBEAT_MS);

  // ─── EXPLICIT STDIN EOF BACKSTOP ──────────────────────────────────────
  // In some host/WSL configurations the SDK transport's onclose does NOT
  // fire on a real stdin EOF — that left ORPHAN mcp-server.js processes
  // lingering forever (observed: several stale PIDs whose Claude host was
  // long gone). A real EOF on stdin is the authoritative "host is gone"
  // signal: when stdin ends AND we can no longer write to stdout, exit so
  // we don't accumulate zombies. We require BOTH 'end' and a dead stdout to
  // avoid exiting on a transient read pause.
  let stdinEnded = false;
  process.stdin.on('end', () => {
    stdinEnded = true;
    console.error('[brainbow-mcp] stdin EOF — host disconnected, exiting cleanly');
    // Give any in-flight response a tick to flush, then exit.
    setTimeout(() => process.exit(0), 250);
  });
  process.stdin.on('error', (err) => {
    console.error('[brainbow-mcp] stdin error (continuing):', err?.message || err);
  });
  process.stdout.on('error', (err) => {
    // EPIPE = the host closed our stdout. Combined with stdin end this is a
    // definite disconnect; alone it may be transient backpressure. Only exit
    // if stdin has also ended.
    console.error('[brainbow-mcp] stdout error:', err?.message || err);
    if (stdinEnded || err?.code === 'EPIPE') {
      setTimeout(() => process.exit(0), 100);
    }
  });

  console.error(`[brainbow-mcp] connected to ${BRAINBOW_URL} (autostart_vision=${AUTOSTART_VISION}, heartbeat=${HEARTBEAT_MS}ms)`);
}

// If the INITIAL connect fails we must exit (there is nothing to serve and
// the host will respawn us). But anything AFTER a successful connect is
// handled by the never-die guards above — we never exit(1) on a runtime
// throw, only on a failed bootstrap.
main().catch((e) => {
  console.error('[brainbow-mcp] fatal during startup:', e?.stack || e);
  process.exit(1);
});
