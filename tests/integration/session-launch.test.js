// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from 'vitest';
import { Session, findChrome } from '../../src/session.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = 'file://' + path.join(__dirname, '..', 'fixtures', 'hello.html');

// Skip the whole suite if Chromium isn't available on this machine.
let chromiumAvailable = false;
try {
  findChrome();
  chromiumAvailable = true;
} catch { /* no chromium — integration suite skipped */ }

describe.skipIf(!chromiumAvailable)('Session.launch (integration)', () => {
  let session;

  afterEach(async () => {
    if (session) await session.close();
  });

  it('launches Chromium against a file:// URL and produces a frame', async () => {
    session = new Session('integration-1');
    await session.launch({ url: FIXTURE });
    expect(session.browser).not.toBe(null);
    expect(session.page).not.toBe(null);
    expect(session.page.url()).toContain('hello.html');

    // Wait briefly for screencast to deliver a frame.
    await new Promise(r => setTimeout(r, 1500));
    expect(session.lastFrameB64).not.toBe(null);
    expect(session.lastFrameB64.length).toBeGreaterThan(500);
  }, 20000);

  it('close() releases the browser', async () => {
    session = new Session('integration-close');
    await session.launch({ url: FIXTURE });
    await session.close();
    expect(session.browser).toBe(null);
  }, 20000);
});
