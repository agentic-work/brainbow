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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { createRestLifecycle } from './rest-lifecycle.js';
import { selectVisionModel } from './vision-model-select.js';
const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(__filename)); // src/ -> repo root
const SERVER_JS = join(REPO_ROOT, 'server.js');

const visionStarted = new Set();   // sessions where we've already kicked off narrator

// ─── CLAUDE-CODE OPUS-4.8 VISION DEFAULT ───────────────────────────────────
// When launched from a Claude Code session and the operator hasn't pinned a
// vision model, default the vision narrator to Opus 4.8 via the best creds
// path (anthropic key → bedrock → honest local fallback + warning). The shim
// (bin/brainbow-mcp) marks its OWN provider default with this sentinel so we
// can tell "user asked for bedrock" apart from "launcher auto-defaulted".
const AUTO_PROVIDER_SENTINEL = process.env.BRAINBOW_VISION_PROVIDER_AUTO || '';
const visionDecision = selectVisionModel(process.env, {
  autoProviderSentinel: AUTO_PROVIDER_SENTINEL,
});
if (visionDecision.provider && visionDecision.model && !visionDecision.explicit) {
  // Apply the decision into the env the REST child inherits (it reads
  // BRAINBOW_VISION_PROVIDER/MODEL on boot). Only when not explicitly pinned.
  process.env.BRAINBOW_VISION_PROVIDER = visionDecision.provider;
  process.env.BRAINBOW_VISION_MODEL = visionDecision.model;
}
if (visionDecision.warn) console.error(visionDecision.warn);
console.error(
  `[brainbow-mcp] vision: provider=${process.env.BRAINBOW_VISION_PROVIDER || '(default)'} ` +
  `model=${process.env.BRAINBOW_VISION_MODEL || '(provider-default)'} ` +
  `source=${visionDecision.source}`
);

