// SPDX-License-Identifier: MIT
//
// Bug 2 — viewer must NOT auto-open a browser window on WSL/machine start;
// instead it is openable ON DEMAND (agent- or human-controllable).
//
// Three assertions:
//   (a) the new POST /api/viewer/open route handler returns {ok,url,opener}
//       for a known session,
//   (b) the `open_viewer` MCP tool is registered,
//   (c) source-regression: bin/brainbow-mcp defaults BRAINBOW_AUTOOPEN_VIEWER
//       to FALSE so it can't silently flip back to auto-popping.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeViewerOpenHandler } from '../../src/viewer-open.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

describe('Bug 2 — viewer on demand, not auto-open', () => {
  it('(a) POST /api/viewer/open returns {ok,url,opener} for a known session', async () => {
    // Inject a fake opener so the test never actually spawns wslview/cmd.exe.
    const opened = [];
    const fakeOpener = (url) => { opened.push(url); return 'fake-opener'; };
    const handler = makeViewerOpenHandler({
      port: 4444,
      openInBrowser: fakeOpener,
    });

    const req = { body: { sessionId: 'claude-123-abcde' } };
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.url).toBe('http://localhost:4444/?sessionId=claude-123-abcde');
    expect(res.body.opener).toBe('fake-opener');
    expect(opened).toEqual(['http://localhost:4444/?sessionId=claude-123-abcde']);
  });

  it('(a2) defaults to the "default" session when none provided', async () => {
    const handler = makeViewerOpenHandler({
      port: 4444,
      openInBrowser: () => 'wslview',
      defaultSessionId: () => 'default',
    });
    const req = { body: {} };
    const res = makeRes();
    await handler(req, res);
    expect(res.body.ok).toBe(true);
    expect(res.body.url).toContain('sessionId=default');
  });

  it('(a3) reports ok:false when no opener is available', async () => {
    const handler = makeViewerOpenHandler({
      port: 4444,
      openInBrowser: () => null,   // no wslview/cmd.exe/xdg-open/open found
    });
    const req = { body: { sessionId: 's1' } };
    const res = makeRes();
    await handler(req, res);
    expect(res.body.ok).toBe(false);
    expect(res.body.opener).toBe(null);
    // still returns the URL so a human can open it manually
    expect(res.body.url).toContain('sessionId=s1');
  });

  it('(b) the open_viewer MCP tool is registered with a sane schema', async () => {
    const mod = await import('../../src/mcp-server.js');
    expect(Array.isArray(mod.TOOLS)).toBe(true);
    const tool = mod.TOOLS.find(t => t.name === 'open_viewer');
    expect(tool).toBeTruthy();
    expect(tool.description).toMatch(/viewer/i);
    expect(tool.inputSchema?.type).toBe('object');
  });

  it('(c) bin/brainbow-mcp defaults BRAINBOW_AUTOOPEN_VIEWER to false (source-regression)', () => {
    const launcher = fs.readFileSync(path.join(REPO_ROOT, 'bin', 'brainbow-mcp'), 'utf8');
    // The default-off contract: ${BRAINBOW_AUTOOPEN_VIEWER:-false}
    expect(launcher).toMatch(/BRAINBOW_AUTOOPEN_VIEWER:-false/);
    // And it must NOT default to true anywhere.
    expect(launcher).not.toMatch(/BRAINBOW_AUTOOPEN_VIEWER:-true/);
  });
});
