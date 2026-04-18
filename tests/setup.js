// SPDX-License-Identifier: MIT
// Per-test setup: allocate a unique port per test file to avoid collisions
// when multiple suites spin up Express in parallel.
import { afterEach } from 'vitest';

let nextPort = 14444;
export function nextTestPort() {
  return nextPort++;
}

afterEach(async () => {
  // Give Chromium a beat to fully release ports between tests.
  await new Promise(r => setTimeout(r, 50));
});