// ─── MANAGED REST LIFECYCLE ────────────────────────────────────────────────
// Owns the shared REST as a NON-detached child of THIS MCP process so it
// starts WITH us and stops WITH us (refcount-guarded for the N-session case).
const restLifecycle = createRestLifecycle({
  serverJs: SERVER_JS,
  port: BRAINBOW_PORT,
  baseUrl: BRAINBOW_URL,
});
// 'false' → adopt-only (never spawn); default true → adopt-or-spawn managed.
const REST_AUTOSTART = process.env.BRAINBOW_AUTOSTART_REST !== 'false';
const visionEnvForChild = () => ({
  BRAINBOW_VISION_PROVIDER: process.env.BRAINBOW_VISION_PROVIDER || '',
  BRAINBOW_VISION_MODEL: process.env.BRAINBOW_VISION_MODEL || '',
});
let restStopped = false;
async function stopRest(reason = 'exit') {
  if (restStopped) return;
  restStopped = true;
  try { await restLifecycle.stop(); }
  catch (e) { console.error('[brainbow-mcp] stopRest error:', e?.message || e); }
}

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
// Revive the shared REST through the MANAGED lifecycle (adopt-or-spawn,
// NON-detached, owned by this MCP). Replaces the old detached `spawn(...,
// {detached:true}) + unref()` orphan — a revived REST is now ALSO a managed
// child that dies with us. Best-effort: never throws, returns true if up.
async function reviveRest() {
  if (restReviveInFlight) return restReviveInFlight;
  restReviveInFlight = (async () => {
    try {
      // If we ASKED to stop (teardown), don't resurrect.
      if (restStopped) return await restLifecycle.restUp();
      console.error('[brainbow-mcp] shared REST unreachable — managed (re)start of server.js');
      const r = await restLifecycle.start({ visionEnv: visionEnvForChild(), autostart: REST_AUTOSTART });
      if (r.ok) { console.error('[brainbow-mcp] shared REST is back up'); return true; }
      console.error('[brainbow-mcp] shared REST did not come back');
      return false;
    } catch (e) {
      console.error('[brainbow-mcp] reviveRest failed (continuing):', e?.message || e);
      return false;
    }
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
    description: 'Run JavaScript in the page context and return the JSON-serializable result (always under `result`; null if the script returns nothing). The script runs inside an ASYNC function, so you can use top-level `await` (fetch, waits, async DOM probes) and end with `return <value>`. A single bare expression (e.g. `document.title`) also works. Use for structural DOM probes / page-side fetches when the built-in DOM counts are not enough.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        script: { type: 'string', description: 'JS to run in an async function. Use `await` freely; `return <value>` at the end, or pass a single expression. The returned value is JSON-serialized back to you. (Alias: `code`.)' },
        code: { type: 'string', description: 'Alias for `script`.' },
      },
      required: [],
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
    description: 'Find an element by CSS selector or visible text. Returns the bounding box, text snippet, and tag. You must pass `selector` OR `text` (alias `query`) — passing neither returns a clear 400 instead of crashing.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        selector: { type: 'string', description: 'CSS selector to match' },
        text: { type: 'string', description: 'Visible text to match (substring). Alias: `query`.' },
        query: { type: 'string', description: 'Alias for `text` — visible text to match.' },
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
  {
    name: 'open_viewer',
    description: 'Open the brainbow live viewer for this session in the user\'s default browser. The viewer no longer auto-opens on startup — call this when you (or the human) want the live window. Returns the viewer URL and which opener launched it.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' } },
    },
  },
  // ── Recording (AI-directed video clips) ──────────────────────────────────
  // The REST record→encode pipeline (server.js encodeRecording: jpeg frame
  // buffer → ffmpeg → mp4/webm/gif, fps derived from frame timestamps) already
  // exists; these MCP tools make it drivable. Flow: record_start → drive the
  // page (goto/click/type/scroll) → record_stop{format:'mp4'} returns the saved
  // file PATH the agent can Read/cite. The recorded frames are the RAW CDP
  // screencast (chrome-free), not the viewer window.
  {
    name: 'record_start',
    description: 'Begin recording the live browser frame stream for this session into an in-memory buffer. Drive the page normally (goto/click/type/scroll) while recording, then call record_stop to encode an mp4. Optional `zoom` crops every frame to a rect (use for a tight action shot on one card/region). Errors if already recording.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Brainbow session id (defaults to "default")' },
        zoom: {
          type: 'object',
          description: 'Optional crop rect (CSS px in the 1920x1200 viewport) applied to every frame at encode time — a static "zoomed-in" framing on a region. Omit for full viewport. For dynamic zoom/pan use the post-effects tools (Phase 2).',
          properties: {
            x: { type: 'number' }, y: { type: 'number' },
            width: { type: 'number' }, height: { type: 'number' },
          },
        },
      },
    },
  },
  {
    name: 'record_stop',
    description: 'Stop recording and encode the buffered frames into a video file via ffmpeg. Returns the saved file PATH (under the recordings dir), url, format, frameCount, duration, and human size — Read or cite the path. fps is derived from the real frame timestamps. Use format:"mp4" for website/social (H.264, default here), "webm" for web-native, "gif" for a muted loop.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Brainbow session id (defaults to "default")' },
        format: { type: 'string', enum: ['mp4', 'webm', 'gif'], description: 'Output container/codec. Default mp4 (H.264).', default: 'mp4' },
        quality: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Encode quality (CRF). Default high.', default: 'high' },
        speed: { type: 'number', description: 'Playback speed multiplier applied at encode (2 = 2x faster, 0.5 = slow-motion). Default 1.', default: 1 },
        filename: { type: 'string', description: 'Optional output basename (no extension). Auto-named by timestamp if omitted.' },
      },
    },
  },
  {
    name: 'record_status',
    description: 'Report whether a recording is in progress for this session, how many frames are buffered, elapsed ms, the active zoom rect, and whether ffmpeg is available. Use to confirm frames are accumulating before stopping.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string', description: 'Brainbow session id (defaults to "default")' } },
    },
  },
  {
    name: 'recordings_list',
    description: 'List the encoded recordings saved on the brainbow server (filename, size, mtime) and the recordings directory path.',
    inputSchema: { type: 'object', properties: {} },
  },
  // ── REST lifecycle + vision-model introspection ──────────────────────────
  {
    name: 'restart_rest',
    description: 'Restart the shared brainbow REST server (the managed child of this MCP). Use this to pick up new server.js bytes after an update, or to clear a wedged REST. Honors the CURRENT BRAINBOW_VISION_PROVIDER/MODEL env (so a model change applies on restart). Returns {ok, owned, pid}. The REST is owned by this MCP and dies when this Claude session disconnects.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'vision_model',
    description: 'Report the ACTIVE vision narrator provider + model id (and the Claude-Code default decision: whether Opus-4.8 is in use, and an honest warning if creds are missing). Use to confirm WHICH model is narrating the live screen.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } } },
  },
];

