// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import { WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 15002;
const FIXTURE = 'file://' + path.join(__dirname, '..', 'fixtures', 'hello.html');

let serverProc;

async function waitFor(url, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(url); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Server did not become ready at ${url}`);
}

describe('I2 trip-wire: WebSocket viewer receives a frame within 100ms of launch', () => {
  beforeAll(async () => {
    serverProc = spawn('node', ['server.js'], {
      env: { ...process.env, BRAINBOW_PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitFor(`http://localhost:${PORT}/api/whoami`);
  }, 15000);

  afterAll(async () => {
    if (serverProc) { serverProc.kill('SIGTERM'); await new Promise(r => setTimeout(r, 500)); }
  });

  it('delivers a frame after launch (within 2500ms of socket open)', async () => {
    // First launch the browser — must happen before the socket subscribes
    // for there to be a screencast to subscribe to.
    await fetch(`http://localhost:${PORT}/api/launch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: FIXTURE }),
    });

    const ws = new WebSocket(`ws://localhost:${PORT}/ws/default`);
    const frameReceived = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('No frame within 2500ms')), 2500);
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'frame' && msg.data) {
          clearTimeout(t);
          resolve(msg.data.length);
        }
      });
      ws.on('error', reject);
    });

    const len = await frameReceived;
    expect(len).toBeGreaterThan(500);
    ws.close();
  }, 20000);
});
