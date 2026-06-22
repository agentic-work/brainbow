// SPDX-License-Identifier: MIT
//
// Regression tests for the eval async+alias fix and the find guard, driven
// THROUGH the MCP callTool against a fake REST echo server (so we assert the
// exact request body the MCP forwards — the real bug was the `code` alias
// arriving EMPTY because only `args.script` was forwarded).
//
// Also pins the two NEW lifecycle/introspection tools on the surface:
//   restart_rest, vision_model.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';

let server;
let baseUrl;
const received = [];   // { method, path, body }

beforeAll(async () => {
  // Tiny echo REST: records every request and replies with a JSON body the
  // MCP layer accepts (200 OK). For /api/live (used by vision_model) we return
  // a narration block.
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = { raw }; }
      received.push({ method: req.method, path: req.url, body });
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/api/live')) {
        res.end(JSON.stringify({
          sessionId: 'default',
          narration: { watching: true, model: 'us.anthropic.claude-opus-4-8', lastError: null },
        }));
      } else if (req.url.startsWith('/api/eval')) {
        // Echo back the script we received as the "result" so the test can see it.
        res.end(JSON.stringify({ ok: true, result: { echoedScript: body?.script ?? null } }));
      } else {
        res.end(JSON.stringify({ ok: true, echoed: body }));
      }
    });
  });
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  baseUrl = `http://localhost:${port}`;
  // The MCP reads BRAINBOW_URL at import time → set it BEFORE importing.
  process.env.BRAINBOW_URL = baseUrl;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

async function importMcp() {
  // Import after BRAINBOW_URL is set so brainbow() points at the echo server.
  return import('../../src/mcp-server.js');
}

describe('eval — async + alias regression (#eval-returns-nothing)', () => {
  it('forwards the `script` param to /api/eval', async () => {
    const mod = await importMcp();
    received.length = 0;
    await mod.callTool('eval', { script: 'return document.title' });
    const evalReq = received.find((r) => r.path.startsWith('/api/eval'));
    expect(evalReq).toBeTruthy();
    expect(evalReq.body.script).toBe('return document.title');
  });

  it('forwards the `code` ALIAS to /api/eval (the actual bug: code arrived empty)', async () => {
    const mod = await importMcp();
    received.length = 0;
    await mod.callTool('eval', { code: '2 + 2' });
    const evalReq = received.find((r) => r.path.startsWith('/api/eval'));
    expect(evalReq).toBeTruthy();
    // Before the fix this was undefined → empty script → page ran nothing.
    expect(evalReq.body.script).toBe('2 + 2');
  });

  it('forwards the `expression` alias to /api/eval', async () => {
    const mod = await importMcp();
    received.length = 0;
    await mod.callTool('eval', { expression: 'window.location.href' });
    const evalReq = received.find((r) => r.path.startsWith('/api/eval'));
    expect(evalReq.body.script).toBe('window.location.href');
  });
});

describe('eval — REST async wrapper accepts top-level await + bare expression', () => {
  // Pin the server-side fix shape (server.js): async IIFE wrapper + bare-expr
  // fallback. Source-regression so we don't need a live Chromium.
  it('server.js wraps eval in an async IIFE and has a bare-expression fallback', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, '..', '..', 'server.js'), 'utf8');
    expect(src).toMatch(/\(async \(\) => \{ \$\{code\} \}\)\(\)/);   // statement body w/ await+return
    expect(src).toMatch(/\(async \(\) => \(\$\{code\}\)\)\(\)/);     // bare-expression fallback
  });
});

describe('find — guard + alias regression', () => {
  it('forwards `text` to /api/find', async () => {
    const mod = await importMcp();
    received.length = 0;
    await mod.callTool('find', { text: 'Submit' });
    const findReq = received.find((r) => r.path.startsWith('/api/find'));
    expect(findReq.body.text).toBe('Submit');
  });

  it('forwards the `query` alias to /api/find', async () => {
    const mod = await importMcp();
    received.length = 0;
    await mod.callTool('find', { query: 'Cancel' });
    const findReq = received.find((r) => r.path.startsWith('/api/find'));
    expect(findReq.body.text).toBe('Cancel');
  });

  it('the find tool schema documents both selector and text/query (guard)', async () => {
    const mod = await importMcp();
    const find = mod.TOOLS.find((t) => t.name === 'find');
    expect(find.inputSchema.properties.selector).toBeTruthy();
    expect(find.inputSchema.properties.text).toBeTruthy();
    expect(find.inputSchema.properties.query).toBeTruthy();
  });
});

describe('new MCP tools — restart_rest + vision_model', () => {
  it('restart_rest and vision_model are registered with sane schemas', async () => {
    const mod = await importMcp();
    for (const name of ['restart_rest', 'vision_model']) {
      const t = mod.TOOLS.find((x) => x.name === name);
      expect(t, `tool ${name} missing`).toBeTruthy();
      expect(t.inputSchema?.type).toBe('object');
      expect(t.description.length).toBeGreaterThan(20);
    }
  });

  it('vision_model reports the live narrator provider/model + the Claude-Code decision', async () => {
    const mod = await importMcp();
    received.length = 0;
    const blocks = await mod.callTool('vision_model', {});
    const text = blocks.map((b) => b.text).join('\n');
    const payload = JSON.parse(blocks[0].text);
    expect(payload).toHaveProperty('active');
    expect(payload).toHaveProperty('claudeCodeDecision');
    // It pulled /api/live for the live narration model.
    expect(received.some((r) => r.path.startsWith('/api/live'))).toBe(true);
    expect(text).toMatch(/claudeCodeDecision/);
  });
});