// Exported so unit tests can assert the registered tool surface (e.g. that
// `open_viewer` exists) without spinning up the stdio transport. `callTool`
// is exported so tests can drive a tool against a fake REST (echo server) and
// assert the exact request body it forwards (e.g. the eval `code` alias).
export { TOOLS };

export async function callTool(name, args = {}) {
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
      // Bug 2: do NOT auto-pop the viewer on launch by default. The viewer is
      // now opened ON DEMAND via the `open_viewer` tool. Opt back in to the
      // old auto-pop-on-launch behavior with BRAINBOW_AUTOOPEN_VIEWER=true.
      if (process.env.BRAINBOW_AUTOOPEN_VIEWER === 'true') {
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

    case 'eval': {
      // Accept `script`, or the common aliases `code`/`expression` (callers —
      // and the host harness — reach for `code`). Previously only `args.script`
      // was forwarded, so a `code`-named arg arrived EMPTY → the page ran
      // nothing → `{ok:true}` with no result. This was THE eval-returns-nothing bug.
      const evalScript = args.script ?? args.code ?? args.expression;
      return [textBlock(await brainbow('POST', `/api/eval${qs}`, { script: evalScript }))];
    }

    case 'snapshot':
      return [textBlock(await brainbow('POST', `/api/snapshot${qs}`, {}))];

    case 'find': {
      const body = {};
      if (args.selector) body.selector = args.selector;
      // Accept `text`, or the forgiving `query`/`q` aliases.
      const findText = args.text || args.query || args.q;
      if (findText) body.text = findText;
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

    case 'open_viewer':
      return [textBlock(await brainbow('POST', `/api/viewer/open${qs}`, { sessionId }))];

    case 'record_start':
      return [textBlock(await brainbow('POST', `/api/record/start${qs}`, {
        sessionId,
        ...(args.zoom ? { zoom: args.zoom } : {}),
      }))];

    case 'record_stop':
      return [textBlock(await brainbow('POST', `/api/record/stop${qs}`, {
        sessionId,
        format: args.format ?? 'mp4',
        ...(args.quality ? { quality: args.quality } : {}),
        ...(typeof args.speed === 'number' ? { speed: args.speed } : {}),
        ...(args.filename ? { filename: args.filename } : {}),
      }))];

    case 'record_status':
      return [textBlock(await brainbow('GET', `/api/record/status${qs}`))];

    case 'recordings_list':
      return [textBlock(await brainbow('GET', '/api/recordings'))];

    case 'restart_rest': {
      // Refresh the managed REST so new server.js bytes / a changed vision
      // model take effect — and re-arm teardown for the new child.
      restStopped = false;
      const r = await restLifecycle.restart({ visionEnv: visionEnvForChild() });
      return [textBlock({
        ok: r.ok,
        owned: r.owned,
        pid: r.pid,
        baseUrl: BRAINBOW_URL,
        vision: {
          provider: process.env.BRAINBOW_VISION_PROVIDER || null,
          model: process.env.BRAINBOW_VISION_MODEL || null,
        },
      })];
    }

    case 'vision_model': {
      // Pull the LIVE narration metadata from the REST (provider/model the
      // running narrator actually bound) and combine it with this MCP's
      // Claude-Code decision so the report is honest about creds.
      let live = null;
      try {
        const data = await brainbow('GET', `/api/live${qs}&image=false&dom=false`);
        live = data?.narration || null;
      } catch { /* REST may be down; fall back to the MCP-side decision */ }
      return [textBlock({
        active: {
          provider: process.env.BRAINBOW_VISION_PROVIDER || null,
          model: process.env.BRAINBOW_VISION_MODEL || null,
        },
        liveNarration: live ? {
          watching: live.watching,
          model: live.model,
          lastError: live.lastError,
        } : null,
        claudeCodeDecision: {
          claudeCode: visionDecision.claudeCode,
          explicit: visionDecision.explicit,
          source: visionDecision.source,
          reason: visionDecision.reason,
          opus48: (process.env.BRAINBOW_VISION_MODEL || '').includes('opus-4-8'),
          warning: visionDecision.warn || null,
        },
      })];
    }

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
    console.error('[brainbow-mcp] stdio transport closed by host — tearing down managed REST, exiting cleanly');
    // Kill the REST WE own (refcount-guarded — left running if other Claude
    // sessions still own it) BEFORE we exit. Bounded so a slow kill can't
    // hang the disconnect: stop() races a hard exit at 2.5s.
    Promise.race([
      stopRest('onclose'),
      new Promise((r) => setTimeout(r, 2500)),
    ]).finally(() => process.exit(0));
  };

  // ─── MANAGED REST: start WITH the MCP ─────────────────────────────────
  // Adopt-or-spawn the shared REST as a NON-detached child of this process,
  // and install teardown traps so it dies WITH us on every exit path. This
  // is the fix for the zombie REST: it now starts/stops exactly like the MCP.
  restLifecycle.installTraps(process);
  try {
    const r = await restLifecycle.start({ visionEnv: visionEnvForChild(), autostart: REST_AUTOSTART });
    console.error(`[brainbow-mcp] managed REST start: ok=${r.ok} owned=${r.owned} adopted=${r.adopted} pid=${r.pid ?? '-'}`);
  } catch (e) {
    console.error('[brainbow-mcp] managed REST start failed (will revive on demand):', e?.message || e);
  }

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
    console.error('[brainbow-mcp] stdin EOF — host disconnected, tearing down managed REST + exiting');
    // Tear down the REST we own (refcount-guarded) then exit. Race a hard
    // exit so a slow kill never strands the process.
    Promise.race([
      stopRest('stdin-eof'),
      new Promise((r) => setTimeout(r, 2500)),
    ]).finally(() => process.exit(0));
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
      Promise.race([
        stopRest('stdout-epipe'),
        new Promise((r) => setTimeout(r, 1500)),
      ]).finally(() => process.exit(0));
    }
  });

  console.error(`[brainbow-mcp] connected to ${BRAINBOW_URL} (autostart_vision=${AUTOSTART_VISION}, heartbeat=${HEARTBEAT_MS}ms)`);
}

// If the INITIAL connect fails we must exit (there is nothing to serve and
// the host will respawn us). But anything AFTER a successful connect is
// handled by the never-die guards above — we never exit(1) on a runtime
// throw, only on a failed bootstrap.
//
// Only auto-start the stdio server when this file is the process entrypoint
// (i.e. `node src/mcp-server.js`). When it is merely IMPORTED — e.g. a unit
// test asserting the TOOLS surface — we must NOT connect a transport or wire
// the stdin-EOF process.exit() backstop, which would tear down the test
// worker. This is the standard ESM "is this the main module?" guard.
const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  main().catch((e) => {
    console.error('[brainbow-mcp] fatal during startup:', e?.stack || e);
    process.exit(1);
  });
}
