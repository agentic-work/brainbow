// SPDX-License-Identifier: MIT
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { findChrome } from '../../src/session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 15001;
const FIXTURE = 'file://' + path.join(__dirname, '..', 'fixtures', 'hello.html');

// Trip-wire needs a real Chromium — skip when unavailable
// (ARC runner pods don't have Chromium installed).
let chromiumAvailable = false;
try { findChrome(); chromiumAvailable = true; } catch { /* no-op */ }

let serverProc;

async function waitFor(url, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Server did not become ready at ${url} within ${timeoutMs}ms`);
}

describe.skipIf(!chromiumAvailable)('I1 trip-wire: frame endpoint always returns an image', () => {
  beforeAll(async () => {
    serverProc = spawn('node', ['server.js'], {
      env: { ...process.env, BRAINBOW_PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitFor(`http://localhost:${PORT}/api/whoami`);
  }, 15000);

  afterAll(async () => {
    if (serverProc) {
      serverProc.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 500));
    }
  });

  it('returns image bytes ≥ 1KB after launch', async () => {
    const launchResp = await fetch(`http://localhost:${PORT}/api/launch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: FIXTURE }),
    });
    expect(launchResp.ok).toBe(true);

    // Give CDP a beat to deliver the first frame.
    await new Promise(r => setTimeout(r, 1500));

    const frameResp = await fetch(`http://localhost:${PORT}/api/frame`);
    expect(frameResp.ok).toBe(true);
    const body = await frameResp.json();
    expect(body.frame).toBeDefined();
    // base64 → bytes: length * 3 / 4 (approx)
    const bytes = Math.floor(body.frame.length * 3 / 4);
    expect(bytes).toBeGreaterThan(1024);
  }, 25000);
});
