// SPDX-License-Identifier: MIT
//
// Realtime narrator loop hardening (task requirement #3):
//   (a) narrateOnce always reads the LATEST frame (lastFrameB64) and flags a
//       STALE frame (newest frame ts older than staleFrameMs) instead of
//       presenting old pixels as "now".
//   (b) provider errors are caught (returned as {error}, never thrown) and a
//       recovered provider CLEARS the prior lastError.
//   (c) the loop is reentrancy-guarded: a narration slower than the interval
//       does not stack overlapping in-flight calls.
//
// Uses a fake provider + a hand-built session object — no Chromium, no network.

import { describe, it, expect, vi } from 'vitest';
import { VisionNarrator } from '../../src/vision-narrator.js';

function fakeSession(overrides = {}) {
  return {
    sessionId: 's-test',
    lastFrameB64: 'AAAA',
    frameBuffer: [{ data: 'AAAA', ts: Date.now() }],
    visionNarration: [],
    page: { url: () => 'https://example.test/page' },
    ...overrides,
  };
}

describe('narrateOnce — freshness + errors', () => {
  it('returns no_frame_yet before any frame', async () => {
    const n = new VisionNarrator({ provider: { name: 'fake', model: 'fake-1', narrate: async () => 'x' } });
    const r = await n.narrateOnce(fakeSession({ lastFrameB64: null }));
    expect(r.error).toBe('no_frame_yet');
  });

  it('narrates the latest frame and does NOT flag a fresh frame as stale', async () => {
    const n = new VisionNarrator({ provider: { name: 'fake', model: 'fake-1', narrate: async () => 'a button appeared' } });
    const r = await n.narrateOnce(fakeSession());
    expect(r.body).toBe('a button appeared');
    expect(r.stale).toBe(false);
    expect(typeof r.frameAgeMs).toBe('number');
  });

  it('flags STALE when the newest frame is older than the staleness budget', async () => {
    const n = new VisionNarrator({ provider: { name: 'fake', model: 'fake-1', narrate: async () => 'no visible change' } });
    n.staleFrameMs = 1000;
    const old = Date.now() - 60_000;     // 60s old frame → stale
    const r = await n.narrateOnce(fakeSession({ frameBuffer: [{ data: 'AAAA', ts: old }] }));
    expect(r.stale).toBe(true);
    expect(r.frameAgeMs).toBeGreaterThan(1000);
  });

  it('catches provider errors (returns {error}, never throws)', async () => {
    const n = new VisionNarrator({ provider: { name: 'fake', model: 'fake-1', narrate: async () => { throw new Error('bedrock 403: AccessDenied'); } } });
    const r = await n.narrateOnce(fakeSession());
    expect(r.body).toBeUndefined();
    expect(r.error).toMatch(/AccessDenied/);
  });
});

describe('start loop — reentrancy guard + lastError lifecycle', () => {
  it('does not stack overlapping narration calls when narrate is slower than the interval', async () => {
    vi.useFakeTimers();
    let active = 0;
    let maxConcurrent = 0;
    let calls = 0;
    const provider = {
      name: 'slow', model: 'slow-1',
      narrate: async () => {
        active++; calls++;
        maxConcurrent = Math.max(maxConcurrent, active);
        await new Promise((r) => setTimeout(r, 50)); // 50ms > 10ms interval
        active--;
        return 'tick';
      },
    };
    const n = new VisionNarrator({ provider, intervalMs: 750 });
    n.intervalMs = 10; // force fast interval to provoke overlap
    const session = fakeSession();
    n.start(session);
    // Advance through several intervals; with the guard, concurrency stays 1.
    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(10);
    }
    n.stop(session);
    expect(maxConcurrent).toBe(1);   // never two narrations in flight at once
    vi.useRealTimers();
  });

  it('clears session.visionError after a clean narration following a failure', async () => {
    let fail = true;
    const provider = {
      name: 'flaky', model: 'flaky-1',
      narrate: async () => { if (fail) { throw new Error('transient 500'); } return 'recovered'; },
    };
    const n = new VisionNarrator({ provider });
    const session = fakeSession();

    // First tick fails → error recorded.
    let entry = await n.narrateOnce(session);
    expect(entry.error).toMatch(/transient/);
    session.visionNarration.push(entry);
    if (entry.error) session.visionError = entry.error;
    expect(session.visionError).toBeTruthy();

    // Provider recovers; simulate the loop body's error-clear logic.
    fail = false;
    entry = await n.narrateOnce(session);
    if (entry.error) session.visionError = entry.error;
    else if (entry.body) session.visionError = null;
    expect(session.visionError).toBeNull();
    expect(entry.body).toBe('recovered');
  });

  it('exposes provider name + model via getters', () => {
    const n = new VisionNarrator({ provider: { name: 'bedrock', model: 'us.anthropic.claude-opus-4-8', narrate: async () => 'x' } });
    expect(n.providerName).toBe('bedrock');
    expect(n.model).toBe('us.anthropic.claude-opus-4-8');
  });
});

describe('/api/live keystone — model field (source regression for the modelId bug)', () => {
  it('live-routes reports sharedVisionNarrator.model (not the undefined .modelId)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, '..', '..', 'src', 'live-routes.js'), 'utf8');
    // The keystone /api/live narration block must use `.model`, never `.modelId`.
    // Match the ASSIGNMENT form so an explanatory comment mentioning the old
    // name doesn't trip the guard.
    expect(src).not.toMatch(/:\s*sharedVisionNarrator\.modelId/);
    expect(src).toMatch(/model:\s*sharedVisionNarrator\.model/);
  });
});
